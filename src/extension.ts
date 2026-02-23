import * as vscode from 'vscode';
import * as path from 'path';
import { Logger } from './util/logger';
import { readSettings, onSettingsChanged, ExtensionSettings } from './config/settings';
import { JsonlParser } from './parser/jsonlParser';
import { FilePoller } from './poller/filePoller';
import { CopilotSessionReader } from './reader/copilotSessionReader';
import { buildAgentSessionFromVscodeSessions } from './parser/vscodeSessionAdapter';
import { StateStore } from './store/stateStore';
import { AgentTreeProvider } from './views/agentTreeProvider';
import { StatusBarManager } from './views/statusBarManager';
import { AgentContextWebviewPanel } from './views/webviewPanel';
import { AgentSession, flattenAgents } from './model/agentModel';

const MODULE = 'Extension';

let logger: Logger;
let parser: JsonlParser;
let jsonlPoller: FilePoller | undefined;
let copilotReader: CopilotSessionReader | undefined;
let store: StateStore;
let treeProvider: AgentTreeProvider;
let statusBar: StatusBarManager;
let webviewPanel: AgentContextWebviewPanel;
let currentSettings: ExtensionSettings;
let extensionContext: vscode.ExtensionContext;
const criticalNotifiedAgents = new Set<string>();

function getChatSessionsDir(): string | undefined {
  const storageUri = extensionContext.storageUri;
  if (!storageUri) { return undefined; }
  return path.join(path.dirname(storageUri.fsPath), 'chatSessions');
}

function startCopilotReader(): void {
  const chatSessionsDir = getChatSessionsDir();
  if (!chatSessionsDir) {
    logger.warn(MODULE, 'storageUri is undefined — cannot use copilot-chat mode. Showing message in tree.');
    treeProvider.refresh(null, 'Cannot determine Copilot Chat session directory. storageUri is undefined.');
    return;
  }

  logger.info(MODULE, `Starting copilot-chat reader at: ${chatSessionsDir}`);
  copilotReader = new CopilotSessionReader(chatSessionsDir, currentSettings.pollIntervalMs, logger);

  copilotReader.onSessionsChanged(sessions => {
    const agentSession = buildAgentSessionFromVscodeSessions(
      sessions,
      currentSettings.activityWindowMinutes * 60_000,
      { warningPercent: currentSettings.warningThresholdPercent, criticalPercent: currentSettings.criticalThresholdPercent },
    );
    store.setState(agentSession);
    if (!agentSession) {
      treeProvider.refresh(null, 'No active Copilot Chat sessions found. Start a chat session to see context usage.');
    }
    if (agentSession && currentSettings.notifyOnCritical) {
      checkCriticalThresholds(agentSession, currentSettings);
    }
  });

  copilotReader.start();
  treeProvider.refresh(null, 'Waiting for Copilot Chat session…');
}

function startJsonlPoller(): void {
  logger.info(MODULE, 'Starting JSONL file poller');
  jsonlPoller = new FilePoller({
    filePath: currentSettings.logFilePath,
    pollIntervalMs: currentSettings.pollIntervalMs,
  }, logger);

  jsonlPoller.onData(chunk => {
    const result = parser.parseChunk(chunk);
    const latest = parser.getLatestSession();
    store.setState(latest);

    if (result.malformedLineCount > 0) {
      logger.debug(MODULE, `Malformed lines so far: ${result.malformedLineCount}`);
    }
  });

  jsonlPoller.onReset(() => {
    parser.reset();
    store.setState(null);
    criticalNotifiedAgents.clear();
    logger.info(MODULE, 'Parser and store reset due to file truncation/rotation');
  });

  jsonlPoller.onMissing(() => {
    if (currentSettings.logFilePath && !store.getState()) {
      treeProvider.refresh(null, `Log file not found: ${currentSettings.logFilePath}`);
    }
  });

  jsonlPoller.start();

  if (!currentSettings.logFilePath) {
    treeProvider.refresh(null, 'No log file configured. Set agentContext.logFilePath in settings.');
  }
}

function stopAllReaders(): void {
  if (copilotReader) {
    copilotReader.dispose();
    copilotReader = undefined;
  }
  if (jsonlPoller) {
    jsonlPoller.dispose();
    jsonlPoller = undefined;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  currentSettings = readSettings();

  logger = new Logger('Agent Context', currentSettings.logLevel);
  logger.info(MODULE, 'Activating Agent Context Display extension');

  parser = new JsonlParser(logger, {
    warningPercent: currentSettings.warningThresholdPercent,
    criticalPercent: currentSettings.criticalThresholdPercent,
  });

  store = new StateStore();
  treeProvider = new AgentTreeProvider();
  statusBar = new StatusBarManager();
  webviewPanel = new AgentContextWebviewPanel();

  statusBar.setVisible(currentSettings.showStatusBar);
  statusBar.setMode(currentSettings.statusBarMode);
  statusBar.setThresholds(currentSettings.warningThresholdPercent, currentSettings.criticalThresholdPercent);
  webviewPanel.setRetainContext(currentSettings.webviewRetainContext);

  const treeView = vscode.window.createTreeView('agentContextTree', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  store.onStateChanged(session => {
    treeProvider.refresh(session);
    statusBar.update(session);
    webviewPanel.update(session);

    if (currentSettings.notifyOnCritical && session) {
      checkCriticalThresholds(session, currentSettings);
    }
  });

  // Start the appropriate data source reader
  if (currentSettings.dataSource === 'copilot-chat') {
    startCopilotReader();
  } else {
    startJsonlPoller();
  }

  const settingsDisposable = onSettingsChanged(newSettings => {
    applySettings(newSettings);
  });

  const showTreeCmd = vscode.commands.registerCommand('agentContext.showTree', () => {
    vscode.commands.executeCommand('agentContextTree.focus');
  });

  const openWebviewCmd = vscode.commands.registerCommand('agentContext.openWebview', () => {
    webviewPanel.show(context.extensionUri);
  });

  const refreshCmd = vscode.commands.registerCommand('agentContext.refresh', () => {
    logger.info(MODULE, 'Manual refresh triggered');
    if (currentSettings.dataSource === 'copilot-chat') {
      // Restart copilot reader to force a fresh poll
      stopAllReaders();
      store.setState(null);
      startCopilotReader();
    } else if (jsonlPoller) {
      jsonlPoller.reconfigure({});
    }
  });

  context.subscriptions.push(
    logger, store, treeProvider, statusBar, webviewPanel,
    treeView, settingsDisposable,
    showTreeCmd, openWebviewCmd, refreshCmd,
    { dispose: () => stopAllReaders() },
  );

  logger.info(MODULE, 'Extension activated successfully');
}

function applySettings(settings: ExtensionSettings): void {
  const previousDataSource = currentSettings.dataSource;
  currentSettings = settings;
  logger.setLevel(settings.logLevel);
  logger.info(MODULE, 'Settings changed, reconfiguring...');

  parser.setThresholds({
    warningPercent: settings.warningThresholdPercent,
    criticalPercent: settings.criticalThresholdPercent,
  });

  statusBar.setVisible(settings.showStatusBar);
  statusBar.setMode(settings.statusBarMode);
  statusBar.setThresholds(settings.warningThresholdPercent, settings.criticalThresholdPercent);
  webviewPanel.setRetainContext(settings.webviewRetainContext);

  // Handle data source switching
  if (previousDataSource !== settings.dataSource) {
    logger.info(MODULE, `Data source changed from ${previousDataSource} to ${settings.dataSource}`);
    stopAllReaders();
    store.setState(null);
    criticalNotifiedAgents.clear();

    if (settings.dataSource === 'copilot-chat') {
      startCopilotReader();
    } else {
      parser.reset();
      startJsonlPoller();
    }
  } else if (settings.dataSource === 'jsonl' && jsonlPoller) {
    jsonlPoller.reconfigure({
      filePath: settings.logFilePath,
      pollIntervalMs: settings.pollIntervalMs,
    });
    const current = store.getState();
    if (current) {
      treeProvider.refresh(current);
      statusBar.update(current);
      webviewPanel.update(current);
    }
  } else if (settings.dataSource === 'copilot-chat' && copilotReader) {
    copilotReader.reconfigure(settings.pollIntervalMs);
    // Rebuild session with updated thresholds / activity window
    const sessions = copilotReader.getSessions();
    const agentSession = buildAgentSessionFromVscodeSessions(
      sessions,
      settings.activityWindowMinutes * 60_000,
      { warningPercent: settings.warningThresholdPercent, criticalPercent: settings.criticalThresholdPercent },
    );
    store.setState(agentSession);
    // Direct refresh to ensure views update even if store deduplicates
    if (agentSession) {
      treeProvider.refresh(agentSession);
      statusBar.update(agentSession);
      webviewPanel.update(agentSession);
    } else if (sessions.size > 0) {
      treeProvider.refresh(null, 'No active Copilot Chat sessions found. Start a chat session to see context usage.');
    }
  }
}

function checkCriticalThresholds(session: AgentSession, settings: ExtensionSettings): void {
  const allAgents = flattenAgents(session.agents);
  for (const agent of allAgents) {
    if (agent.contextUsage.usagePercent >= settings.criticalThresholdPercent) {
      if (!criticalNotifiedAgents.has(agent.agentId)) {
        criticalNotifiedAgents.add(agent.agentId);
        vscode.window.showWarningMessage(
          `Agent "${agent.label}" has reached ${agent.contextUsage.usagePercent.toFixed(0)}% context usage (critical threshold: ${settings.criticalThresholdPercent}%)`,
        );
      }
    } else {
      criticalNotifiedAgents.delete(agent.agentId);
    }
  }
}

export function deactivate(): void {
  // All disposables registered via context.subscriptions are auto-disposed
}

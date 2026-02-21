import * as vscode from 'vscode';
import { Logger } from './util/logger';
import { readSettings, onSettingsChanged, ExtensionSettings } from './config/settings';
import { JsonlParser } from './parser/jsonlParser';
import { FilePoller } from './poller/filePoller';
import { StateStore } from './store/stateStore';
import { AgentTreeProvider } from './views/agentTreeProvider';
import { StatusBarManager } from './views/statusBarManager';
import { AgentContextWebviewPanel } from './views/webviewPanel';
import { AgentSession, flattenAgents } from './model/agentModel';

const MODULE = 'Extension';

let logger: Logger;
let parser: JsonlParser;
let poller: FilePoller;
let store: StateStore;
let treeProvider: AgentTreeProvider;
let statusBar: StatusBarManager;
let webviewPanel: AgentContextWebviewPanel;
let currentSettings: ExtensionSettings;
const criticalNotifiedAgents = new Set<string>();

export function activate(context: vscode.ExtensionContext): void {
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

  poller = new FilePoller({
    filePath: currentSettings.logFilePath,
    pollIntervalMs: currentSettings.pollIntervalMs,
  }, logger);

  poller.onData(chunk => {
    const result = parser.parseChunk(chunk);
    const latest = parser.getLatestSession();
    store.setState(latest);

    if (result.malformedLineCount > 0) {
      logger.debug(MODULE, `Malformed lines so far: ${result.malformedLineCount}`);
    }
  });

  poller.onReset(() => {
    parser.reset();
    store.setState(null);
    criticalNotifiedAgents.clear();
    logger.info(MODULE, 'Parser and store reset due to file truncation/rotation');
  });

  poller.onMissing(() => {
    if (currentSettings.logFilePath && !store.getState()) {
      treeProvider.refresh(null, `Log file not found: ${currentSettings.logFilePath}`);
    }
  });

  poller.start();

  if (!currentSettings.logFilePath) {
    treeProvider.refresh(null, 'No log file configured. Set agentContext.logFilePath in settings.');
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
    poller.reconfigure({});
  });

  context.subscriptions.push(
    logger, store, treeProvider, statusBar, webviewPanel,
    treeView, settingsDisposable,
    showTreeCmd, openWebviewCmd, refreshCmd,
    { dispose: () => poller.dispose() },
  );

  logger.info(MODULE, 'Extension activated successfully');
}

function applySettings(settings: ExtensionSettings): void {
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

  poller.reconfigure({
    filePath: settings.logFilePath,
    pollIntervalMs: settings.pollIntervalMs,
  });

  const current = store.getState();
  if (current) {
    treeProvider.refresh(current);
    statusBar.update(current);
    webviewPanel.update(current);
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

import * as vscode from 'vscode';

export interface ExtensionSettings {
  logFilePath: string;
  dataSource: 'jsonl' | 'copilot-chat';
  pollIntervalMs: number;
  activityWindowMinutes: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  warningThresholdPercent: number;
  criticalThresholdPercent: number;
  notifyOnCritical: boolean;
  showStatusBar: boolean;
  statusBarMode: 'hottestAgent' | 'sessionSummary';
  webviewRetainContext: boolean;
}

const DEFAULTS: ExtensionSettings = {
  logFilePath: '',
  dataSource: 'copilot-chat',
  pollIntervalMs: 2000,
  activityWindowMinutes: 60,
  logLevel: 'info',
  warningThresholdPercent: 70,
  criticalThresholdPercent: 85,
  notifyOnCritical: true,
  showStatusBar: true,
  statusBarMode: 'hottestAgent',
  webviewRetainContext: false,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function readSettings(): ExtensionSettings {
  const cfg = vscode.workspace.getConfiguration('agentContext');

  const pollIntervalMs = clamp(cfg.get<number>('pollIntervalMs', DEFAULTS.pollIntervalMs), 1000, 30000);
  let warningThresholdPercent = cfg.get<number>('warningThresholdPercent', DEFAULTS.warningThresholdPercent);
  let criticalThresholdPercent = cfg.get<number>('criticalThresholdPercent', DEFAULTS.criticalThresholdPercent);

  if (criticalThresholdPercent <= warningThresholdPercent) {
    warningThresholdPercent = DEFAULTS.warningThresholdPercent;
    criticalThresholdPercent = DEFAULTS.criticalThresholdPercent;
  }

  return {
    logFilePath: cfg.get<string>('logFilePath', DEFAULTS.logFilePath),
    dataSource: cfg.get<ExtensionSettings['dataSource']>('dataSource', DEFAULTS.dataSource),
    pollIntervalMs,
    activityWindowMinutes: clamp(cfg.get<number>('activityWindowMinutes', DEFAULTS.activityWindowMinutes), 5, 1440),
    logLevel: cfg.get<ExtensionSettings['logLevel']>('logLevel', DEFAULTS.logLevel),
    warningThresholdPercent,
    criticalThresholdPercent,
    notifyOnCritical: cfg.get<boolean>('notifyOnCritical', DEFAULTS.notifyOnCritical),
    showStatusBar: cfg.get<boolean>('showStatusBar', DEFAULTS.showStatusBar),
    statusBarMode: cfg.get<ExtensionSettings['statusBarMode']>('statusBarMode', DEFAULTS.statusBarMode),
    webviewRetainContext: cfg.get<boolean>('webview.retainContext', DEFAULTS.webviewRetainContext),
  };
}

export function onSettingsChanged(callback: (settings: ExtensionSettings) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('agentContext')) {
      callback(readSettings());
    }
  });
}

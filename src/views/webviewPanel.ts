import * as vscode from 'vscode';
import { Agent, AgentSession } from '../model/agentModel';

export class AgentContextWebviewPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private pendingState: AgentSession | null = null;
  private retainContext: boolean = false;
  private disposables: vscode.Disposable[] = [];

  setRetainContext(retain: boolean): void {
    this.retainContext = retain;
  }

  show(extensionUri: vscode.Uri): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Two);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'agentContextDetail',
      'Agent Context',
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: this.retainContext,
        localResourceRoots: [extensionUri],
      },
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    }, null, this.disposables);

    this.panel.webview.html = this.getHtml(this.pendingState);
  }

  update(session: AgentSession | null): void {
    this.pendingState = session;
    if (this.panel) {
      this.panel.webview.html = this.getHtml(session);
    }
  }

  private getHtml(session: AgentSession | null): string {
    const agents = session ? this.flattenAndSort(session.agents) : [];
    const bars = agents.map(a => this.renderBar(a)).join('\n');
    const summaryHtml = session
      ? `<div class="summary">Session: ${this.esc(session.sessionId)} &middot; Status: ${this.esc(session.status)} &middot; Last update: ${this.esc(session.lastUpdatedAt)}</div>`
      : '<div class="summary">No data available</div>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Context</title>
  <style>
    body { font-family: var(--vscode-font-family, sans-serif); padding: 16px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .banner { background: var(--vscode-editorInfo-foreground, #3794ff); color: #fff; padding: 6px 12px; border-radius: 4px; margin-bottom: 16px; font-size: 12px; }
    .summary { margin-bottom: 16px; font-size: 13px; opacity: 0.8; }
    .agent-bar { margin-bottom: 12px; }
    .agent-label { font-size: 13px; margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center; }
    .agent-role { opacity: 0.6; font-size: 11px; margin-left: 8px; }
    .bar-track { background: var(--vscode-editorWidget-background, #252526); border-radius: 4px; height: 22px; position: relative; overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 4px; transition: width 0.3s ease; display: flex; align-items: center; padding-left: 8px; font-size: 11px; color: #fff; min-width: fit-content; }
    .bar-fill.normal { background: var(--vscode-charts-green, #388a34); }
    .bar-fill.warning { background: var(--vscode-charts-yellow, #c8a600); }
    .bar-fill.critical { background: var(--vscode-charts-red, #d32f2f); }
    .status-badge { font-size: 10px; padding: 1px 6px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .no-data { text-align: center; padding: 40px; opacity: 0.5; }
  </style>
</head>
<body>
  <div class="banner" role="status">Showing latest snapshot. Updates automatically.</div>
  ${summaryHtml}
  ${agents.length === 0 && session ? '<div class="no-data">No agents in this session.</div>' : ''}
  ${!session ? '<div class="no-data">Waiting for agent context data\u2026</div>' : ''}
  <div role="list" aria-label="Agent context usage">
    ${bars}
  </div>
</body>
</html>`;
  }

  private renderBar(agent: Agent): string {
    const pct = agent.contextUsage.usagePercent;
    const used = agent.contextUsage.usedTokens.toLocaleString();
    const max = agent.contextUsage.maxTokens.toLocaleString();
    const width = Math.max(pct, 2);

    return `
    <div class="agent-bar" role="listitem" aria-label="${this.esc(agent.label)}, ${pct.toFixed(1)}% context used">
      <div class="agent-label">
        <span>${this.esc(agent.label)}<span class="agent-role">${this.esc(agent.role)}</span></span>
        <span class="status-badge">${this.esc(agent.status)}</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill ${agent.riskLevel}" style="width: ${width.toFixed(1)}%">
          ${used} / ${max} (${pct.toFixed(0)}%)
        </div>
      </div>
    </div>`;
  }

  private flattenAndSort(agents: Agent[]): Agent[] {
    const result: Agent[] = [];
    const collect = (list: Agent[]) => {
      for (const a of list) {
        result.push(a);
        collect(a.children);
      }
    };
    collect(agents);
    result.sort((a, b) => b.contextUsage.usagePercent - a.contextUsage.usagePercent);
    return result;
  }

  private esc(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) { d.dispose(); }
    this.disposables = [];
  }
}

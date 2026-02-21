import * as vscode from 'vscode';
import { Agent, AgentSession, SessionSummary } from '../model/agentModel';

type TreeItemType = 'session' | 'agent' | 'placeholder';

class AgentTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly itemType: TreeItemType,
    public readonly agent?: Agent,
    public readonly session?: AgentSession,
  ) {
    super(label, collapsibleState);
  }
}

export class AgentTreeProvider implements vscode.TreeDataProvider<AgentTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<AgentTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private session: AgentSession | null = null;
  private errorMessage: string | null = null;

  refresh(session: AgentSession | null, errorMessage?: string): void {
    this.session = session;
    this.errorMessage = errorMessage ?? null;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: AgentTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: AgentTreeItem): AgentTreeItem[] {
    if (!element) {
      return this.getRootChildren();
    }

    if (element.itemType === 'session' && this.session) {
      return this.session.agents.map(agent => this.createAgentItem(agent));
    }

    if (element.itemType === 'agent' && element.agent) {
      return element.agent.children.map(child => this.createAgentItem(child));
    }

    return [];
  }

  private getRootChildren(): AgentTreeItem[] {
    if (this.errorMessage) {
      return [this.createPlaceholder(this.errorMessage, 'error')];
    }

    if (!this.session) {
      return [this.createPlaceholder('Waiting for data\u2026', 'info')];
    }

    const summary = this.session.sessionSummary;
    const label = this.formatSessionLabel(summary);
    const item = new AgentTreeItem(
      label,
      vscode.TreeItemCollapsibleState.Expanded,
      'session',
      undefined,
      this.session,
    );
    item.description = `Session: ${this.session.sessionId}`;
    item.iconPath = this.getSessionIcon(this.session.status);
    item.tooltip = this.formatSessionTooltip(this.session, summary);
    item.contextValue = 'session';
    item.accessibilityInformation = { label: `Agent session ${this.session.sessionId}, ${label}`, role: 'treeitem' };
    return [item];
  }

  private createAgentItem(agent: Agent): AgentTreeItem {
    const hasChildren = agent.children.length > 0;
    const label = `${agent.label} (${agent.role})`;
    const item = new AgentTreeItem(
      label,
      hasChildren ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
      'agent',
      agent,
    );
    item.description = this.formatTokenUsage(agent);
    item.iconPath = this.getAgentIcon(agent);
    item.tooltip = this.formatAgentTooltip(agent);
    item.contextValue = `agent-${agent.riskLevel}`;
    item.accessibilityInformation = {
      label: `${agent.label}, ${agent.role}, ${agent.contextUsage.usagePercent.toFixed(1)}% context used, ${agent.riskLevel} risk`,
      role: 'treeitem',
    };
    return item;
  }

  private createPlaceholder(text: string, type: 'info' | 'error'): AgentTreeItem {
    const item = new AgentTreeItem(
      text,
      vscode.TreeItemCollapsibleState.None,
      'placeholder',
    );
    item.iconPath = new vscode.ThemeIcon(type === 'error' ? 'error' : 'info');
    return item;
  }

  private formatSessionLabel(summary: SessionSummary): string {
    const parts: string[] = [];
    if (summary.hottestAgentLabel) {
      parts.push(`Hottest: ${summary.hottestAgentLabel} ${summary.hottestUsagePercent.toFixed(0)}%`);
    }
    if (summary.criticalAgentCount > 0) {
      parts.push(`${summary.criticalAgentCount} critical`);
    }
    if (summary.warningAgentCount > 0) {
      parts.push(`${summary.warningAgentCount} warning`);
    }
    return parts.length > 0 ? parts.join(' \u00B7 ') : 'Session Active';
  }

  private formatTokenUsage(agent: Agent): string {
    const used = this.formatNumber(agent.contextUsage.usedTokens);
    const max = this.formatNumber(agent.contextUsage.maxTokens);
    const pct = agent.contextUsage.usagePercent.toFixed(0);
    return `${used} / ${max} (${pct}%)`;
  }

  private formatNumber(n: number): string {
    if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
    if (n >= 1_000) { return `${(n / 1_000).toFixed(0)}k`; }
    return n.toString();
  }

  private formatSessionTooltip(session: AgentSession, summary: SessionSummary): string {
    return [
      `Session: ${session.sessionId}`,
      `Status: ${session.status}`,
      `Agents: ${summary.totalAgents}`,
      `Hottest: ${summary.hottestAgentLabel} (${summary.hottestUsagePercent.toFixed(1)}%)`,
      `Warning: ${summary.warningAgentCount}, Critical: ${summary.criticalAgentCount}`,
      `Last update: ${session.lastUpdatedAt}`,
    ].join('\n');
  }

  private formatAgentTooltip(agent: Agent): string {
    const lines = [
      `${agent.label} (${agent.role})`,
      `Status: ${agent.status}`,
      `Tokens: ${agent.contextUsage.usedTokens.toLocaleString()} / ${agent.contextUsage.maxTokens.toLocaleString()}`,
      `Usage: ${agent.contextUsage.usagePercent.toFixed(1)}%`,
      `Risk: ${agent.riskLevel}`,
    ];
    if (agent.contextUsage.breakdown) {
      const b = agent.contextUsage.breakdown;
      lines.push('', 'Breakdown:');
      lines.push(`  System: ${b.systemPrompt.toLocaleString()}`);
      lines.push(`  User: ${b.userMessages.toLocaleString()}`);
      lines.push(`  Tools: ${b.toolResults.toLocaleString()}`);
      lines.push(`  Files: ${b.fileContext.toLocaleString()}`);
      if (b.other > 0) { lines.push(`  Other: ${b.other.toLocaleString()}`); }
    }
    return lines.join('\n');
  }

  private getSessionIcon(status: string): vscode.ThemeIcon {
    switch (status) {
      case 'active': return new vscode.ThemeIcon('pulse');
      case 'completed': return new vscode.ThemeIcon('check-all');
      case 'error': return new vscode.ThemeIcon('error');
      case 'idle': return new vscode.ThemeIcon('clock');
      default: return new vscode.ThemeIcon('circle-outline');
    }
  }

  private getAgentIcon(agent: Agent): vscode.ThemeIcon {
    if (agent.riskLevel === 'critical') {
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'));
    }
    if (agent.riskLevel === 'warning') {
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
    }

    switch (agent.status) {
      case 'running': return new vscode.ThemeIcon('play');
      case 'done': return new vscode.ThemeIcon('check');
      case 'error': return new vscode.ThemeIcon('error');
      case 'waiting': return new vscode.ThemeIcon('clock');
      default: return new vscode.ThemeIcon('circle-outline');
    }
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

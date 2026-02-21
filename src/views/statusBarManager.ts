import * as vscode from 'vscode';
import { AgentSession } from '../model/agentModel';

export class StatusBarManager implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private visible: boolean = true;
  private mode: 'hottestAgent' | 'sessionSummary' = 'hottestAgent';

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'agentContextTree.focus';
    this.item.name = 'Agent Context';
    this.setNoData();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) {
      this.item.show();
    } else {
      this.item.hide();
    }
  }

  setMode(mode: 'hottestAgent' | 'sessionSummary'): void {
    this.mode = mode;
  }

  update(session: AgentSession | null): void {
    if (!this.visible) { return; }

    if (!session) {
      this.setNoData();
      return;
    }

    const summary = session.sessionSummary;

    if (this.mode === 'hottestAgent' && summary.hottestAgentLabel) {
      const icon = this.getRiskIcon(summary.hottestUsagePercent);
      this.item.text = `${icon} CTX ${summary.hottestAgentLabel} ${summary.hottestUsagePercent.toFixed(0)}%`;
    } else {
      const icon = this.getRiskIcon(summary.hottestUsagePercent);
      this.item.text = `${icon} CTX ${summary.totalAgents} agents · ${summary.hottestUsagePercent.toFixed(0)}% peak`;
    }

    this.item.tooltip = [
      `Hottest: ${summary.hottestAgentLabel} (${summary.hottestUsagePercent.toFixed(1)}%)`,
      `Agents: ${summary.totalAgents}`,
      `Warning: ${summary.warningAgentCount}, Critical: ${summary.criticalAgentCount}`,
    ].join('\n');

    this.item.show();
  }

  private setNoData(): void {
    this.item.text = '$(pulse) CTX \u2014';
    this.item.tooltip = 'Agent Context: No data';
    if (this.visible) {
      this.item.show();
    }
  }

  private getRiskIcon(usagePercent: number): string {
    if (usagePercent >= 85) { return '$(error)'; }
    if (usagePercent >= 70) { return '$(warning)'; }
    return '$(pulse)';
  }

  dispose(): void {
    this.item.dispose();
  }
}

import * as vscode from 'vscode';
import { AgentSession } from '../model/agentModel';

export type StateChangeListener = (session: AgentSession | null, previous: AgentSession | null) => void;

export class StateStore implements vscode.Disposable {
  private currentState: AgentSession | null = null;
  private emitter = new vscode.EventEmitter<AgentSession | null>();
  private disposed = false;
  private lastStateHash: string = '';

  readonly onStateChanged: vscode.Event<AgentSession | null> = this.emitter.event;

  getState(): AgentSession | null {
    return this.currentState;
  }

  setState(session: AgentSession | null): void {
    if (this.disposed) { return; }

    const newHash = session ? this.computeHash(session) : '';
    if (newHash === this.lastStateHash) {
      return;
    }

    this.lastStateHash = newHash;
    this.currentState = session;
    this.emitter.fire(session);
  }

  private computeHash(session: AgentSession): string {
    return `${session.sessionId}:${session.lastUpdatedAt}:${JSON.stringify(session.sessionSummary)}`;
  }

  dispose(): void {
    this.disposed = true;
    this.emitter.dispose();
  }
}

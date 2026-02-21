import * as assert from 'assert';
import { AgentSession } from '../../model/agentModel';

function createMockEmitter() {
  const listeners: ((data: AgentSession | null) => void)[] = [];
  return {
    event: (listener: (data: AgentSession | null) => void) => {
      listeners.push(listener);
      return { dispose: () => { const idx = listeners.indexOf(listener); if (idx >= 0) { listeners.splice(idx, 1); } } };
    },
    fire: (data: AgentSession | null) => { for (const l of listeners) { l(data); } },
    dispose: () => { listeners.length = 0; },
    _listeners: listeners,
  };
}

class TestStateStore {
  private currentState: AgentSession | null = null;
  private emitter = createMockEmitter();
  private disposed = false;
  private lastStateHash: string = '';

  readonly onStateChanged = this.emitter.event;

  getState(): AgentSession | null {
    return this.currentState;
  }

  setState(session: AgentSession | null): void {
    if (this.disposed) { return; }
    const newHash = session ? `${session.sessionId}:${session.lastUpdatedAt}:${JSON.stringify(session.sessionSummary)}` : '';
    if (newHash === this.lastStateHash) { return; }
    this.lastStateHash = newHash;
    this.currentState = session;
    this.emitter.fire(session);
  }

  dispose(): void {
    this.disposed = true;
    this.emitter.dispose();
  }
}

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sessionId: 'sess-1',
    startedAt: '2026-02-21T10:00:00.000Z',
    lastUpdatedAt: '2026-02-21T10:00:00.000Z',
    agents: [],
    sessionSummary: {
      hottestAgentId: '',
      hottestAgentLabel: '',
      hottestUsagePercent: 0,
      totalAgents: 0,
      warningAgentCount: 0,
      criticalAgentCount: 0,
    },
    status: 'active',
    ...overrides,
  };
}

describe('StateStore', () => {
  let store: TestStateStore;

  beforeEach(() => {
    store = new TestStateStore();
  });

  afterEach(() => {
    store.dispose();
  });

  it('sets initial state and emits event', () => {
    const events: (AgentSession | null)[] = [];
    store.onStateChanged(s => events.push(s));

    const session = makeSession();
    store.setState(session);

    assert.strictEqual(store.getState(), session);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0], session);
  });

  it('does not emit for identical state', () => {
    const events: (AgentSession | null)[] = [];
    const session = makeSession();
    store.setState(session);

    store.onStateChanged(s => events.push(s));
    store.setState(makeSession());

    assert.strictEqual(events.length, 0);
  });

  it('emits for different state', () => {
    const events: (AgentSession | null)[] = [];
    store.setState(makeSession());
    store.onStateChanged(s => events.push(s));

    const newSession = makeSession({ lastUpdatedAt: '2026-02-21T10:01:00.000Z' });
    store.setState(newSession);

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0]?.lastUpdatedAt, '2026-02-21T10:01:00.000Z');
  });

  it('emits null when cleared', () => {
    const events: (AgentSession | null)[] = [];
    store.setState(makeSession());
    store.onStateChanged(s => events.push(s));

    store.setState(null);

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0], null);
    assert.strictEqual(store.getState(), null);
  });

  it('supports multiple subscribers', () => {
    const events1: (AgentSession | null)[] = [];
    const events2: (AgentSession | null)[] = [];
    store.onStateChanged(s => events1.push(s));
    store.onStateChanged(s => events2.push(s));

    store.setState(makeSession());

    assert.strictEqual(events1.length, 1);
    assert.strictEqual(events2.length, 1);
  });

  it('does not emit after dispose', () => {
    const events: (AgentSession | null)[] = [];
    store.onStateChanged(s => events.push(s));
    store.dispose();

    store.setState(makeSession());
    assert.strictEqual(events.length, 0);
  });
});

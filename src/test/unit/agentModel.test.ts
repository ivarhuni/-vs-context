import * as assert from 'assert';
import {
  computeUsagePercent,
  computeRiskLevel,
  computeSessionSummary,
  createAgent,
  createSession,
  flattenAgents,
  RawAgentData,
  RawLogEntry,
  Thresholds,
} from '../../model/agentModel';

const defaultThresholds: Thresholds = { warningPercent: 70, criticalPercent: 85 };
const ts = '2026-02-21T10:00:00.000Z';

describe('agentModel', () => {
  describe('computeUsagePercent', () => {
    it('computes correct percentage', () => {
      assert.strictEqual(computeUsagePercent(45000, 128000), (45000 / 128000) * 100);
    });

    it('returns 0 when maxTokens is 0', () => {
      assert.strictEqual(computeUsagePercent(100, 0), 0);
    });

    it('caps at 100 when used exceeds max', () => {
      assert.strictEqual(computeUsagePercent(200000, 128000), 100);
    });

    it('handles zero used tokens', () => {
      assert.strictEqual(computeUsagePercent(0, 128000), 0);
    });

    it('handles Number.MAX_SAFE_INTEGER', () => {
      const pct = computeUsagePercent(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      assert.ok(Number.isFinite(pct));
      assert.strictEqual(pct, 100);
    });
  });

  describe('computeRiskLevel', () => {
    it('returns normal below warning threshold', () => {
      assert.strictEqual(computeRiskLevel(50, defaultThresholds), 'normal');
    });

    it('returns warning at warning threshold', () => {
      assert.strictEqual(computeRiskLevel(70, defaultThresholds), 'warning');
    });

    it('returns warning between warning and critical', () => {
      assert.strictEqual(computeRiskLevel(80, defaultThresholds), 'warning');
    });

    it('returns critical at critical threshold', () => {
      assert.strictEqual(computeRiskLevel(85, defaultThresholds), 'critical');
    });

    it('returns critical above critical threshold', () => {
      assert.strictEqual(computeRiskLevel(95, defaultThresholds), 'critical');
    });
  });

  describe('createAgent', () => {
    it('creates agent with all fields', () => {
      const raw: RawAgentData = {
        agentId: 'main-1',
        role: 'main',
        label: 'Orchestrator',
        status: 'running',
        context: {
          usedTokens: 45000,
          maxTokens: 128000,
          breakdown: { systemPrompt: 2000, userMessages: 8000, toolResults: 30000, fileContext: 5000 },
        },
        children: [],
      };
      const agent = createAgent(raw, ts, defaultThresholds);
      assert.strictEqual(agent.agentId, 'main-1');
      assert.strictEqual(agent.role, 'main');
      assert.strictEqual(agent.label, 'Orchestrator');
      assert.ok(agent.contextUsage.usagePercent > 0);
      assert.strictEqual(agent.contextUsage.breakdown?.systemPrompt, 2000);
      assert.deepStrictEqual(agent.children, []);
      assert.strictEqual(agent.lastActivityAt, ts);
    });

    it('defaults missing optional fields', () => {
      const raw: RawAgentData = {
        agentId: 'sub-1',
        role: 'subagent',
        label: 'Helper',
        status: 'done',
        context: { usedTokens: 1000, maxTokens: 128000 },
      };
      const agent = createAgent(raw, ts, defaultThresholds);
      assert.deepStrictEqual(agent.children, []);
      assert.strictEqual(agent.contextUsage.breakdown, undefined);
      assert.strictEqual(agent.parentAgentId, undefined);
    });

    it('creates nested children', () => {
      const raw: RawAgentData = {
        agentId: 'main-1',
        role: 'main',
        label: 'Main',
        status: 'running',
        context: { usedTokens: 50000, maxTokens: 128000 },
        children: [
          {
            agentId: 'sub-1',
            role: 'subagent',
            parentAgentId: 'main-1',
            label: 'Sub',
            status: 'done',
            context: { usedTokens: 10000, maxTokens: 128000 },
            children: [
              {
                agentId: 'sub-1-1',
                role: 'subagent',
                parentAgentId: 'sub-1',
                label: 'SubSub',
                status: 'waiting',
                context: { usedTokens: 5000, maxTokens: 128000 },
              },
            ],
          },
        ],
      };
      const agent = createAgent(raw, ts, defaultThresholds);
      assert.strictEqual(agent.children.length, 1);
      assert.strictEqual(agent.children[0].children.length, 1);
      assert.strictEqual(agent.children[0].children[0].agentId, 'sub-1-1');
      assert.strictEqual(agent.children[0].children[0].parentAgentId, 'sub-1');
    });

    it('derives risk level correctly for warning', () => {
      const raw: RawAgentData = {
        agentId: 'a', role: 'main', label: 'A', status: 'running',
        context: { usedTokens: 92160, maxTokens: 128000 },
      };
      const agent = createAgent(raw, ts, defaultThresholds);
      assert.strictEqual(agent.riskLevel, 'warning');
    });

    it('derives risk level correctly for critical', () => {
      const raw: RawAgentData = {
        agentId: 'a', role: 'main', label: 'A', status: 'running',
        context: { usedTokens: 115200, maxTokens: 128000 },
      };
      const agent = createAgent(raw, ts, defaultThresholds);
      assert.strictEqual(agent.riskLevel, 'critical');
    });
  });

  describe('computeSessionSummary', () => {
    it('returns empty summary for no agents', () => {
      const summary = computeSessionSummary([]);
      assert.strictEqual(summary.totalAgents, 0);
      assert.strictEqual(summary.hottestUsagePercent, 0);
    });

    it('finds hottest agent', () => {
      const entry: RawLogEntry = {
        v: 1, ts, sessionId: 'sess-1',
        agents: [
          {
            agentId: 'main-1', role: 'main', label: 'Main', status: 'running',
            context: { usedTokens: 30000, maxTokens: 128000 },
            children: [
              {
                agentId: 'sub-1', role: 'subagent', parentAgentId: 'main-1',
                label: 'Hot', status: 'running',
                context: { usedTokens: 110000, maxTokens: 128000 },
              },
            ],
          },
        ],
      };
      const session = createSession(entry, defaultThresholds);
      assert.strictEqual(session.sessionSummary.hottestAgentLabel, 'Hot');
      assert.ok(session.sessionSummary.hottestUsagePercent > 85);
      assert.strictEqual(session.sessionSummary.criticalAgentCount, 1);
    });

    it('counts warning and critical agents', () => {
      const entry: RawLogEntry = {
        v: 1, ts, sessionId: 'sess-1',
        agents: [
          {
            agentId: 'main-1', role: 'main', label: 'Normal', status: 'running',
            context: { usedTokens: 10000, maxTokens: 128000 },
            children: [
              {
                agentId: 'sub-1', role: 'subagent', parentAgentId: 'main-1',
                label: 'Warn', status: 'running',
                context: { usedTokens: 92160, maxTokens: 128000 },
              },
              {
                agentId: 'sub-2', role: 'subagent', parentAgentId: 'main-1',
                label: 'Crit', status: 'running',
                context: { usedTokens: 115200, maxTokens: 128000 },
              },
            ],
          },
        ],
      };
      const session = createSession(entry, defaultThresholds);
      assert.strictEqual(session.sessionSummary.warningAgentCount, 1);
      assert.strictEqual(session.sessionSummary.criticalAgentCount, 1);
      assert.strictEqual(session.sessionSummary.totalAgents, 3);
    });
  });

  describe('flattenAgents', () => {
    it('flattens nested agent tree', () => {
      const entry: RawLogEntry = {
        v: 1, ts, sessionId: 'sess-1',
        agents: [
          {
            agentId: 'main-1', role: 'main', label: 'Main', status: 'running',
            context: { usedTokens: 10000, maxTokens: 128000 },
            children: [
              {
                agentId: 'sub-1', role: 'subagent', parentAgentId: 'main-1',
                label: 'Sub1', status: 'running',
                context: { usedTokens: 5000, maxTokens: 128000 },
                children: [
                  {
                    agentId: 'sub-1-1', role: 'subagent', parentAgentId: 'sub-1',
                    label: 'SubSub1', status: 'done',
                    context: { usedTokens: 2000, maxTokens: 128000 },
                  },
                ],
              },
            ],
          },
        ],
      };
      const session = createSession(entry, defaultThresholds);
      const flat = flattenAgents(session.agents);
      assert.strictEqual(flat.length, 3);
      assert.deepStrictEqual(flat.map(a => a.agentId), ['main-1', 'sub-1', 'sub-1-1']);
    });

    it('returns empty array for no agents', () => {
      const flat = flattenAgents([]);
      assert.strictEqual(flat.length, 0);
    });
  });

  describe('createSession', () => {
    it('creates session with correct status for all done', () => {
      const entry: RawLogEntry = {
        v: 1, ts, sessionId: 'sess-1',
        agents: [{
          agentId: 'main-1', role: 'main', label: 'Agent', status: 'done',
          context: { usedTokens: 10000, maxTokens: 128000 },
          children: [],
        }],
      };
      const session = createSession(entry, defaultThresholds);
      assert.strictEqual(session.status, 'completed');
    });

    it('creates session with error status when any agent has error', () => {
      const entry: RawLogEntry = {
        v: 1, ts, sessionId: 'sess-1',
        agents: [{
          agentId: 'main-1', role: 'main', label: 'Agent', status: 'error',
          context: { usedTokens: 10000, maxTokens: 128000 },
          children: [],
        }],
      };
      const session = createSession(entry, defaultThresholds);
      assert.strictEqual(session.status, 'error');
    });

    it('creates session with idle status when all waiting', () => {
      const entry: RawLogEntry = {
        v: 1, ts, sessionId: 'sess-1',
        agents: [{
          agentId: 'main-1', role: 'main', label: 'Agent', status: 'waiting',
          context: { usedTokens: 10000, maxTokens: 128000 },
          children: [],
        }],
      };
      const session = createSession(entry, defaultThresholds);
      assert.strictEqual(session.status, 'idle');
    });

    it('creates active session when agent is running', () => {
      const entry: RawLogEntry = {
        v: 1, ts, sessionId: 'sess-1',
        agents: [{
          agentId: 'main-1', role: 'main', label: 'Agent', status: 'running',
          context: { usedTokens: 10000, maxTokens: 128000 },
          children: [],
        }],
      };
      const session = createSession(entry, defaultThresholds);
      assert.strictEqual(session.status, 'active');
    });
  });
});

export type RiskLevel = 'normal' | 'warning' | 'critical';
export type AgentStatus = 'running' | 'waiting' | 'done' | 'error';
export type SessionStatus = 'active' | 'idle' | 'completed' | 'error';

export interface ContextBreakdown {
  systemPrompt: number;
  userMessages: number;
  toolResults: number;
  fileContext: number;
  other: number;
}

export interface ContextSnapshot {
  usedTokens: number;
  maxTokens: number;
  usagePercent: number;
  breakdown?: ContextBreakdown;
}

export interface Agent {
  agentId: string;
  role: 'main' | 'subagent';
  label: string;
  parentAgentId?: string;
  contextUsage: ContextSnapshot;
  children: Agent[];
  riskLevel: RiskLevel;
  status: AgentStatus;
  lastActivityAt: string;
}

export interface SessionSummary {
  hottestAgentId: string;
  hottestAgentLabel: string;
  hottestUsagePercent: number;
  totalAgents: number;
  warningAgentCount: number;
  criticalAgentCount: number;
}

export interface AgentSession {
  sessionId: string;
  startedAt: string;
  lastUpdatedAt: string;
  agents: Agent[];
  sessionSummary: SessionSummary;
  status: SessionStatus;
}

export interface Thresholds {
  warningPercent: number;
  criticalPercent: number;
}

const DEFAULT_THRESHOLDS: Thresholds = { warningPercent: 70, criticalPercent: 85 };
export const MAX_AGENT_DEPTH = 10;

export function computeUsagePercent(used: number, max: number): number {
  if (max <= 0) { return 0; }
  const pct = (used / max) * 100;
  return Math.min(pct, 100);
}

export function computeRiskLevel(usagePercent: number, thresholds: Thresholds = DEFAULT_THRESHOLDS): RiskLevel {
  if (usagePercent >= thresholds.criticalPercent) { return 'critical'; }
  if (usagePercent >= thresholds.warningPercent) { return 'warning'; }
  return 'normal';
}

export function flattenAgents(agents: Agent[], depth: number = 0): Agent[] {
  if (depth > MAX_AGENT_DEPTH) { return []; }
  const result: Agent[] = [];
  for (const a of agents) {
    result.push(a);
    if (a.children.length > 0) {
      result.push(...flattenAgents(a.children, depth + 1));
    }
  }
  return result;
}

export function computeSessionSummary(agents: Agent[]): SessionSummary {
  const all = flattenAgents(agents);
  if (all.length === 0) {
    return {
      hottestAgentId: '',
      hottestAgentLabel: '',
      hottestUsagePercent: 0,
      totalAgents: 0,
      warningAgentCount: 0,
      criticalAgentCount: 0,
    };
  }

  let hottest = all[0];
  let warningCount = 0;
  let criticalCount = 0;

  for (const a of all) {
    if (a.contextUsage.usagePercent > hottest.contextUsage.usagePercent) {
      hottest = a;
    }
    if (a.riskLevel === 'warning') { warningCount++; }
    if (a.riskLevel === 'critical') { criticalCount++; }
  }

  return {
    hottestAgentId: hottest.agentId,
    hottestAgentLabel: hottest.label,
    hottestUsagePercent: hottest.contextUsage.usagePercent,
    totalAgents: all.length,
    warningAgentCount: warningCount,
    criticalAgentCount: criticalCount,
  };
}

export interface RawAgentData {
  agentId: string;
  role: 'main' | 'subagent';
  label: string;
  parentAgentId?: string;
  status: AgentStatus;
  context: {
    usedTokens: number;
    maxTokens: number;
    breakdown?: Partial<ContextBreakdown>;
  };
  children?: RawAgentData[];
}

export interface RawLogEntry {
  v: number;
  ts: string;
  sessionId: string;
  agents: RawAgentData[];
}

export function createAgent(raw: RawAgentData, ts: string, thresholds: Thresholds = DEFAULT_THRESHOLDS, depth: number = 0): Agent {
  const usedTokens = toFiniteNumber(raw.context?.usedTokens);
  const maxTokens = toFiniteNumber(raw.context?.maxTokens);
  const usagePercent = computeUsagePercent(usedTokens, maxTokens);
  const riskLevel = computeRiskLevel(usagePercent, thresholds);

  const breakdown: ContextBreakdown | undefined = raw.context?.breakdown
    ? {
        systemPrompt: toFiniteNumber(raw.context.breakdown.systemPrompt),
        userMessages: toFiniteNumber(raw.context.breakdown.userMessages),
        toolResults: toFiniteNumber(raw.context.breakdown.toolResults),
        fileContext: toFiniteNumber(raw.context.breakdown.fileContext),
        other: toFiniteNumber(raw.context.breakdown.other),
      }
    : undefined;

  const children = depth < MAX_AGENT_DEPTH
    ? (raw.children ?? []).map(c => createAgent(c, ts, thresholds, depth + 1))
    : [];

  return {
    agentId: String(raw.agentId ?? ''),
    role: raw.role === 'subagent' ? 'subagent' : 'main',
    label: String(raw.label ?? ''),
    parentAgentId: raw.parentAgentId,
    contextUsage: {
      usedTokens,
      maxTokens,
      usagePercent,
      breakdown,
    },
    children,
    riskLevel,
    status: sanitizeStatus(raw.status),
    lastActivityAt: ts,
  };
}

function toFiniteNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function sanitizeStatus(value: unknown): AgentStatus {
  const allowed: AgentStatus[] = ['running', 'waiting', 'done', 'error'];
  return allowed.includes(value as AgentStatus) ? (value as AgentStatus) : 'running';
}

export function createSession(entry: RawLogEntry, thresholds: Thresholds = DEFAULT_THRESHOLDS): AgentSession {
  const agents = entry.agents.map(a => createAgent(a, entry.ts, thresholds));
  const summary = computeSessionSummary(agents);

  let sessionStatus: SessionStatus = 'active';
  const allAgents = flattenAgents(agents);
  if (allAgents.every(a => a.status === 'done')) { sessionStatus = 'completed'; }
  else if (allAgents.some(a => a.status === 'error')) { sessionStatus = 'error'; }
  else if (allAgents.every(a => a.status === 'waiting')) { sessionStatus = 'idle'; }

  return {
    sessionId: entry.sessionId,
    startedAt: entry.ts,
    lastUpdatedAt: entry.ts,
    agents,
    sessionSummary: summary,
    status: sessionStatus,
  };
}

import {
    Agent,
    AgentSession,
    AgentStatus,
    ContextBreakdown,
    SessionStatus,
    Thresholds,
    computeRiskLevel,
    computeSessionSummary,
    computeUsagePercent,
} from '../model/agentModel';
import { SubagentCall, VscodeChatSession } from '../reader/copilotSessionReader';

const RUNNING_THRESHOLD_MS = 30_000;
const WAITING_THRESHOLD_MS = 300_000;

function computeAgentStatus(lastModifiedMs: number, now: number): AgentStatus {
    const age = now - lastModifiedMs;
    if (age <= RUNNING_THRESHOLD_MS) { return 'running'; }
    if (age <= WAITING_THRESHOLD_MS) { return 'waiting'; }
    return 'done';
}

function computeBreakdown(
    promptTokens: number,
    details: Array<{ category: string; label: string; percentageOfPrompt: number }>,
): ContextBreakdown | undefined {
    if (details.length === 0 || promptTokens <= 0) { return undefined; }

    let systemPct = 0;
    let messagesPct = 0;
    let toolResultsPct = 0;
    let filesPct = 0;

    for (const item of details) {
        switch (item.label) {
            case 'System Instructions':
            case 'Tool Definitions':
                systemPct += item.percentageOfPrompt;
                break;
            case 'Messages':
                messagesPct += item.percentageOfPrompt;
                break;
            case 'Tool Results':
                toolResultsPct += item.percentageOfPrompt;
                break;
            case 'Files':
                filesPct += item.percentageOfPrompt;
                break;
        }
    }

    const systemPrompt = Math.round(promptTokens * systemPct / 100);
    const userMessages = Math.round(promptTokens * messagesPct / 100);
    const toolResults = Math.round(promptTokens * toolResultsPct / 100);
    const fileContext = Math.round(promptTokens * filesPct / 100);
    const other = promptTokens - systemPrompt - userMessages - toolResults - fileContext;

    return { systemPrompt, userMessages, toolResults, fileContext, other };
}

function buildAgent(
    session: VscodeChatSession,
    role: 'main' | 'subagent',
    label: string,
    parentAgentId: string | undefined,
    children: Agent[],
    thresholds: Thresholds,
    now: number,
): Agent {
    const usedTokens = session.latestPromptTokens;
    const maxTokens = session.maxInputTokens;
    const usagePercent = computeUsagePercent(usedTokens, maxTokens);
    const riskLevel = computeRiskLevel(usagePercent, thresholds);
    const breakdown = computeBreakdown(usedTokens, session.promptTokenDetails);
    const status = computeAgentStatus(session.lastModifiedMs, now);

    return {
        agentId: session.sessionId,
        role,
        label,
        parentAgentId,
        contextUsage: { usedTokens, maxTokens, usagePercent, breakdown },
        children,
        riskLevel,
        status,
        lastActivityAt: new Date(session.lastModifiedMs).toISOString(),
    };
}

function buildSubagentFromCall(
    call: SubagentCall,
    parentAgentId: string,
    index: number,
    mainMaxTokens: number,
    thresholds: Thresholds,
    now: number,
): Agent {
    const usedTokens = call.promptTokensAtTurn;
    const maxTokens = mainMaxTokens;
    const usagePercent = computeUsagePercent(usedTokens, maxTokens);
    const riskLevel = computeRiskLevel(usagePercent, thresholds);
    const status: AgentStatus = call.isComplete ? 'done' : 'running';

    return {
        agentId: call.toolCallId,
        role: 'subagent',
        label: call.description || `Subagent #${index + 1}`,
        parentAgentId,
        contextUsage: { usedTokens, maxTokens, usagePercent, breakdown: undefined },
        children: [],
        riskLevel,
        status,
        lastActivityAt: new Date(now).toISOString(),
    };
}

export function buildAgentSessionFromVscodeSessions(
    sessions: Map<string, VscodeChatSession>,
    activityWindowMs: number,
    thresholds: Thresholds,
): AgentSession | null {
    const now = Date.now();

    // Filter to sessions modified within the activity window
    const activeSessions = [...sessions.values()]
        .filter(s => (now - s.lastModifiedMs) <= activityWindowMs)
        .sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);

    if (activeSessions.length === 0) { return null; }

    // The main agent is the most recently active session (the live conversation).
    const mainSession = activeSessions[0];

    // Subagents are embedded tool invocations within the main session's responses.
    const subAgents: Agent[] = mainSession.subagentCalls.map((call, i) =>
        buildSubagentFromCall(call, mainSession.sessionId, i, mainSession.maxInputTokens, thresholds, now),
    );

    // Build main agent with subagent children
    const mainAgent = buildAgent(
        mainSession,
        'main',
        mainSession.modelName || 'Copilot Chat',
        undefined,
        subAgents,
        thresholds,
        now,
    );

    const sessionSummary = computeSessionSummary([mainAgent]);

    // Determine overall session status
    const allAgents = [mainAgent, ...subAgents];
    let sessionStatus: SessionStatus;
    if (allAgents.some(a => a.status === 'running')) {
        sessionStatus = 'active';
    } else if (allAgents.every(a => a.status === 'done')) {
        sessionStatus = 'completed';
    } else if (allAgents.every(a => a.status === 'waiting')) {
        sessionStatus = 'idle';
    } else {
        sessionStatus = 'active';
    }

    return {
        sessionId: mainSession.sessionId,
        startedAt: new Date(mainSession.creationDate).toISOString(),
        lastUpdatedAt: new Date(mainSession.lastModifiedMs).toISOString(),
        agents: [mainAgent],
        sessionSummary,
        status: sessionStatus,
    };
}

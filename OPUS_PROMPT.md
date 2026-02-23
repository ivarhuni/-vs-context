# Opus Implementation Prompt — VS Code Agent Context Extension: Live Copilot Chat Session Mode

## TASK

You are implementing a major feature for a VS Code extension. The extension currently reads a **manually curated JSONL file** (custom schema) to display agent context window usage. You will add a **new data source mode** called `copilot-chat` that **automatically reads live token usage** directly from VS Code's internal GitHub Copilot Chat session files — no manual log file required. The user never has to configure a log file path; the extension discovers and reads sessions automatically as the developer works.

When done, the extension must work out of the box, showing real-time context window usage for the developer's active Copilot Chat agent session(s) as they happen.

---

## REPOSITORY STRUCTURE

```
src/
  extension.ts          ← main entrypoint (activate/deactivate)
  config/
    settings.ts         ← reads vscode settings, ExtensionSettings interface
  model/
    agentModel.ts       ← domain types: Agent, AgentSession, RawLogEntry, etc.
  parser/
    jsonlParser.ts      ← parses custom JSONL log format → AgentSession
  poller/
    filePoller.ts       ← polls/watches a file path for new bytes
  store/
    stateStore.ts       ← holds current AgentSession, fires change events
  util/
    logger.ts           ← VS Code OutputChannel logger
  views/
    agentTreeProvider.ts   ← TreeView sidebar
    statusBarManager.ts    ← status bar item
    webviewPanel.ts        ← bar chart webview
package.json
tsconfig.json
```

---

## EXISTING SOURCE FILES (complete, verbatim)

### `src/model/agentModel.ts`
```typescript
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
    return { hottestAgentId: '', hottestAgentLabel: '', hottestUsagePercent: 0, totalAgents: 0, warningAgentCount: 0, criticalAgentCount: 0 };
  }
  let hottest = all[0];
  let warningCount = 0;
  let criticalCount = 0;
  for (const a of all) {
    if (a.contextUsage.usagePercent > hottest.contextUsage.usagePercent) { hottest = a; }
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
    ? { systemPrompt: toFiniteNumber(raw.context.breakdown.systemPrompt), userMessages: toFiniteNumber(raw.context.breakdown.userMessages), toolResults: toFiniteNumber(raw.context.breakdown.toolResults), fileContext: toFiniteNumber(raw.context.breakdown.fileContext), other: toFiniteNumber(raw.context.breakdown.other) }
    : undefined;
  const children = depth < MAX_AGENT_DEPTH ? (raw.children ?? []).map(c => createAgent(c, ts, thresholds, depth + 1)) : [];
  return {
    agentId: String(raw.agentId ?? ''),
    role: raw.role === 'subagent' ? 'subagent' : 'main',
    label: String(raw.label ?? ''),
    parentAgentId: raw.parentAgentId,
    contextUsage: { usedTokens, maxTokens, usagePercent, breakdown },
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
```

### `src/config/settings.ts`
```typescript
import * as vscode from 'vscode';

export interface ExtensionSettings {
  logFilePath: string;
  dataSource: 'jsonl';
  pollIntervalMs: number;
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
  dataSource: 'jsonl',
  pollIntervalMs: 2000,
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
    dataSource: 'jsonl',
    pollIntervalMs,
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
```

### `src/extension.ts`
```typescript
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

  parser = new JsonlParser(logger, { warningPercent: currentSettings.warningThresholdPercent, criticalPercent: currentSettings.criticalThresholdPercent });
  store = new StateStore();
  treeProvider = new AgentTreeProvider();
  statusBar = new StatusBarManager();
  webviewPanel = new AgentContextWebviewPanel();

  statusBar.setVisible(currentSettings.showStatusBar);
  statusBar.setMode(currentSettings.statusBarMode);
  statusBar.setThresholds(currentSettings.warningThresholdPercent, currentSettings.criticalThresholdPercent);
  webviewPanel.setRetainContext(currentSettings.webviewRetainContext);

  const treeView = vscode.window.createTreeView('agentContextTree', { treeDataProvider: treeProvider, showCollapseAll: true });

  store.onStateChanged(session => {
    treeProvider.refresh(session);
    statusBar.update(session);
    webviewPanel.update(session);
    if (currentSettings.notifyOnCritical && session) { checkCriticalThresholds(session, currentSettings); }
  });

  poller = new FilePoller({ filePath: currentSettings.logFilePath, pollIntervalMs: currentSettings.pollIntervalMs }, logger);

  poller.onData(chunk => {
    const result = parser.parseChunk(chunk);
    const latest = parser.getLatestSession();
    store.setState(latest);
    if (result.malformedLineCount > 0) { logger.debug(MODULE, `Malformed lines so far: ${result.malformedLineCount}`); }
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

  const settingsDisposable = onSettingsChanged(newSettings => { applySettings(newSettings); });
  const showTreeCmd = vscode.commands.registerCommand('agentContext.showTree', () => { vscode.commands.executeCommand('agentContextTree.focus'); });
  const openWebviewCmd = vscode.commands.registerCommand('agentContext.openWebview', () => { webviewPanel.show(context.extensionUri); });
  const refreshCmd = vscode.commands.registerCommand('agentContext.refresh', () => { logger.info(MODULE, 'Manual refresh triggered'); poller.reconfigure({}); });

  context.subscriptions.push(logger, store, treeProvider, statusBar, webviewPanel, treeView, settingsDisposable, showTreeCmd, openWebviewCmd, refreshCmd, { dispose: () => poller.dispose() });
  logger.info(MODULE, 'Extension activated successfully');
}

function applySettings(settings: ExtensionSettings): void {
  currentSettings = settings;
  logger.setLevel(settings.logLevel);
  parser.setThresholds({ warningPercent: settings.warningThresholdPercent, criticalPercent: settings.criticalThresholdPercent });
  statusBar.setVisible(settings.showStatusBar);
  statusBar.setMode(settings.statusBarMode);
  statusBar.setThresholds(settings.warningThresholdPercent, settings.criticalThresholdPercent);
  webviewPanel.setRetainContext(settings.webviewRetainContext);
  poller.reconfigure({ filePath: settings.logFilePath, pollIntervalMs: settings.pollIntervalMs });
  const current = store.getState();
  if (current) { treeProvider.refresh(current); statusBar.update(current); webviewPanel.update(current); }
}

function checkCriticalThresholds(session: AgentSession, settings: ExtensionSettings): void {
  const allAgents = flattenAgents(session.agents);
  for (const agent of allAgents) {
    if (agent.contextUsage.usagePercent >= settings.criticalThresholdPercent) {
      if (!criticalNotifiedAgents.has(agent.agentId)) {
        criticalNotifiedAgents.add(agent.agentId);
        vscode.window.showWarningMessage(`Agent "${agent.label}" has reached ${agent.contextUsage.usagePercent.toFixed(0)}% context usage`);
      }
    } else {
      criticalNotifiedAgents.delete(agent.agentId);
    }
  }
}

export function deactivate(): void {}
```

### `src/poller/filePoller.ts` — (existing, unchanged, keep as-is)
The FilePoller class watches/polls a single file path for new bytes and emits data/reset/missing events. It is used by the JSONL data source. Do not modify it.

### `src/parser/jsonlParser.ts` — (existing, unchanged, keep as-is)
The JsonlParser parses the custom JSONL format. Do not modify it.

### `src/store/stateStore.ts` — (existing, unchanged, keep as-is)
The StateStore holds one `AgentSession | null` and fires change events. Do not modify it.

### `src/views/` — (existing, unchanged, keep as-is)
AgentTreeProvider, StatusBarManager, AgentContextWebviewPanel. Do not modify them.

### `src/util/logger.ts` — (existing, unchanged, keep as-is)
The Logger writes to a VS Code OutputChannel.

---

## DISCOVERED: VS CODE COPILOT CHAT SESSION FORMAT

VS Code GitHub Copilot Chat stores one JSONL file per chat session at:
```
~/Library/Application Support/Code/User/workspaceStorage/{workspace-hash}/chatSessions/{session-uuid}.jsonl
```

**The `{workspace-hash}` directory is exactly one level above `context.storageUri.fsPath`.**

For example, if:
- `context.storageUri.fsPath` = `/Users/you/Library/Application Support/Code/User/workspaceStorage/8a19cd46.../agent-context-display/`
- Then `chatSessionsDir` = `/Users/you/.../workspaceStorage/8a19cd46.../chatSessions/`

Each JSONL file contains lines with a `kind` field:

### KIND 0 — Session header (first line of every file)
```json
{
  "kind": 0,
  "v": {
    "sessionId": "c10d5482-e8eb-493c-98ad-61ca35d387c8",
    "creationDate": 1771419225290,
    "inputState": {
      "selectedModel": {
        "identifier": "copilot/claude-sonnet-4.6",
        "metadata": {
          "id": "claude-sonnet-4.6",
          "name": "Claude Sonnet 4.6",
          "maxInputTokens": 271805,
          "maxOutputTokens": 128000
        }
      }
    }
  }
}
```
Key fields from `v`:
- `sessionId` — UUID of this chat session
- `creationDate` — Unix timestamp in milliseconds
- `v.inputState.selectedModel.metadata.maxInputTokens` — context window size (integer)
- `v.inputState.selectedModel.metadata.maxOutputTokens` — max output tokens
- `v.inputState.selectedModel.metadata.name` — model display name (e.g. "Claude Sonnet 4.6")
- `v.inputState.selectedModel.identifier` — model identifier string (e.g. "copilot/claude-sonnet-4.6")

### KIND 1 — Individual turn result (appears after each completed LLM turn)
Keyed with `k: ["requests", N, "result"]` where N is the turn index.
```json
{
  "kind": 1,
  "k": ["requests", 2, "result"],
  "v": {
    "timings": { "firstProgress": 14170, "totalElapsed": 189559 },
    "usage": {
      "completionTokens": 121,
      "promptTokens": 38315,
      "promptTokenDetails": [
        { "category": "System", "label": "System Instructions", "percentageOfPrompt": 24 },
        { "category": "System", "label": "Tool Definitions", "percentageOfPrompt": 31 },
        { "category": "User Context", "label": "Messages", "percentageOfPrompt": 7 },
        { "category": "User Context", "label": "Files", "percentageOfPrompt": 10 },
        { "category": "User Context", "label": "Tool Results", "percentageOfPrompt": 28 }
      ]
    },
    "metadata": {
      "toolCallRounds": [{ "thinking": { "tokens": 270 } }]
    }
  }
}
```
Key fields from `v.usage`:
- `promptTokens` — **the total tokens currently in the context window for this turn** (this is what we display as `usedTokens`)
- `completionTokens` — tokens in the response (not needed for context window display, but useful)
- `promptTokenDetails` — array of breakdown items. Each has `category` ("System" or "User Context") and `label` (which subcategory) and `percentageOfPrompt` (integer 0-100 approximation). Labels seen: "System Instructions", "Tool Definitions", "Messages", "Files", "Tool Results".

### KIND 2 — Request/turn metadata
```json
{
  "kind": 2,
  "k": ["requests"],
  "v": [{
    "requestId": "request_fd377aa4-...",
    "timestamp": 1771419573259,
    "modelId": "copilot/gpt-5.3-codex",
    "agent": { "id": "github.copilot.editsAgent" }
  }]
}
```

### Important observations:
1. Each session file = one agent in the developer's agentic session. In VS Code Copilot, when agent mode spawns sub-agents (e.g. `runSubagent`), each sub-agent appears as a **separate concurrent session file** in the same `chatSessions/` directory.
2. **The session with the smallest `creationDate` among currently active sessions = the main agent.** Newer sessions started within the same activity window = subagents.
3. `promptTokens` from the **latest KIND 1 entry** in a file = the **current context usage** for that session/agent.
4. A session is "active" if its file was modified within the `activityWindowMinutes` setting (default 60 minutes).
5. `maxInputTokens` from KIND 0 = the context window size (the denominator for usage%).

---

## WHAT YOU MUST IMPLEMENT

Implement 5 changes. Keep all existing code working (JSONL mode must still work). Add `copilot-chat` as a new first-class data source.

### CHANGE 1: New file `src/reader/copilotSessionReader.ts`

This class is the equivalent of `FilePoller` but for the Copilot Chat data source. It:
1. Receives `chatSessionsDir: string` and `pollIntervalMs: number` in its constructor, plus a `Logger`.
2. Keeps a `Map<string, VscodeChatSession>` of all discovered session files, keyed by filename (UUID.jsonl).
3. On start, scans the directory and reads all JSONL files. For each file:
   - Reads it from byte 0 incrementally (track file offsets per file, similar to FilePoller).
   - Parses Kind 0at the very beginning (session header — only appears once).
   - Parses Kind 1 entries for the `usage` data — always replaces with the latest seen.
4. Sets up a `vscode.FileSystemWatcher` on `chatSessionsDir/**/*.jsonl` to detect new files and changes.
5. Has a polling interval for robustness (same `pollIntervalMs`).
6. Exposes:
   - `onSessionsChanged(callback: (sessions: Map<string, VscodeChatSession>) => void): void`
   - `getSessions(): Map<string, VscodeChatSession>`
   - `start(): void`
   - `stop(): void`
   - `dispose(): void` (implements `vscode.Disposable`)

Define this TypeScript interface in the same file:
```typescript
export interface VscodeChatSession {
  sessionId: string;           // from Kind 0 v.sessionId
  fileName: string;            // the JSONL filename (UUID.jsonl)
  creationDate: number;        // from Kind 0 v.creationDate (unix ms)
  modelName: string;           // from Kind 0 v.inputState.selectedModel.metadata.name
  modelIdentifier: string;     // from Kind 0 v.inputState.selectedModel.identifier
  maxInputTokens: number;      // from Kind 0 metadata.maxInputTokens
  maxOutputTokens: number;     // from Kind 0 metadata.maxOutputTokens
  latestPromptTokens: number;  // from latest Kind 1 v.usage.promptTokens (0 if no turns yet)
  latestCompletionTokens: number; // from latest Kind 1 v.usage.completionTokens
  promptTokenDetails: Array<{ category: string; label: string; percentageOfPrompt: number }>; // from latest Kind 1
  lastModifiedMs: number;      // file system mtime in ms
  turnCount: number;           // how many Kind 1 entries seen (= number of completed turns)
}
```

Implementation notes:
- Use `fs.promises.stat`, `fs.promises.open`, `fs.promises.readdir` for all file I/O.
- Track per-file byte offset in a `Map<string, number>` so you only read new bytes on each poll (incremental reads, same technique as FilePoller).
- When a new file appears (watcher fires `onDidCreate`), add it to the map and do a full read.
- When a file changes (watcher fires `onDidChange`), read only new bytes from that file's current offset.
- After each poll cycle where any session updated, fire the `onSessionsChanged` callback.
- When reading a file from scratch (offset=0), parse ALL lines. When reading incrementally, parse only the new chunk (may start mid-line — handle partial lines with a per-file `pendingPartial` string, identical to JsonlParser's approach).
- Detect file deletion/rotation: if `stat.size < offset`, reset that file's offset and re-read from 0.
- Update `lastModifiedMs` from `stat.mtimeMs` on each poll.
- Do NOT crash if `chatSessionsDir` doesn't exist — handle gracefully, log a warning, retry on next poll.

### CHANGE 2: New file `src/parser/vscodeSessionAdapter.ts`

This module converts a `Map<string, VscodeChatSession>` → `AgentSession | null`.

Export one function:
```typescript
export function buildAgentSessionFromVscodeSessions(
  sessions: Map<string, VscodeChatSession>,
  activityWindowMs: number,
  thresholds: Thresholds,
): AgentSession | null
```

Logic:
1. Filter sessions to those modified within `activityWindowMs` milliseconds from now.
2. If no active sessions → return `null`.
3. Sort active sessions ascending by `creationDate`.
4. The **first** (oldest) = main agent. All others = subagents (children of main).
5. Build an `Agent` for each:
   - `agentId` = session's `sessionId`
   - `role` = `'main'` for index 0, `'subagent'` for rest
   - `label` = `"{modelName}"` for main; `"Sub: {modelName} #{i}"` for subagents
   - `status`:
     - `'running'` if last modified within 30 seconds
     - `'waiting'` if last modified within 5 minutes (300_000 ms)
     - `'done'` if older than 5 minutes but within activity window
   - `contextUsage.usedTokens` = `latestPromptTokens`
   - `contextUsage.maxTokens` = `maxInputTokens`
   - `contextUsage.usagePercent` = computed via `computeUsagePercent`
   - `contextUsage.breakdown` = computed from `promptTokenDetails` as follows:
     - `systemPrompt` = round(promptTokens × (sum of percentageOfPrompt for items with label "System Instructions") / 100)
     - `userMessages` = round(promptTokens × (sum% for label "Messages") / 100)
     - `toolResults` = round(promptTokens × (sum% for label "Tool Results") / 100)
     - `fileContext` = round(promptTokens × (sum% for label "Files") / 100)
     - `other` = promptTokens - systemPrompt - userMessages - toolResults - fileContext (remainder)
     - If `promptTokenDetails` is empty, `breakdown` = `undefined`
   - `riskLevel` = computed via `computeRiskLevel`
   - `children` = for main agent: array of subagent `Agent` objects; for subagents: `[]`
   - `lastActivityAt` = new Date(lastModifiedMs).toISOString()
   - `parentAgentId` = for subagents: main agent's `sessionId`
6. Build `AgentSession`:
   - `sessionId` = main agent's `sessionId`
   - `startedAt` = new Date(main session's `creationDate`).toISOString()
   - `lastUpdatedAt` = new Date(Math.max of all active sessions' `lastModifiedMs`).toISOString()
   - `agents` = `[mainAgent]` (mainAgent already has subagents as `children`)
   - `sessionSummary` = `computeSessionSummary([mainAgent])`
   - `status` = `'active'` if any agent is `'running'`, `'idle'` if all `'waiting'`, `'completed'` if all `'done'`, otherwise `'active'`

### CHANGE 3: Update `src/config/settings.ts`

Add `copilot-chat` as a data source option and a new `activityWindowMinutes` setting:

```typescript
export interface ExtensionSettings {
  logFilePath: string;
  dataSource: 'jsonl' | 'copilot-chat';   // ← add 'copilot-chat'
  pollIntervalMs: number;
  activityWindowMinutes: number;           // ← new: minutes of inactivity before a session is dropped from view
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  warningThresholdPercent: number;
  criticalThresholdPercent: number;
  notifyOnCritical: boolean;
  showStatusBar: boolean;
  statusBarMode: 'hottestAgent' | 'sessionSummary';
  webviewRetainContext: boolean;
}
```

In `DEFAULTS`, set:
- `dataSource: 'copilot-chat'`
- `activityWindowMinutes: 60`

In `readSettings()`, add:
```typescript
dataSource: cfg.get<ExtensionSettings['dataSource']>('dataSource', DEFAULTS.dataSource),
activityWindowMinutes: clamp(cfg.get<number>('activityWindowMinutes', DEFAULTS.activityWindowMinutes), 5, 1440),
```

### CHANGE 4: Update `src/extension.ts`

Refactor `activate()` to support both data sources. The key pattern:
- If `settings.dataSource === 'copilot-chat'`: create a `CopilotSessionReader` and use `buildAgentSessionFromVscodeSessions` to convert its output into the `StateStore`.
- If `settings.dataSource === 'jsonl'`: use the existing `FilePoller` + `JsonlParser` as before.
- Both paths feed `store.setState(session)`.
- The `applySettings` function must handle switching between modes (stop old reader, start new one).

**Path derivation for `copilot-chat` mode:**
```typescript
import * as path from 'path';
// context.storageUri.fsPath = .../workspaceStorage/{hash}/agent-context-display
// chatSessionsDir             = .../workspaceStorage/{hash}/chatSessions
const chatSessionsDir = path.join(path.dirname(context.storageUri.fsPath), 'chatSessions');
```

Note: `context.storageUri` may be `undefined` if VS Code hasn't created the storage dir yet. Handle this gracefully: fall back to `'jsonl'` mode with an appropriate tree message if `storageUri` is undefined, log a warning.

Structural approach — use two module-level variables for the active reader:
```typescript
let copilotReader: CopilotSessionReader | undefined;
let jsonlPoller: FilePoller | undefined;
```
In `activate()`, based on `currentSettings.dataSource`, start only the appropriate one.
In `applySettings()`, if `dataSource` changed, stop the old reader and start the new one.
In `deactivate()` / `context.subscriptions`, dispose both.

The `CopilotSessionReader`'s `onSessionsChanged` callback should:
```typescript
copilotReader.onSessionsChanged(sessions => {
  const agentSession = buildAgentSessionFromVscodeSessions(
    sessions,
    currentSettings.activityWindowMinutes * 60_000,
    { warningPercent: currentSettings.warningThresholdPercent, criticalPercent: currentSettings.criticalThresholdPercent }
  );
  store.setState(agentSession);
  if (!agentSession) {
    treeProvider.refresh(null, 'No active Copilot Chat sessions found. Start a chat session to see context usage.');
  }
  if (agentSession && currentSettings.notifyOnCritical) {
    checkCriticalThresholds(agentSession, currentSettings);
  }
});
```

### CHANGE 5: Update `package.json`

In `contributes.configuration.properties`:

1. Update `agentContext.dataSource`:
```json
"agentContext.dataSource": {
  "type": "string",
  "enum": ["copilot-chat", "jsonl"],
  "enumDescriptions": [
    "Automatically read live token usage from VS Code Copilot Chat session files (no configuration needed)",
    "Read from a custom JSONL log file (set agentContext.logFilePath)"
  ],
  "default": "copilot-chat",
  "description": "Data source for agent context usage"
}
```

2. Add `agentContext.activityWindowMinutes`:
```json
"agentContext.activityWindowMinutes": {
  "type": "number",
  "default": 60,
  "minimum": 5,
  "maximum": 1440,
  "description": "Sessions inactive for longer than this many minutes are hidden from the view"
}
```

3. Update `agentContext.logFilePath` description to clarify it is only used when `dataSource` is `jsonl`.

---

## CONSTRAINTS AND QUALITY BARS

1. **TypeScript strict mode** is on. All new code must compile cleanly with `tsc -p ./`. No `any` types unless absolutely unavoidable (use `unknown` instead).
2. **No new npm dependencies** — use only Node.js built-ins (`fs`, `path`) and the VS Code API (`vscode`).
3. **Security**: Never write user data; only read existing files VS Code already created. No network calls.
4. **Error safety**: All file I/O must be in `try/catch`. The reader must never throw uncaught exceptions. If `chatSessionsDir` does not exist, show "Waiting for Copilot Chat session…" in the tree view.
5. **Backward compatibility**: `dataSource: 'jsonl'` must continue to work exactly as before.
6. **No modifications to**: `agentModel.ts`, `jsonlParser.ts`, `filePoller.ts`, `stateStore.ts`, `logger.ts`, or any view files. Only add new files and modify `settings.ts`, `extension.ts`, `package.json`.
7. **Memory**: The reader should not accumulate unbounded state — cap the number of sessions tracked to 50 (drop oldest by creationDate if exceeded).
8. The `CopilotSessionReader` should debounce watcher events by 500ms (same as FilePoller).

---

## EXPECTED BEHAVIOR WHEN DONE

1. Developer opens VS Code with this extension installed.
2. Developer opens GitHub Copilot Chat, selects agent mode, and starts asking questions.
3. Without any configuration, the extension's sidebar TreeView immediately shows:
   - The active session as the **main agent** with its model name as label
   - Token usage: "38k / 272k (14%)" style display
   - Context breakdown in the tooltip (System Instructions, Tool Definitions, Messages, Files, Tool Results)
   - Risk level color-coding (green/warning/critical)
4. If the developer's main agent spawns sub-agents (concurrent sessions started after the main one), those appear as **children** in the tree.
5. Status bar shows "$(pulse) CTX Claude Sonnet 4.6 14%" updating in real time.
6. When a session has been idle for `activityWindowMinutes`, it disappears from the view.
7. if `dataSource` is switched to `jsonl` in settings, the old manual log file behavior is restored.

---

## FILES TO CREATE/MODIFY

| File | Action |
|---|---|
| `src/reader/copilotSessionReader.ts` | CREATE |
| `src/parser/vscodeSessionAdapter.ts` | CREATE |
| `src/config/settings.ts` | MODIFY |
| `src/extension.ts` | MODIFY |
| `package.json` | MODIFY |

Do not create or modify any other files. Do not delete any existing files.

---

## COMPILE CHECK

After implementing, run:
```bash
npm run compile
```
It must exit with code 0 and produce no TypeScript errors. Fix any compilation issues before finishing.

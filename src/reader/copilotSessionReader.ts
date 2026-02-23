import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../util/logger';

const MODULE = 'CopilotSessionReader';
const MAX_CHUNK_BYTES = 10 * 1024 * 1024; // 10 MB safety cap per read
const MAX_SESSIONS = 50;

function extractSubagentCallsFromResponse(
    responseItems: unknown[],
    requestIndex: number,
    promptTokensAtTurn = 0,
): SubagentCall[] {
    const calls: SubagentCall[] = [];
    for (const item of responseItems) {
        if (typeof item !== 'object' || item === null) { continue; }
        const r = item as Record<string, unknown>;
        if (r['kind'] !== 'toolInvocationSerialized') { continue; }
        const td = r['toolSpecificData'];
        if (typeof td !== 'object' || td === null) { continue; }
        const tdo = td as Record<string, unknown>;
        if (tdo['kind'] !== 'subagent') { continue; }
        const toolCallId = typeof r['toolCallId'] === 'string' ? r['toolCallId'] : '';
        if (!toolCallId) { continue; }
        const description = typeof tdo['description'] === 'string' ? tdo['description'] : '';
        const modelName = typeof tdo['modelName'] === 'string' ? tdo['modelName'] : '';
        const isComplete = r['isComplete'] === true;
        calls.push({ toolCallId, description, modelName, isComplete, requestIndex, promptTokensAtTurn });
    }
    return calls;
}

export interface SubagentCall {
    toolCallId: string;
    description: string;
    modelName: string;
    isComplete: boolean;
    requestIndex: number;
    promptTokensAtTurn: number;
}

export interface VscodeChatSession {
    sessionId: string;
    fileName: string;
    creationDate: number;
    modelName: string;
    modelIdentifier: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    latestPromptTokens: number;
    latestCompletionTokens: number;
    promptTokenDetails: Array<{ category: string; label: string; percentageOfPrompt: number }>;
    lastModifiedMs: number;
    turnCount: number;
    subagentCalls: SubagentCall[];
}

interface FileState {
    offset: number;
    pendingPartial: string;
    session: VscodeChatSession | undefined;
    /** Maps toolCallId -> requestIndex for back-filling promptTokensAtTurn */
    subagentRequestIndex: Map<string, number>;
}

export class CopilotSessionReader implements vscode.Disposable {
    private readonly chatSessionsDir: string;
    private pollIntervalMs: number;
    private readonly logger: Logger;

    private fileStates = new Map<string, FileState>();
    private sessions = new Map<string, VscodeChatSession>();

    private watcher: vscode.FileSystemWatcher | undefined;
    private timer: ReturnType<typeof setInterval> | undefined;
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;
    private busy = false;
    private disposed = false;

    private onSessionsChangedCallback: ((sessions: Map<string, VscodeChatSession>) => void) | undefined;

    constructor(chatSessionsDir: string, pollIntervalMs: number, logger: Logger) {
        this.chatSessionsDir = chatSessionsDir;
        this.pollIntervalMs = pollIntervalMs;
        this.logger = logger;
    }

    onSessionsChanged(callback: (sessions: Map<string, VscodeChatSession>) => void): void {
        this.onSessionsChangedCallback = callback;
    }

    getSessions(): Map<string, VscodeChatSession> {
        return new Map(this.sessions);
    }

    start(): void {
        if (this.disposed) { return; }
        this.logger.info(MODULE, `Starting Copilot session reader for: ${this.chatSessionsDir}`);

        try {
            const pattern = new vscode.RelativePattern(vscode.Uri.file(this.chatSessionsDir), '*.jsonl');
            this.watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);

            this.watcher.onDidCreate(() => this.debouncedPoll());
            this.watcher.onDidChange(() => this.debouncedPoll());
            this.watcher.onDidDelete(uri => {
                const fileName = path.basename(uri.fsPath);
                this.fileStates.delete(fileName);
                this.sessions.delete(fileName);
                this.onSessionsChangedCallback?.(this.getSessions());
            });
        } catch (err) {
            this.logger.warn(MODULE, `FileSystemWatcher setup failed, relying on interval polling: ${err}`);
        }

        this.timer = setInterval(() => { void this.poll(); }, this.pollIntervalMs);
        void this.poll();
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = undefined;
        }
        if (this.watcher) {
            this.watcher.dispose();
            this.watcher = undefined;
        }
        this.busy = false;
    }

    reconfigure(pollIntervalMs: number): void {
        this.pollIntervalMs = pollIntervalMs;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = setInterval(() => { void this.poll(); }, this.pollIntervalMs);
        }
    }

    dispose(): void {
        this.disposed = true;
        this.stop();
        this.fileStates.clear();
        this.sessions.clear();
        this.logger.debug(MODULE, 'CopilotSessionReader disposed');
    }

    private debouncedPoll(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => { void this.poll(); }, 500);
    }

    private async poll(): Promise<void> {
        if (this.disposed || this.busy) { return; }
        this.busy = true;

        let anyChanged = false;

        try {
            let dirEntries: string[];
            try {
                const entries = await fs.promises.readdir(this.chatSessionsDir);
                dirEntries = entries.filter(e => e.endsWith('.jsonl'));
            } catch {
                this.logger.debug(MODULE, `Chat sessions directory does not exist: ${this.chatSessionsDir}`);
                if (this.sessions.size > 0) {
                    this.sessions.clear();
                    this.fileStates.clear();
                    anyChanged = true;
                }
                if (anyChanged) {
                    this.onSessionsChangedCallback?.(this.getSessions());
                }
                return;
            }

            // Remove file states for deleted files
            for (const fileName of this.fileStates.keys()) {
                if (!dirEntries.includes(fileName)) {
                    this.fileStates.delete(fileName);
                    this.sessions.delete(fileName);
                    anyChanged = true;
                }
            }

            for (const fileName of dirEntries) {
                const filePath = path.join(this.chatSessionsDir, fileName);
                try {
                    const changed = await this.readFile(fileName, filePath);
                    if (changed) { anyChanged = true; }
                } catch (err) {
                    this.logger.debug(MODULE, `Error reading session file ${fileName}: ${err}`);
                }
            }

            // Enforce MAX_SESSIONS cap
            if (this.sessions.size > MAX_SESSIONS) {
                const sorted = [...this.sessions.entries()]
                    .sort((a, b) => a[1].creationDate - b[1].creationDate);
                const toRemove = sorted.slice(0, sorted.length - MAX_SESSIONS);
                for (const [key] of toRemove) {
                    this.sessions.delete(key);
                    this.fileStates.delete(key);
                }
                anyChanged = true;
            }

            if (anyChanged) {
                this.onSessionsChangedCallback?.(this.getSessions());
            }
        } catch (err) {
            this.logger.error(MODULE, `Poll error: ${err}`);
        } finally {
            this.busy = false;
        }
    }

    private async readFile(fileName: string, filePath: string): Promise<boolean> {
        const stat = await fs.promises.stat(filePath);

        let state = this.fileStates.get(fileName);
        if (!state) {
            state = { offset: 0, pendingPartial: '', session: undefined, subagentRequestIndex: new Map() };
            this.fileStates.set(fileName, state);
        }

        // Detect truncation/rotation
        if (stat.size < state.offset) {
            state.offset = 0;
            state.pendingPartial = '';
            state.session = undefined;
        }

        // Nothing new
        if (stat.size === state.offset) {
            // Still update lastModifiedMs
            if (state.session) {
                const oldMtime = state.session.lastModifiedMs;
                state.session.lastModifiedMs = stat.mtimeMs;
                if (oldMtime !== stat.mtimeMs) {
                    this.sessions.set(fileName, state.session);
                    return true;
                }
            }
            return false;
        }

        const available = stat.size - state.offset;
        const bytesToRead = Math.min(available, MAX_CHUNK_BYTES);

        const buffer = Buffer.alloc(bytesToRead);
        const fh = await fs.promises.open(filePath, 'r');
        try {
            await fh.read(buffer, 0, bytesToRead, state.offset);
        } finally {
            await fh.close();
        }

        state.offset += bytesToRead;
        const chunk = buffer.toString('utf-8');

        // Combine with pending partial line from previous read
        const fullText = state.pendingPartial + chunk;
        const lines = fullText.split('\n');

        // Last element might be incomplete if chunk didn't end with \n
        state.pendingPartial = lines.pop() ?? '';

        let changed = false;
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) { continue; }

            try {
                const parsed: unknown = JSON.parse(trimmed);
                if (typeof parsed !== 'object' || parsed === null || !('kind' in parsed)) {
                    continue;
                }

                const record = parsed as Record<string, unknown>;
                const kind = record['kind'];

                if (kind === 0) {
                    changed = this.processKind0(fileName, record, stat.mtimeMs) || changed;
                } else if (kind === 1) {
                    changed = this.processKind1(fileName, record, stat.mtimeMs) || changed;
                } else if (kind === 2) {
                    changed = this.processKind2(fileName, record, stat.mtimeMs) || changed;
                }
            } catch {
                // Malformed JSON line — skip
                this.logger.debug(MODULE, `Malformed JSON line in ${fileName}`);
            }
        }

        // Update lastModifiedMs even if no kind 0/1 found
        if (state.session) {
            state.session.lastModifiedMs = stat.mtimeMs;
            this.sessions.set(fileName, state.session);
            changed = true;
        }

        return changed;
    }

    private processKind0(fileName: string, record: Record<string, unknown>, mtimeMs: number): boolean {
        const v = record['v'];
        if (typeof v !== 'object' || v === null) { return false; }

        const vObj = v as Record<string, unknown>;
        const sessionId = typeof vObj['sessionId'] === 'string' ? vObj['sessionId'] : '';
        const creationDate = typeof vObj['creationDate'] === 'number' ? vObj['creationDate'] : 0;

        let modelName = '';
        let modelIdentifier = '';
        let maxInputTokens = 0;
        let maxOutputTokens = 0;

        const inputState = vObj['inputState'];
        if (typeof inputState === 'object' && inputState !== null) {
            const is = inputState as Record<string, unknown>;
            const selectedModel = is['selectedModel'];
            if (typeof selectedModel === 'object' && selectedModel !== null) {
                const sm = selectedModel as Record<string, unknown>;
                modelIdentifier = typeof sm['identifier'] === 'string' ? sm['identifier'] : '';
                const metadata = sm['metadata'];
                if (typeof metadata === 'object' && metadata !== null) {
                    const meta = metadata as Record<string, unknown>;
                    modelName = typeof meta['name'] === 'string' ? meta['name'] : '';
                    maxInputTokens = typeof meta['maxInputTokens'] === 'number' ? meta['maxInputTokens'] : 0;
                    maxOutputTokens = typeof meta['maxOutputTokens'] === 'number' ? meta['maxOutputTokens'] : 0;
                }
            }
        }

        // Extract subagent calls from existing requests in the snapshot, seeding
        // promptTokensAtTurn from the request's result.usage if already complete.
        const subagentCallsMap = new Map<string, SubagentCall>();
        const requestIndexMap = new Map<string, number>();
        const requests = vObj['requests'];
        if (Array.isArray(requests)) {
            for (let reqIdx = 0; reqIdx < requests.length; reqIdx++) {
                const req = requests[reqIdx];
                if (typeof req !== 'object' || req === null) { continue; }
                const reqObj = req as Record<string, unknown>;
                // Try to get promptTokens for this turn from the snapshot's result
                let promptTokensAtTurn = 0;
                const result = reqObj['result'];
                if (typeof result === 'object' && result !== null) {
                    const usage = (result as Record<string, unknown>)['usage'];
                    if (typeof usage === 'object' && usage !== null) {
                        const pt = (usage as Record<string, unknown>)['promptTokens'];
                        if (typeof pt === 'number') { promptTokensAtTurn = pt; }
                    }
                }
                const response = reqObj['response'];
                if (!Array.isArray(response)) { continue; }
                for (const call of extractSubagentCallsFromResponse(response, reqIdx, promptTokensAtTurn)) {
                    subagentCallsMap.set(call.toolCallId, call);
                    requestIndexMap.set(call.toolCallId, reqIdx);
                }
            }
        }

        const state = this.fileStates.get(fileName);
        if (!state) { return false; }

        const existing = state.session;
        state.session = {
            sessionId,
            fileName,
            creationDate,
            modelName,
            modelIdentifier,
            maxInputTokens,
            maxOutputTokens,
            latestPromptTokens: existing?.latestPromptTokens ?? 0,
            latestCompletionTokens: existing?.latestCompletionTokens ?? 0,
            promptTokenDetails: existing?.promptTokenDetails ?? [],
            lastModifiedMs: mtimeMs,
            turnCount: existing?.turnCount ?? 0,
            subagentCalls: [...subagentCallsMap.values()],
        };
        // Restore the requestIndexMap for this file
        state.subagentRequestIndex = requestIndexMap;

        this.sessions.set(fileName, state.session);
        return true;
    }

    private processKind2(fileName: string, record: Record<string, unknown>, mtimeMs: number): boolean {
        const state = this.fileStates.get(fileName);
        if (!state || !state.session) { return false; }

        // Only handle response array appends: k = ["requests", N, "response"]
        const k = record['k'];
        if (!Array.isArray(k) || k.length !== 3 || k[0] !== 'requests' || k[2] !== 'response') {
            return false;
        }

        const v = record['v'];
        if (!Array.isArray(v)) { return false; }

        const requestIndex = typeof k[1] === 'number' ? k[1] : -1;
        const newCalls = extractSubagentCallsFromResponse(v, requestIndex);
        if (newCalls.length === 0) { return false; }

        // Record requestIndex for each new call so kind=1 can back-fill tokens later
        for (const call of newCalls) {
            state.subagentRequestIndex.set(call.toolCallId, requestIndex);
        }

        // Merge into existing subagentCalls by toolCallId (later entry wins)
        const callsMap = new Map(state.session.subagentCalls.map(c => [c.toolCallId, c]));
        for (const call of newCalls) {
            callsMap.set(call.toolCallId, call);
        }
        state.session.subagentCalls = [...callsMap.values()];
        state.session.lastModifiedMs = mtimeMs;
        this.sessions.set(fileName, state.session);
        return true;
    }

    private processKind1(fileName: string, record: Record<string, unknown>, mtimeMs: number): boolean {
        const state = this.fileStates.get(fileName);
        if (!state || !state.session) { return false; }

        // Only process turn result entries: k = ["requests", N, "result"]
        const k = record['k'];
        if (!Array.isArray(k) || k.length !== 3 || k[0] !== 'requests' || k[2] !== 'result') {
            return false;
        }

        const v = record['v'];
        if (typeof v !== 'object' || v === null) { return false; }

        const vObj = v as Record<string, unknown>;
        const usage = vObj['usage'];
        if (typeof usage !== 'object' || usage === null) { return false; }

        const usageObj = usage as Record<string, unknown>;
        const promptTokens = typeof usageObj['promptTokens'] === 'number' ? usageObj['promptTokens'] : state.session.latestPromptTokens;
        const completionTokens = typeof usageObj['completionTokens'] === 'number' ? usageObj['completionTokens'] : state.session.latestCompletionTokens;

        let promptTokenDetails: Array<{ category: string; label: string; percentageOfPrompt: number }> = [];
        const rawDetails = usageObj['promptTokenDetails'];
        if (Array.isArray(rawDetails)) {
            promptTokenDetails = rawDetails
                .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
                .map(item => ({
                    category: typeof item['category'] === 'string' ? item['category'] : '',
                    label: typeof item['label'] === 'string' ? item['label'] : '',
                    percentageOfPrompt: typeof item['percentageOfPrompt'] === 'number' ? item['percentageOfPrompt'] : 0,
                }));
        }

        state.session.latestPromptTokens = promptTokens;
        state.session.latestCompletionTokens = completionTokens;
        state.session.promptTokenDetails = promptTokenDetails;
        state.session.lastModifiedMs = mtimeMs;
        state.session.turnCount += 1;

        // Back-fill promptTokensAtTurn for any subagent calls in this turn
        const requestIndex = typeof k[1] === 'number' ? k[1] : -1;
        if (requestIndex >= 0 && promptTokens > 0) {
            let updatedAny = false;
            state.session.subagentCalls = state.session.subagentCalls.map(call => {
                const callReqIdx = state!.subagentRequestIndex.get(call.toolCallId);
                if (callReqIdx === requestIndex && call.promptTokensAtTurn !== promptTokens) {
                    updatedAny = true;
                    return { ...call, promptTokensAtTurn: promptTokens };
                }
                return call;
            });
            if (updatedAny) {
                this.sessions.set(fileName, state.session);
                return true;
            }
        }

        this.sessions.set(fileName, state.session);
        return true;
    }
}

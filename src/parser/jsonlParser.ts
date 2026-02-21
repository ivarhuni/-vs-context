import { RawLogEntry, AgentSession, createSession, Thresholds, MAX_AGENT_DEPTH } from '../model/agentModel';
import { Logger } from '../util/logger';

const SUPPORTED_VERSION = 1;
const MODULE = 'JsonlParser';

export interface ParseResult {
  sessions: Map<string, AgentSession>;
  malformedLineCount: number;
}

const MAX_DEDUP_KEYS = 10000;
const MAX_SESSIONS = 100;

export class JsonlParser {
  private pendingPartialLine: string = '';
  private seenKeys = new Set<string>();
  private latestTsPerSession = new Map<string, string>();
  private sessions = new Map<string, AgentSession>();
  private malformedLineCount = 0;
  private logger: Logger;
  private thresholds: Thresholds;

  constructor(logger: Logger, thresholds: Thresholds = { warningPercent: 70, criticalPercent: 85 }) {
    this.logger = logger;
    this.thresholds = thresholds;
  }

  setThresholds(thresholds: Thresholds): void {
    this.thresholds = thresholds;
  }

  reset(): void {
    this.pendingPartialLine = '';
    this.seenKeys.clear();
    this.latestTsPerSession.clear();
    this.sessions.clear();
    this.malformedLineCount = 0;
  }

  getMalformedLineCount(): number {
    return this.malformedLineCount;
  }

  getSessions(): Map<string, AgentSession> {
    return new Map(this.sessions);
  }

  getLatestSession(): AgentSession | null {
    let latest: AgentSession | null = null;
    for (const session of this.sessions.values()) {
      if (!latest || session.lastUpdatedAt > latest.lastUpdatedAt) {
        latest = session;
      }
    }
    return latest;
  }

  parseChunk(chunk: string): ParseResult {
    const text = this.pendingPartialLine + chunk;
    const lines = text.split('\n');

    this.pendingPartialLine = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) { continue; }
      this.parseLine(trimmed);
    }

    return {
      sessions: this.getSessions(),
      malformedLineCount: this.malformedLineCount,
    };
  }

  parseFullText(text: string): ParseResult {
    this.reset();
    return this.parseChunk(text + '\n');
  }

  private parseLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.malformedLineCount++;
      this.logger.warn(MODULE, `Malformed JSON line skipped (total: ${this.malformedLineCount})`);
      return;
    }

    if (!this.isValidEntry(parsed)) {
      return;
    }

    const entry = parsed as RawLogEntry;

    if (entry.v > SUPPORTED_VERSION) {
      this.logger.warn(MODULE, `Unsupported log version ${entry.v} (supported: ${SUPPORTED_VERSION}). Please update the extension.`);
      return;
    }

    const dedupKey = `${entry.sessionId}:${entry.ts}`;
    if (this.seenKeys.has(dedupKey)) {
      return;
    }
    this.seenKeys.add(dedupKey);

    if (this.seenKeys.size > MAX_DEDUP_KEYS) {
      const iter = this.seenKeys.values();
      for (let i = 0; i < MAX_DEDUP_KEYS / 2; i++) {
        const val = iter.next().value;
        if (val !== undefined) { this.seenKeys.delete(val); }
      }
    }

    const latestTs = this.latestTsPerSession.get(entry.sessionId);
    if (latestTs && entry.ts < latestTs) {
      this.logger.warn(MODULE, `Out-of-order timestamp for session ${entry.sessionId}: ${entry.ts} < ${latestTs}. Line discarded.`);
      return;
    }
    this.latestTsPerSession.set(entry.sessionId, entry.ts);

    const session = createSession(entry, this.thresholds);

    const existing = this.sessions.get(entry.sessionId);
    if (existing) {
      session.startedAt = existing.startedAt;
    }

    this.sessions.set(entry.sessionId, session);

    if (this.sessions.size > MAX_SESSIONS) {
      this.evictOldestSessions();
    }
  }

  private evictOldestSessions(): void {
    const sorted = [...this.sessions.entries()]
      .sort((a, b) => a[1].lastUpdatedAt.localeCompare(b[1].lastUpdatedAt));
    const toRemove = sorted.slice(0, sorted.length - MAX_SESSIONS);
    for (const [id] of toRemove) {
      this.sessions.delete(id);
      this.latestTsPerSession.delete(id);
    }
  }

  private isValidEntry(obj: unknown): obj is RawLogEntry {
    if (typeof obj !== 'object' || obj === null) {
      this.malformedLineCount++;
      this.logger.warn(MODULE, 'Parsed JSON is not an object');
      return false;
    }

    const record = obj as Record<string, unknown>;

    if (typeof record['v'] !== 'number') {
      this.malformedLineCount++;
      this.logger.warn(MODULE, 'Missing or invalid "v" field');
      return false;
    }

    if (typeof record['ts'] !== 'string') {
      this.malformedLineCount++;
      this.logger.warn(MODULE, 'Missing or invalid "ts" field');
      return false;
    }

    if (typeof record['sessionId'] !== 'string' || record['sessionId'] === '') {
      this.malformedLineCount++;
      this.logger.warn(MODULE, 'Missing or invalid "sessionId" field');
      return false;
    }

    if (!Array.isArray(record['agents'])) {
      this.malformedLineCount++;
      this.logger.warn(MODULE, 'Missing or invalid "agents" field');
      return false;
    }

    const agents = record['agents'] as unknown[];
    for (const agent of agents) {
      if (!this.isValidAgentShape(agent)) {
        this.malformedLineCount++;
        this.logger.warn(MODULE, 'Agent entry failed structural validation');
        return false;
      }
    }

    return true;
  }

  private isValidAgentShape(obj: unknown, depth: number = 0): boolean {
    if (depth > MAX_AGENT_DEPTH) { return false; }
    if (typeof obj !== 'object' || obj === null) { return false; }
    const a = obj as Record<string, unknown>;
    if (typeof a['agentId'] !== 'string' || a['agentId'] === '') { return false; }
    if (typeof a['context'] !== 'object' || a['context'] === null) { return false; }
    if (Array.isArray(a['children'])) {
      for (const child of a['children'] as unknown[]) {
        if (!this.isValidAgentShape(child, depth + 1)) { return false; }
      }
    }
    return true;
  }
}

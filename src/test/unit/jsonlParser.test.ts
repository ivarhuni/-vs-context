import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { JsonlParser } from '../../parser/jsonlParser';

const fixturesDir = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures');

function makeLogger(): import('../../util/logger').Logger {
  const logs: string[] = [];
  return {
    debug: (_m: string, msg: string) => logs.push(`DEBUG: ${msg}`),
    info: (_m: string, msg: string) => logs.push(`INFO: ${msg}`),
    warn: (_m: string, msg: string) => logs.push(`WARN: ${msg}`),
    error: (_m: string, msg: string) => logs.push(`ERROR: ${msg}`),
    setLevel: () => {},
    getLevel: () => 'debug' as const,
    show: () => {},
    dispose: () => {},
    _logs: logs,
  } as unknown as import('../../util/logger').Logger & { _logs: string[] };
}

describe('JsonlParser', () => {
  let parser: JsonlParser;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    logger = makeLogger();
    parser = new JsonlParser(logger);
  });

  describe('parseFullText', () => {
    it('parses valid single agent', () => {
      const text = fs.readFileSync(path.join(fixturesDir, 'valid-single-agent.jsonl'), 'utf-8');
      const result = parser.parseFullText(text);
      assert.strictEqual(result.sessions.size, 1);
      const session = result.sessions.get('sess-001')!;
      assert.strictEqual(session.sessionId, 'sess-001');
      assert.strictEqual(session.agents.length, 1);
      assert.strictEqual(session.agents[0].agentId, 'main-1');
      assert.strictEqual(session.agents[0].children.length, 0);
      assert.strictEqual(session.agents[0].contextUsage.usedTokens, 45000);
      assert.strictEqual(result.malformedLineCount, 0);
    });

    it('parses valid multi agent with subagents', () => {
      const text = fs.readFileSync(path.join(fixturesDir, 'valid-multi-agent.jsonl'), 'utf-8');
      const result = parser.parseFullText(text);
      const session = result.sessions.get('sess-002')!;
      assert.strictEqual(session.agents[0].children.length, 2);
      assert.strictEqual(session.agents[0].children[0].label, 'Researcher');
      assert.strictEqual(session.agents[0].children[1].label, 'Coder');
    });

    it('parses multi-line, latest wins', () => {
      const text = fs.readFileSync(path.join(fixturesDir, 'multi-line.jsonl'), 'utf-8');
      const result = parser.parseFullText(text);
      const session = result.sessions.get('sess-003')!;
      assert.strictEqual(session.lastUpdatedAt, '2026-02-21T10:02:00.000Z');
      assert.strictEqual(session.agents[0].contextUsage.usedTokens, 55000);
      assert.strictEqual(session.startedAt, '2026-02-21T10:00:00.000Z');
    });

    it('handles malformed lines', () => {
      const text = fs.readFileSync(path.join(fixturesDir, 'malformed.jsonl'), 'utf-8');
      const result = parser.parseFullText(text);
      assert.strictEqual(result.malformedLineCount, 2);
      assert.strictEqual(result.sessions.size, 1);
      const session = result.sessions.get('sess-004')!;
      assert.strictEqual(session.agents[0].contextUsage.usedTokens, 20000);
    });

    it('handles empty string input', () => {
      const result = parser.parseFullText('');
      assert.strictEqual(result.sessions.size, 0);
      assert.strictEqual(result.malformedLineCount, 0);
      assert.strictEqual(parser.getLatestSession(), null);
    });

    it('rejects unsupported version', () => {
      const text = fs.readFileSync(path.join(fixturesDir, 'unsupported-version.jsonl'), 'utf-8');
      const result = parser.parseFullText(text);
      assert.strictEqual(result.sessions.size, 0);
      const logs = (logger as unknown as { _logs: string[] })._logs;
      assert.ok(logs.some(l => l.includes('Unsupported log version')));
    });

    it('rejects missing required fields', () => {
      const result = parser.parseFullText('{"v":1,"ts":"2026-02-21T10:00:00.000Z"}\n');
      assert.strictEqual(result.sessions.size, 0);
      assert.strictEqual(result.malformedLineCount, 1);
    });

    it('handles extremely large token counts', () => {
      const line = `{"v":1,"ts":"2026-02-21T10:00:00.000Z","sessionId":"big","agents":[{"agentId":"a","role":"main","label":"Big","status":"running","context":{"usedTokens":${Number.MAX_SAFE_INTEGER},"maxTokens":${Number.MAX_SAFE_INTEGER}},"children":[]}]}`;
      const result = parser.parseFullText(line);
      const session = result.sessions.get('big')!;
      assert.ok(Number.isFinite(session.agents[0].contextUsage.usagePercent));
    });
  });

  describe('deduplication', () => {
    it('drops duplicate (sessionId, ts) tuples', () => {
      const line = '{"v":1,"ts":"2026-02-21T10:00:00.000Z","sessionId":"dup","agents":[{"agentId":"a","role":"main","label":"A","status":"running","context":{"usedTokens":1000,"maxTokens":128000},"children":[]}]}';
      const text = line + '\n' + line + '\n';
      const result = parser.parseFullText(text);
      assert.strictEqual(result.sessions.size, 1);
    });

    it('drops out-of-order timestamps within same session', () => {
      const line1 = '{"v":1,"ts":"2026-02-21T10:01:00.000Z","sessionId":"oot","agents":[{"agentId":"a","role":"main","label":"A","status":"running","context":{"usedTokens":2000,"maxTokens":128000},"children":[]}]}';
      const line2 = '{"v":1,"ts":"2026-02-21T10:00:00.000Z","sessionId":"oot","agents":[{"agentId":"a","role":"main","label":"A","status":"running","context":{"usedTokens":1000,"maxTokens":128000},"children":[]}]}';
      const result = parser.parseFullText(line1 + '\n' + line2 + '\n');
      const session = result.sessions.get('oot')!;
      assert.strictEqual(session.agents[0].contextUsage.usedTokens, 2000);
    });

    it('allows interleaved sessions with independent timestamps', () => {
      const a1 = '{"v":1,"ts":"2026-02-21T10:00:00.000Z","sessionId":"A","agents":[{"agentId":"a","role":"main","label":"A","status":"running","context":{"usedTokens":1000,"maxTokens":128000},"children":[]}]}';
      const b1 = '{"v":1,"ts":"2026-02-21T09:00:00.000Z","sessionId":"B","agents":[{"agentId":"b","role":"main","label":"B","status":"running","context":{"usedTokens":2000,"maxTokens":128000},"children":[]}]}';
      const result = parser.parseFullText(a1 + '\n' + b1 + '\n');
      assert.strictEqual(result.sessions.size, 2);
    });
  });

  describe('parseChunk (incremental/partial-line handling)', () => {
    it('handles partial trailing line in chunk 1, completed in chunk 2', () => {
      const fullLine = '{"v":1,"ts":"2026-02-21T10:00:00.000Z","sessionId":"partial","agents":[{"agentId":"a","role":"main","label":"P","status":"running","context":{"usedTokens":5000,"maxTokens":128000},"children":[]}]}';
      const half1 = fullLine.substring(0, 50);
      const half2 = fullLine.substring(50) + '\n';

      const r1 = parser.parseChunk(half1);
      assert.strictEqual(r1.sessions.size, 0);
      assert.strictEqual(r1.malformedLineCount, 0);

      const r2 = parser.parseChunk(half2);
      assert.strictEqual(r2.sessions.size, 1);
      assert.strictEqual(r2.malformedLineCount, 0);
    });

    it('partial line does not increment malformed count', () => {
      parser.parseChunk('{"v":1,"ts":"2026');
      assert.strictEqual(parser.getMalformedLineCount(), 0);
    });

    it('accumulates across multiple chunks', () => {
      const line1 = '{"v":1,"ts":"2026-02-21T10:00:00.000Z","sessionId":"acc","agents":[{"agentId":"a","role":"main","label":"Acc","status":"running","context":{"usedTokens":1000,"maxTokens":128000},"children":[]}]}';
      const line2 = '{"v":1,"ts":"2026-02-21T10:01:00.000Z","sessionId":"acc","agents":[{"agentId":"a","role":"main","label":"Acc","status":"running","context":{"usedTokens":2000,"maxTokens":128000},"children":[]}]}';

      parser.parseChunk(line1 + '\n');
      const r2 = parser.parseChunk(line2 + '\n');
      const session = r2.sessions.get('acc')!;
      assert.strictEqual(session.agents[0].contextUsage.usedTokens, 2000);
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      const line = '{"v":1,"ts":"2026-02-21T10:00:00.000Z","sessionId":"rst","agents":[{"agentId":"a","role":"main","label":"R","status":"running","context":{"usedTokens":1000,"maxTokens":128000},"children":[]}]}';
      parser.parseChunk(line + '\n');
      assert.strictEqual(parser.getLatestSession()?.sessionId, 'rst');

      parser.reset();
      assert.strictEqual(parser.getLatestSession(), null);
      assert.strictEqual(parser.getMalformedLineCount(), 0);
    });
  });
});

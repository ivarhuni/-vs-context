import * as assert from 'assert';
import { JsonlParser } from '../../parser/jsonlParser';

function makeLogger(): import('../../util/logger').Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    setLevel: () => {},
    getLevel: () => 'debug' as const,
    show: () => {},
    dispose: () => {},
  } as unknown as import('../../util/logger').Logger;
}

describe('JsonlParser dedup key pruning', () => {
  it('prunes dedup keys when exceeding limit without losing parse ability', () => {
    const logger = makeLogger();
    const parser = new JsonlParser(logger);

    const lines: string[] = [];
    for (let i = 0; i < 12000; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
      lines.push(`{"v":1,"ts":"${ts}","sessionId":"stress","agents":[{"agentId":"a","role":"main","label":"A","status":"running","context":{"usedTokens":${i},"maxTokens":128000},"children":[]}]}`);
    }

    const result = parser.parseFullText(lines.join('\n'));
    assert.strictEqual(result.sessions.size, 1);
    const session = result.sessions.get('stress')!;
    assert.strictEqual(session.agents[0].contextUsage.usedTokens, 11999);
    assert.strictEqual(result.malformedLineCount, 0);
  });
});

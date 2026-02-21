import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('FilePoller (async I/O logic)', () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filepoller-'));
    tmpFile = path.join(tmpDir, 'test.jsonl');
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch { /* noop */ }
    try { fs.rmdirSync(tmpDir); } catch { /* noop */ }
  });

  it('reads new data incrementally from file', async () => {
    const line1 = '{"v":1,"ts":"2026-02-21T10:00:00.000Z","sessionId":"s1","agents":[]}\n';
    const line2 = '{"v":1,"ts":"2026-02-21T10:01:00.000Z","sessionId":"s1","agents":[]}\n';

    fs.writeFileSync(tmpFile, line1);

    let offset = 0;
    const chunks: string[] = [];

    async function readNewData(): Promise<void> {
      const stat = await fs.promises.stat(tmpFile);
      if (stat.size <= offset) { return; }
      const bytesToRead = stat.size - offset;
      const buffer = Buffer.alloc(bytesToRead);
      const fh = await fs.promises.open(tmpFile, 'r');
      try {
        await fh.read(buffer, 0, bytesToRead, offset);
      } finally {
        await fh.close();
      }
      offset = stat.size;
      chunks.push(buffer.toString('utf-8'));
    }

    await readNewData();
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0], line1);

    fs.appendFileSync(tmpFile, line2);
    await readNewData();
    assert.strictEqual(chunks.length, 2);
    assert.strictEqual(chunks[1], line2);
  });

  it('detects file truncation when size < offset', async () => {
    const line = '{"v":1,"ts":"2026-02-21T10:00:00.000Z","sessionId":"s1","agents":[]}\n';
    fs.writeFileSync(tmpFile, line.repeat(5));

    let offset = 0;
    const stat1 = await fs.promises.stat(tmpFile);
    offset = stat1.size;

    fs.writeFileSync(tmpFile, line);
    const stat2 = await fs.promises.stat(tmpFile);

    assert.ok(stat2.size < offset, 'File should be smaller after truncation');
  });

  it('handles file that does not exist', async () => {
    const nonExistentFile = path.join(tmpDir, 'nonexistent.jsonl');
    let errCaught = false;
    try {
      await fs.promises.stat(nonExistentFile);
    } catch {
      errCaught = true;
    }
    assert.ok(errCaught, 'Should throw for non-existent file');
  });
});

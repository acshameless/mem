import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readBlob, storeBlob } from '../src/core/blobs.ts';
import { ingestSessionDir } from '../src/ingest/sessions.ts';
import { openDb } from '../src/store/db.ts';

test('large tool results go to blob storage', () => {
  const home = mkdtempSync(join(tmpdir(), 'mem-blob-'));
  const previous = process.env.MEM_HOME;
  process.env.MEM_HOME = home;
  try {
    const db = openDb(join(home, 'db', 'memory.db'));
    const big = 'x'.repeat(20000);
    const blob = storeBlob(db, big);
    assert.equal(readBlob(blob.hash), big);
    assert.equal(
      (db.prepare('SELECT size FROM blobs WHERE hash = ?').get(blob.hash) as { size: number }).size,
      Buffer.byteLength(big)
    );

    const sessionDir = join(home, 'sessions', 'blob_session');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, 'blob_session.json'),
      JSON.stringify({ session_id: 'blob_session', source: 'test', status: 'idle' })
    );
    writeFileSync(
      join(sessionDir, 'blob_session.messages.json'),
      JSON.stringify({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_1', name: 'run_commands', input: {} }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_1', name: 'run_commands', content: big }],
          },
        ],
      })
    );
    assert.equal(ingestSessionDir(db, sessionDir), true);
    const call = db
      .prepare('SELECT blob_hash, length(result_text) len FROM tool_calls WHERE session_id = ?')
      .get('blob_session') as { blob_hash: string | null; len: number };
    assert.ok(call.blob_hash, 'tool call must reference a blob');
    assert.ok(call.len < big.length, 'preview must be truncated');
    assert.equal(readBlob(call.blob_hash!), big);
    assert.match(readFileSync(join(home, 'blobs', `${call.blob_hash}.txt`), 'utf8'), /^x+$/);
    db.close();
  } finally {
    if (previous === undefined) delete process.env.MEM_HOME;
    else process.env.MEM_HOME = previous;
  }
});

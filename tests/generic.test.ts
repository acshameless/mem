import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { searchTurns } from '../src/core/recall.ts';
import { ingestGenericDir } from '../src/ingest/generic.ts';
import { openDb } from '../src/store/db.ts';

test('generic jsonl adapter ingests foreign conversations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-generic-'));
  const db = openDb(join(dir, 'memory.db'));
  const file = join(dir, 'generic-session.jsonl');
  writeFileSync(
    file,
    [
      JSON.stringify({ role: 'user', content: '帮我设计一个缓存层', ts: '2026-10-07T01:00:00Z' }),
      JSON.stringify({ role: 'assistant', content: '可以用 LRU 加 TTL', ts: '2026-10-07T01:00:05Z' }),
    ].join('\n')
  );

  const sessions = ingestGenericDir(db, dir);
  assert.equal(sessions, 1);
  const row = db
    .prepare(`SELECT source, prompt FROM sessions WHERE session_id = 'generic-session'`)
    .get() as { source: string; prompt: string };
  assert.equal(row.source, 'generic');
  assert.match(row.prompt, /缓存层/);

  const hits = searchTurns(db, '缓存层', { limit: 5 });
  assert.ok(hits.length > 0, 'generic content must be searchable');

  const again = ingestGenericDir(db, dir);
  assert.equal(again, 1);
  const turns = (db.prepare('SELECT count(*) c FROM turns').get() as { c: number }).c;
  assert.equal(turns, 2, 're-ingest must be idempotent');
  db.close();
});

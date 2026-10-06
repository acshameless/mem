import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ingestInjectionFile } from '../src/ingest/injections.ts';
import { openDb } from '../src/store/db.ts';

test('injection metrics ingest deduplicates records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-inject-'));
  const db = openDb(join(dir, 'memory.db'));
  const file = join(dir, 'injections.jsonl');
  const record = {
    ts: '2026-10-07T01:00:00.000Z',
    task_id: 'conv_1',
    session_id: 'session_1',
    sections: ['taste', 'past'],
    unit_ids: [5],
    cards: 2,
    turns: 3,
    chars: 1234,
  };
  writeFileSync(file, `${JSON.stringify(record)}\n${JSON.stringify(record)}\n`);

  const first = ingestInjectionFile(db, file);
  assert.equal(first, 1, 'duplicate lines must collapse');
  const second = ingestInjectionFile(db, file);
  assert.equal(second, 0, 're-ingest must be idempotent');

  const row = db
    .prepare('SELECT count(*) c, sum(chars) chars FROM injections')
    .get() as { c: number; chars: number };
  assert.equal(row.c, 1);
  assert.equal(row.chars, 1234);
  db.close();
});

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDb } from '../src/store/db.ts';
import { correlateSessions } from '../src/ingest/correlate.ts';
import { ingestHookFile } from '../src/ingest/hooks.ts';
import { ingestSessionDir } from '../src/ingest/sessions.ts';
import { mergeHookToolDurations } from '../src/ingest/tool_durations.ts';
import { searchTurns } from '../src/core/recall.ts';
import { searchCards } from '../src/core/recall.ts';
import { generateSessionCards } from '../src/ingest/cards.ts';

const FIXTURES = 'tests/fixtures/phase0';

test('ingest hook events, sessions, and correlation', () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'mem-test-')), 'memory.db'));

  const events = ingestHookFile(db, join(FIXTURES, 'hooks/2026-10-06.jsonl'));
  assert.equal(events, 21);

  assert.equal(ingestSessionDir(db, join(FIXTURES, 'session')), true);
  assert.equal(ingestSessionDir(db, join(FIXTURES, 'session-tools')), true);
  assert.equal(ingestSessionDir(db, join(FIXTURES, 'session-project')), true);

  const sessions = (db.prepare('SELECT count(*) c FROM sessions').get() as { c: number }).c;
  assert.equal(sessions, 3);

  const turns = (db.prepare('SELECT count(*) c FROM turns').get() as { c: number }).c;
  assert.ok(turns >= 12, `expected at least 12 turns, got ${turns}`);

  const tools = (db.prepare('SELECT count(*) c FROM tool_calls').get() as { c: number }).c;
  assert.ok(tools >= 6, `expected at least 6 tool calls, got ${tools}`);

  const okTools = (db.prepare('SELECT count(*) c FROM tool_calls WHERE success = 1').get() as { c: number }).c;
  assert.equal(okTools, tools, 'all fixture tool calls must be marked successful');

  const linked = correlateSessions(db);
  assert.equal(linked, 3);

  const merged = mergeHookToolDurations(db);
  assert.equal(merged, 6);
  const missing = (
    db.prepare('SELECT count(*) c FROM tool_calls WHERE duration_ms IS NULL').get() as { c: number }
  ).c;
  assert.equal(missing, 0, 'all tool calls must receive hook durations');

  const hit = db
    .prepare(
      `SELECT t.session_id FROM turns_fts
       JOIN turns t ON t.id = turns_fts.rowid
       WHERE turns_fts MATCH 'nonce' LIMIT 1`
    )
    .get() as { session_id: string } | undefined;
  assert.ok(hit, 'FTS search must find the nonce');

  const cjk = searchTurns(db, '请原样输出', { limit: 5 });
  assert.ok(cjk.length > 0, 'segmented index must match Chinese phrases');

  const cards = generateSessionCards(db);
  assert.ok(cards >= 3, `expected session cards, got ${cards}`);
  const projectCard = db
    .prepare(`SELECT goal FROM session_cards WHERE session_id = '1791295188490_6mnpx'`)
    .get() as { goal: string } | undefined;
  assert.ok(projectCard?.goal.includes('sample-prompt'), 'card goal must describe the task');
  const cardHits = searchCards(db, '请原样输出', { limit: 3 });
  assert.ok(cardHits.length > 0, 'card search must match Chinese phrases');
  db.close();
});

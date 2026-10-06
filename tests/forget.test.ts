import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { forgetSession, forgetUnit, isForgotten } from '../src/core/forget.ts';
import { findSimilarUnit, insertUnit } from '../src/core/units.ts';
import { ingestSessionDir } from '../src/ingest/sessions.ts';
import { openDb } from '../src/store/db.ts';

const FIXTURE = 'tests/fixtures/phase0/session-project';
const SESSION_ID = '1791295188490_6mnpx';

test('forget session removes derived data, raw lines, and blocks re-ingest', () => {
  const home = mkdtempSync(join(tmpdir(), 'mem-forget-'));
  const previous = process.env.MEM_HOME;
  process.env.MEM_HOME = home;
  try {
    const db = openDb(join(home, 'db', 'memory.db'));
    assert.equal(ingestSessionDir(db, FIXTURE), true);
    db.prepare('UPDATE sessions SET hook_task_id = ? WHERE session_id = ?').run('conv_forget_a', SESSION_ID);
    db.prepare(
      `INSERT INTO injections (dedupe_key, ts, task_id, session_id, sections_json, unit_ids_json, cards, turns, chars)
       VALUES ('k1', '2026-10-07T01:00:00Z', 'conv_forget_a', ?, '[]', '[]', 0, 0, 0)`
    ).run(SESSION_ID);
    const candidateId = insertUnit(db, {
      type: 'taste',
      statement: '待删除的候选记忆',
      status: 'candidate',
      sourceSession: SESSION_ID,
    });

    const rawDir = join(home, 'raw', 'hooks');
    const rawFile = join(rawDir, '2026-10-07.jsonl');
    mkdirSync(rawDir, { recursive: true });
    appendFileSync(rawFile, `${JSON.stringify({ event: 'TaskStart', payload: { taskId: 'conv_forget_a' } })}\n`);
    appendFileSync(rawFile, `${JSON.stringify({ event: 'TaskStart', payload: { taskId: 'conv_keep_b' } })}\n`);

    const result = forgetSession(db, SESSION_ID, { includeActive: false });
    assert.equal(result.hookTaskId, 'conv_forget_a');
    assert.equal(result.hookLinesRemoved, 1);
    assert.equal(isForgotten(db, 'session', SESSION_ID), true);
    assert.equal(isForgotten(db, 'task', 'conv_forget_a'), true);
    assert.equal(
      (db.prepare('SELECT count(*) c FROM memory_units WHERE id = ?').get(candidateId) as { c: number }).c,
      0
    );
    assert.equal(
      (db.prepare('SELECT count(*) c FROM sessions WHERE session_id = ?').get(SESSION_ID) as { c: number }).c,
      0
    );
    const raw = readFileSync(rawFile, 'utf8');
    assert.doesNotMatch(raw, /conv_forget_a/);
    assert.match(raw, /conv_keep_b/);
    assert.equal(ingestSessionDir(db, FIXTURE), false, 'forgotten sessions must not re-ingest');
    db.close();
  } finally {
    if (previous === undefined) delete process.env.MEM_HOME;
    else process.env.MEM_HOME = previous;
  }
});

test('forget unit deletes content and blocks the same statement', () => {
  const home = mkdtempSync(join(tmpdir(), 'mem-forget-unit-'));
  const previous = process.env.MEM_HOME;
  process.env.MEM_HOME = home;
  try {
    const db = openDb(join(home, 'db', 'memory.db'));
    const id = insertUnit(db, {
      type: 'taste',
      statement: '不要再记住这条偏好',
      status: 'active',
    });
    const statement = forgetUnit(db, id);
    assert.equal(statement, '不要再记住这条偏好');
    assert.equal(
      (db.prepare('SELECT count(*) c FROM memory_units WHERE id = ?').get(id) as { c: number }).c,
      0
    );
    assert.equal(findSimilarUnit(db, '不要再记住这条偏好'), -1);
    db.close();
  } finally {
    if (previous === undefined) delete process.env.MEM_HOME;
    else process.env.MEM_HOME = previous;
  }
});

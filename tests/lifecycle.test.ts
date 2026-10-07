import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { updateSessionLifecycle } from '../src/ingest/lifecycle.ts';
import { openDb } from '../src/store/db.ts';

test('session lifecycle classifies completed, cancelled, failed and unknown aborts', () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'mem-lifecycle-')), 'memory.db'));
  const insertSession = db.prepare(
    `INSERT INTO sessions (session_id, hook_task_id, status, updated_at)
     VALUES (?, ?, ?, ?)`
  );
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  insertSession.run('s_completed', 'conv_a', 'idle', now);
  insertSession.run('s_cancelled', 'conv_b', 'idle', now);
  insertSession.run('s_failed', 'conv_c', 'failed', now);
  insertSession.run('s_aborted', 'conv_d', 'idle', old);
  insertSession.run('s_progress', 'conv_e', 'idle', now);

  const insertEvent = db.prepare(
    `INSERT INTO hook_events (dedupe_key, event, task_id, payload_json) VALUES (?, ?, ?, '{}')`
  );
  for (const [key, event, task] of [
    ['k1', 'TaskStart', 'conv_a'],
    ['k2', 'TaskComplete', 'conv_a'],
    ['k3', 'TaskStart', 'conv_b'],
    ['k4', 'TaskCancel', 'conv_b'],
    ['k5', 'TaskStart', 'conv_c'],
    ['k6', 'TaskStart', 'conv_d'],
    ['k7', 'TaskStart', 'conv_e'],
  ] as Array<[string, string, string]>) {
    insertEvent.run(key, event, task);
  }

  assert.ok(updateSessionLifecycle(db) >= 5);
  const lifecycle = (id: string) =>
    (db.prepare('SELECT lifecycle FROM sessions WHERE session_id = ?').get(id) as {
      lifecycle: string;
    }).lifecycle;
  assert.equal(lifecycle('s_completed'), 'completed');
  assert.equal(lifecycle('s_cancelled'), 'cancelled');
  assert.equal(lifecycle('s_failed'), 'failed');
  assert.equal(lifecycle('s_aborted'), 'aborted_unknown');
  assert.equal(lifecycle('s_progress'), 'in_progress');
  db.close();
});

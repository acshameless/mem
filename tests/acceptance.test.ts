import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifySession } from '../src/acceptance/run.ts';
import { openDb } from '../src/store/db.ts';

function seed(db: ReturnType<typeof openDb>, marker: string, injected: boolean): void {
  const dir = mkdtempSync(join(tmpdir(), 'mem-accept-'));
  const messagesPath = join(dir, 'messages.json');
  writeFileSync(
    messagesPath,
    JSON.stringify({
      messages: injected
        ? [{ role: 'user', metadata: { displayRole: 'system' }, content: [{ type: 'text', text: '<hook_context><memory/></hook_context>' }] }]
        : [],
    })
  );
  db.prepare(
    `INSERT INTO sessions (session_id, hook_task_id, prompt, messages_path, lifecycle)
     VALUES (?, ?, ?, ?, 'completed')`
  ).run(`s_${marker}`, `conv_${marker}`, `${marker} 请回复 OK`, messagesPath);
  for (const [key, event] of [['k1', 'TaskStart'], ['k2', 'TaskComplete']] as Array<[string, string]>) {
    db.prepare(
      `INSERT INTO hook_events (dedupe_key, event, task_id, payload_json) VALUES (?, ?, ?, '{}')`
    ).run(`${marker}-${key}`, event, `conv_${marker}`);
  }
  db.prepare(
    `INSERT INTO turns (session_id, turn_index, block_index, role, kind, text)
     VALUES (?, 0, 0, 'user', 'text', 'request')`
  ).run(`s_${marker}`);
  db.prepare(
    `INSERT INTO turns (session_id, turn_index, block_index, role, kind, text)
     VALUES (?, 1, 0, 'assistant', 'text', 'OK')`
  ).run(`s_${marker}`);
}

test('acceptance verifier passes a good session and fails a missing injection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-accept-db-'));
  const db = openDb(join(dir, 'memory.db'));
  seed(db, 'GOOD', true);
  const good = verifySession(db, 'GOOD');
  assert.equal(good.find((step) => step.id === 'injection')!.status, 'pass');
  assert.equal(good.find((step) => step.id === 'session')!.status, 'pass');

  seed(db, 'NOINJECT', false);
  const bad = verifySession(db, 'NOINJECT');
  assert.equal(bad.find((step) => step.id === 'injection')!.status, 'fail');
  db.close();
});

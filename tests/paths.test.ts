import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { listPaths, rebuildPaths, scoreSession } from '../src/core/trajectory.ts';
import { openDb } from '../src/store/db.ts';

function session(db: ReturnType<typeof openDb>, id: string, lifecycle: string): void {
  db.prepare(
    `INSERT INTO sessions (session_id, prompt, lifecycle, status, started_at)
     VALUES (?, '帮我部署项目到生产环境', ?, 'idle', '2026-10-07T01:00:00Z')`
  ).run(id, lifecycle);
  db.prepare(
    `INSERT INTO turns (session_id, turn_index, block_index, role, kind, text)
     VALUES (?, 0, 0, 'user', 'text', '帮我部署项目到生产环境')`
  ).run(id);
}

function tool(db: ReturnType<typeof openDb>, id: string, name: string, success: number): void {
  db.prepare(
    `INSERT INTO tool_calls (session_id, turn_index, tool_call_id, tool_name, success)
     VALUES (?, 0, ?, ?, ?)`
  ).run(id, `${id}-${name}-${success}-${Math.random()}`, name, success);
}

test('path scoring selects the successful trajectory and feeds skill drafts', () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'mem-paths-')), 'memory.db'));
  session(db, 'path_good', 'completed');
  tool(db, 'path_good', 'read_files', 1);
  tool(db, 'path_good', 'run_commands', 1);

  session(db, 'path_bad', 'failed');
  for (let index = 0; index < 4; index += 1) tool(db, 'path_bad', 'run_commands', 0);

  session(db, 'path_ok', 'completed');
  tool(db, 'path_ok', 'read_files', 1);
  db.prepare(
    `INSERT INTO turns (session_id, turn_index, block_index, role, kind, text)
     VALUES ('path_ok', 1, 0, 'user', 'text', '不对，再试一次')`
  ).run();

  assert.ok(scoreSession(db, 'path_good') > scoreSession(db, 'path_ok'));
  assert.ok(scoreSession(db, 'path_ok') > scoreSession(db, 'path_bad'));

  const groups = rebuildPaths(db);
  assert.equal(groups, 1);
  const [group] = listPaths(db);
  assert.equal(group.best_session_id, 'path_good');
  assert.equal(group.session_ids.length, 3);
  assert.equal(group.best_steps, 2, 'efficiency data is stored with the best path');
  db.close();
});

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mergeHookToolDurations } from '../src/ingest/tool_durations.ts';
import { openDb } from '../src/store/db.ts';

test('parallel tool calls match durations by parameters, not order', () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'mem-durations-')), 'memory.db'));
  db.prepare(
    `INSERT INTO sessions (session_id, hook_task_id, status) VALUES ('s1', 'conv_s1', 'idle')`
  ).run();
  const insertCall = db.prepare(
    `INSERT INTO tool_calls (session_id, turn_index, tool_call_id, tool_name, parameters_json)
     VALUES ('s1', 0, ?, 'run_commands', ?)`
  );
  insertCall.run('call_a', JSON.stringify({ commands: ['echo A'] }));
  insertCall.run('call_b', JSON.stringify({ commands: ['echo B'] }));
  const insertPost = db.prepare(
    `INSERT INTO hook_events (dedupe_key, event, task_id, hook_ts, payload_json)
     VALUES (?, 'PostToolUse', 'conv_s1', ?, ?)`
  );
  insertPost.run(
    'p_b',
    1,
    JSON.stringify({
      postToolUse: { toolName: 'run_commands', parameters: { commands: '["echo B"]' }, success: true, executionTimeMs: 111 },
    })
  );
  insertPost.run(
    'p_a',
    2,
    JSON.stringify({
      postToolUse: { toolName: 'run_commands', parameters: { commands: '["echo A"]' }, success: true, executionTimeMs: 222 },
    })
  );

  assert.equal(mergeHookToolDurations(db), 2);
  const rows = db
    .prepare('SELECT tool_call_id, duration_ms FROM tool_calls ORDER BY tool_call_id')
    .all() as Array<{ tool_call_id: string; duration_ms: number }>;
  assert.equal(rows.find((row) => row.tool_call_id === 'call_a')!.duration_ms, 222);
  assert.equal(rows.find((row) => row.tool_call_id === 'call_b')!.duration_ms, 111);
  db.close();
});

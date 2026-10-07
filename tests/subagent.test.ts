import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ingestSessionDir } from '../src/ingest/sessions.ts';
import { openDb } from '../src/store/db.ts';

test('subagent sessions keep the parent link', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-subagent-'));
  const db = openDb(join(dir, 'memory.db'));
  const sessionDir = join(dir, 'agent_child');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, 'agent_child.json'),
    JSON.stringify({
      session_id: 'agent_child',
      source: 'cline',
      status: 'completed',
      parent_session_id: 'agent_parent',
      parent_agent_id: 'agent_7',
      is_subagent: true,
      started_at: '2026-10-07T01:00:00Z',
    })
  );
  writeFileSync(
    join(sessionDir, 'agent_child.messages.json'),
    JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: '子任务' }] }] })
  );

  assert.equal(ingestSessionDir(db, sessionDir), true);
  const row = db
    .prepare(
      'SELECT parent_session_id, parent_agent_id, is_subagent FROM sessions WHERE session_id = ?'
    )
    .get('agent_child') as {
    parent_session_id: string;
    parent_agent_id: string;
    is_subagent: number;
  };
  assert.equal(row.parent_session_id, 'agent_parent');
  assert.equal(row.parent_agent_id, 'agent_7');
  assert.equal(row.is_subagent, 1);
  db.close();
});

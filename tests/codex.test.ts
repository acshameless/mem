import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { searchTurns } from '../src/core/recall.ts';
import { ingestCodexDir } from '../src/ingest/codex.ts';
import { openDb } from '../src/store/db.ts';

test('codex adapter ingests rollout files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-codex-'));
  const db = openDb(join(dir, 'memory.db'));
  const day = join(dir, '2026', '10', '07');
  mkdirSync(day, { recursive: true });
  const file = join(day, 'rollout-2026-10-07T01-00-00-abc.jsonl');
  const lines = [
    {
      timestamp: '2026-10-07T01:00:00.000Z',
      type: 'session_meta',
      payload: {
        session_id: 'codex-session-1',
        timestamp: '2026-10-07T01:00:00.000Z',
        cwd: '/Users/ac/project',
        runtime_workspace_roots: ['/Users/ac/project'],
        model_provider: 'deepseek',
      },
    },
    {
      timestamp: '2026-10-07T01:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context>\n cwd\n</environment_context>' }],
      },
    },
    {
      timestamp: '2026-10-07T01:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '帮我设计一个缓存层' }],
      },
    },
    {
      timestamp: '2026-10-07T01:00:03.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '建议使用 LRU 加 TTL' }],
      },
    },
    {
      timestamp: '2026-10-07T01:00:04.000Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: '{"cmd":"ls"}' },
    },
    {
      timestamp: '2026-10-07T01:00:05.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_1', output: 'file list' },
    },
  ];
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n'));

  assert.equal(ingestCodexDir(db, dir), 1);
  const session = db
    .prepare('SELECT source, prompt, workspace_root FROM sessions WHERE session_id = ?')
    .get('codex-session-1') as { source: string; prompt: string; workspace_root: string };
  assert.equal(session.source, 'codex');
  assert.equal(session.prompt, '帮我设计一个缓存层');
  assert.equal(session.workspace_root, '/Users/ac/project');

  const hits = searchTurns(db, '缓存层', { limit: 5 });
  assert.ok(hits.length > 0, 'codex content must be searchable');
  const tools = db
    .prepare('SELECT count(*) c FROM tool_calls WHERE session_id = ?')
    .get('codex-session-1') as { c: number };
  assert.equal(tools.c, 1);
  assert.equal(ingestCodexDir(db, dir), 1, 're-ingest is idempotent');
  db.close();
});

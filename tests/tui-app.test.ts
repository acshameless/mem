import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { insertUnit } from '../src/core/units.ts';
import { openDb } from '../src/store/db.ts';
import {
  loadConfigScreen,
  loadDashboard,
  loadMetrics,
  loadSessions,
  loadTasks,
} from '../src/tui/app.ts';

test('full TUI screens load rows from the store', () => {
  const home = mkdtempSync(join(tmpdir(), 'mem-tui-app-'));
  const previous = process.env.MEM_HOME;
  process.env.MEM_HOME = home;
  try {
    const db = openDb(join(home, 'db', 'memory.db'));
    db.prepare(
      `INSERT INTO sessions (session_id, source, workspace_root, status, started_at, model, tokens_in, tokens_out)
       VALUES ('tui_session', 'test', '/tmp/ws', 'idle', '2026-10-07T01:00:00Z', 'mock', 10, 5)`
    ).run();
    db.prepare(
      `INSERT INTO session_cards (session_id, goal, outcome, summary, decisions_json, lessons_json, tools_json, generated_at)
       VALUES ('tui_session', '目标', '结果', '摘要', '["决定"]', '["教训"]', '[]', '2026-10-07T01:00:00Z')`
    ).run();
    insertUnit(db, { type: 'taste', statement: 'TUI 应用测试记忆', status: 'active', confidence: 0.9 });
    db.prepare(
      `INSERT INTO task_prefs (task_id, memory_enabled, capture_enabled, updated_at)
       VALUES ('task_tui', 0, 1, '2026-10-07T01:00:00Z')`
    ).run();

    assert.ok(loadDashboard(db).some((row) => String(row.title).includes('Sessions 1')));
    const sessions = loadSessions(db);
    assert.equal(sessions.length, 1);
    assert.ok(sessions[0].detail?.some((line) => line.includes('摘要')));
    assert.equal(loadTasks(db)[0].subtitle, 'task_tui');
    assert.ok(loadMetrics(db).some((row) => String(row.title).includes('Adoption')));
    assert.ok(loadConfigScreen(db).some((row) => String(row.title).includes('auto-distill')));
    db.close();
  } finally {
    if (previous === undefined) delete process.env.MEM_HOME;
    else process.env.MEM_HOME = previous;
  }
});

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { insertUnit } from '../src/core/units.ts';
import { openDb } from '../src/store/db.ts';
import { buildState, UI_PAGE } from '../src/ui/server.ts';

test('web UI state includes every panel and counts', () => {
  const home = mkdtempSync(join(tmpdir(), 'mem-ui-state-'));
  const previous = process.env.MEM_HOME;
  process.env.MEM_HOME = home;
  try {
    const db = openDb(join(home, 'db', 'memory.db'));
    insertUnit(db, { type: 'taste', statement: 'UI 状态测试', status: 'candidate' });
    const state = buildState(db) as any;
    assert.equal(state.counts.candidates, 1);
    assert.ok(Array.isArray(state.sessions));
    assert.ok(Array.isArray(state.skills));
    assert.ok(Array.isArray(state.paths));
    assert.ok(Array.isArray(state.tasks));
    assert.equal(typeof state.auto.enabled, 'boolean');
    assert.match(UI_PAGE, /\/api\/state/);
    db.close();
  } finally {
    if (previous === undefined) delete process.env.MEM_HOME;
    else process.env.MEM_HOME = previous;
  }
});

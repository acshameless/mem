import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { insertUnit } from '../src/core/units.ts';
import { openDb } from '../src/store/db.ts';
import { clampIndex, loadItems } from '../src/tui/review.ts';

test('tui model loads candidates and clamps navigation', () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'mem-tui-')), 'memory.db'));
  insertUnit(db, { type: 'taste', statement: 'TUI 候选一', status: 'candidate' });
  insertUnit(db, { type: 'taste', statement: 'TUI 活跃一', status: 'active' });
  db.prepare(
    `INSERT INTO skills (name, slug, description, body, status, created_at, updated_at)
     VALUES ('测试技能', 'ceshi', 'desc', 'body', 'draft', 'now', 'now')`
  ).run();

  const candidates = loadItems(db, 'candidates');
  assert.equal(candidates.length, 1);
  assert.match(candidates[0].subtitle, /TUI 候选一/);
  assert.equal(loadItems(db, 'active').length, 1);
  assert.equal(loadItems(db, 'skills').length, 1);
  assert.equal(clampIndex(-1, 3), 0);
  assert.equal(clampIndex(5, 3), 2);
  assert.equal(clampIndex(0, 0), 0);
  db.close();
});

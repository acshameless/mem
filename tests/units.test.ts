import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  insertUnit,
  listUnits,
  mergeUnits,
  searchUnits,
  setPinned,
  topPersonUnits,
  updateUnit,
} from '../src/core/units.ts';
import { openDb } from '../src/store/db.ts';

test('units can be edited, merged, pinned, and searched', () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'mem-units-')), 'memory.db'));
  const first = insertUnit(db, {
    type: 'taste',
    statement: '偏好简短回答',
    status: 'active',
    confidence: 0.7,
  });
  const second = insertUnit(db, {
    type: 'taste',
    statement: '偏好直接回答',
    status: 'active',
    confidence: 0.6,
  });

  assert.equal(updateUnit(db, first, { statement: '偏好简短且先给结论的回答' }), true);
  const edited = listUnits(db, { status: 'active', limit: 10 }).find((unit) => unit.id === first);
  assert.match(edited!.statement, /先给结论/);

  assert.equal(mergeUnits(db, first, second), true);
  const merged = listUnits(db, { limit: 10 }).find((unit) => unit.id === first);
  assert.match(merged!.statement, /偏好直接回答/);
  const superseded = listUnits(db, { limit: 10 }).find((unit) => unit.id === second);
  assert.equal(superseded!.status, 'superseded');

  assert.equal(setPinned(db, first, true), true);
  assert.equal(topPersonUnits(db, 5)[0].id, first, 'pinned unit must rank first');

  const hits = searchUnits(db, '先给结论', { limit: 5 });
  assert.ok(
    hits.some((unit) => unit.id === first),
    'edited statements must be searchable through the segmented index'
  );
  db.close();
});

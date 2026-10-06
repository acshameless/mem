import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { insertUnit, setUnitStatus } from '../src/core/units.ts';
import { buildProfile, writeProfileSnapshot } from '../src/profile/build.ts';
import { lineDiff } from '../src/profile/diff.ts';
import { openDb } from '../src/store/db.ts';

test('profile builds from active units and writes versioned snapshots', () => {
  const home = mkdtempSync(join(tmpdir(), 'mem-profile-'));
  const previous = process.env.MEM_HOME;
  process.env.MEM_HOME = home;
  try {
    const db = openDb(join(home, 'db', 'memory.db'));
    const tasteId = insertUnit(db, {
      type: 'taste',
      statement: '偏好先结论后细节',
      status: 'active',
      confidence: 0.9,
    });
    const pitfallId = insertUnit(db, {
      type: 'pitfall',
      statement: '不要在回答里使用 emoji',
      status: 'active',
      confidence: 0.7,
    });

    const profile = buildProfile(db);
    assert.match(profile.markdown, /# TASTE Profile/);
    assert.match(profile.markdown, /偏好先结论后细节/);
    assert.match(profile.markdown, /不要在回答里使用 emoji/);
    assert.deepEqual(new Set(profile.unitIds), new Set([tasteId, pitfallId]));

    const first = writeProfileSnapshot(db);
    assert.equal(first.changed, true);
    assert.equal(first.version, 1);

    const second = writeProfileSnapshot(db);
    assert.equal(second.changed, false);
    assert.equal(second.version, 1);

    insertUnit(db, {
      type: 'preference',
      statement: '代码注释使用英文',
      status: 'active',
      confidence: 0.8,
    });
    const third = writeProfileSnapshot(db);
    assert.equal(third.changed, true);
    assert.equal(third.version, 2);

    setUnitStatus(db, tasteId, 'rejected');
    const fourth = writeProfileSnapshot(db);
    assert.equal(fourth.changed, true);
    assert.equal(fourth.version, 3);
    db.close();
  } finally {
    if (previous === undefined) delete process.env.MEM_HOME;
    else process.env.MEM_HOME = previous;
  }
});

test('profile diff reports added and removed lines', () => {
  const diff = lineDiff('a\nb\nc\n', 'a\nc\nd\n');
  const removed = diff.filter((line) => line.type === 'del').map((line) => line.line);
  const added = diff.filter((line) => line.type === 'add').map((line) => line.line);
  assert.deepEqual(removed, ['b']);
  assert.deepEqual(added, ['d']);
});

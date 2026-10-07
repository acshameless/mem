import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exportStore, importStore } from '../src/core/portable.ts';
import { insertUnit } from '../src/core/units.ts';
import { writeProfileSnapshot } from '../src/profile/build.ts';
import { openDb } from '../src/store/db.ts';

test('export and import round-trip units, cards, and profiles', () => {
  const home = mkdtempSync(join(tmpdir(), 'mem-portable-'));
  const previous = process.env.MEM_HOME;
  process.env.MEM_HOME = home;
  try {
    const source = openDb(join(home, 'db', 'source.db'));
    insertUnit(source, {
      type: 'taste',
      statement: '备份测试偏好：回答时优先使用中文',
      status: 'active',
      confidence: 0.9,
    });
    insertUnit(source, {
      type: 'pitfall',
      statement: '备份测试坑：不要在没有备份时删除原始数据',
      status: 'active',
      confidence: 0.7,
    });
    source
      .prepare(
        `INSERT INTO session_cards (session_id, goal, outcome, tools_json, files_json, errors_json, generated_at)
         VALUES ('exported_session', '导出目标', '导出结果', '[]', '[]', '[]', '2026-10-07T00:00:00Z')`
      )
      .run();
    writeProfileSnapshot(source);

    const outDir = join(home, 'export');
    const exported = exportStore(source, outDir);
    assert.equal(exported.units, 2);
    assert.equal(exported.cards, 1);
    assert.ok(exported.profiles >= 1, 'profile snapshots must be exported');

    const target = openDb(join(home, 'db', 'target.db'));
    const imported = importStore(target, outDir);
    assert.equal(imported.units, 2);
    assert.equal(imported.cards, 1);
    assert.equal(imported.skipped, 0);

    const again = importStore(target, outDir);
    assert.equal(again.units, 0);
    assert.equal(again.skipped, 2, 'duplicate units must be skipped');

    const count = target.prepare('SELECT count(*) c FROM memory_units').get() as { c: number };
    assert.equal(count.c, 2);
    const card = target
      .prepare(`SELECT goal FROM session_cards WHERE session_id = 'exported_session'`)
      .get() as { goal: string };
    assert.equal(card.goal, '导出目标');
    source.close();
    target.close();
  } finally {
    if (previous === undefined) delete process.env.MEM_HOME;
    else process.env.MEM_HOME = previous;
  }
});

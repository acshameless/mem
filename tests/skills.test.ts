import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { DistillConfig } from '../src/core/config.ts';
import { insertUnit } from '../src/core/units.ts';
import { activateSkill, draftSkill, recordSkillOutcome } from '../src/skills/build.ts';
import { openDb } from '../src/store/db.ts';

test('skills crystallize from procedure units and activate into SKILL.md', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mem-skill-'));
  const previousHome = process.env.MEM_HOME;
  const previousSkills = process.env.CLINE_SKILLS_DIR;
  process.env.MEM_HOME = home;
  process.env.CLINE_SKILLS_DIR = join(home, 'skills');
  try {
    const db = openDb(join(home, 'db', 'memory.db'));
    insertUnit(db, {
      type: 'procedure',
      statement: '部署前先运行 npm test，再执行构建',
      status: 'active',
      confidence: 0.9,
    });
    const config: DistillConfig = {
      provider: 'mock',
      baseUrl: 'http://mock.local',
      model: 'mock',
      apiKey: 'test',
      maxSessionsPerRun: 5,
      maxCharsPerSession: 8000,
      temperature: 0,
    };
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  name: '部署前验证',
                  description: '部署 mem 前使用',
                  body: '## 步骤\n1. 运行 npm test\n2. 执行构建',
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch;

    const id = await draftSkill(db, config, fetchImpl);
    assert.ok(id, 'draft must be created');
    const activated = activateSkill(db, id!);
    assert.ok(activated, 'skill must activate');
    assert.ok(existsSync(activated!.path));
    assert.match(readFileSync(activated!.path, 'utf8'), /name: 部署前验证/);
    assert.equal(recordSkillOutcome(db, id!, true), true);

    const row = db
      .prepare('SELECT status, use_count, success_count FROM skills WHERE id = ?')
      .get(id) as { status: string; use_count: number; success_count: number };
    assert.equal(row.status, 'active');
    assert.equal(row.use_count, 1);
    assert.equal(row.success_count, 1);
    db.close();
  } finally {
    if (previousHome === undefined) delete process.env.MEM_HOME;
    else process.env.MEM_HOME = previousHome;
    if (previousSkills === undefined) delete process.env.CLINE_SKILLS_DIR;
    else process.env.CLINE_SKILLS_DIR = previousSkills;
  }
});

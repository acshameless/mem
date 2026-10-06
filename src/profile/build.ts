import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { memHome } from '../core/paths.ts';

interface UnitRow {
  id: number;
  type: string;
  statement: string;
  detail: string | null;
  scope: string;
  confidence: number;
}

const SECTIONS: Array<{ title: string; types: string[] }> = [
  { title: '沟通风格 (taste)', types: ['taste'] },
  { title: '工作偏好 (preference)', types: ['preference'] },
  { title: '项目决定与事实 (decision / fact)', types: ['decision', 'fact'] },
  { title: '避坑清单 (pitfall)', types: ['pitfall'] },
];

function loadActiveUnits(db: DatabaseSync): UnitRow[] {
  try {
    return db
      .prepare(
        `SELECT id, type, statement, detail, scope, confidence
         FROM memory_units WHERE status = 'active'
         ORDER BY confidence DESC, id ASC`
      )
      .all() as UnitRow[];
  } catch {
    return [];
  }
}

export interface ProfileBuild {
  markdown: string;
  unitIds: number[];
  hash: string;
}

export function buildProfile(db: DatabaseSync): ProfileBuild {
  const units = loadActiveUnits(db);
  const lines: string[] = ['# TASTE Profile', ''];
  for (const section of SECTIONS) {
    const sectionUnits = units.filter((unit) => section.types.includes(unit.type));
    lines.push(`## ${section.title}`, '');
    if (sectionUnits.length === 0) {
      lines.push('_暂无_', '');
      continue;
    }
    for (const unit of sectionUnits) {
      const scope = unit.scope === 'person' ? '' : ` \`${unit.scope}\``;
      lines.push(`- [${unit.id}] ${unit.statement}${scope}`);
      if (unit.detail) lines.push(`  - ${unit.detail.replace(/\s+/g, ' ')}`);
    }
    lines.push('');
  }
  const counts = SECTIONS.map(
    (section) => `${section.title.split(' ')[0]}=${units.filter((u) => section.types.includes(u.type)).length}`
  ).join(' · ');
  lines.push('---');
  lines.push(`统计: 共 ${units.length} 条 · ${counts}`);
  const markdown = `${lines.join('\n')}\n`;
  const hash = createHash('sha256')
    .update(
      JSON.stringify(
        units.map((unit) => [unit.id, unit.type, unit.statement, unit.detail, unit.scope, unit.confidence])
      )
    )
    .digest('hex');
  return { markdown, unitIds: units.map((unit) => unit.id), hash };
}

export function profilesDir(): string {
  return join(memHome(), 'profiles');
}

function currentState(dir: string): { version: number; hash: string } | null {
  const path = join(dir, '.state.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { version: number; hash: string };
  } catch {
    return null;
  }
}

function latestVersion(dir: string): number {
  let max = 0;
  try {
    for (const name of readdirSync(dir)) {
      const match = /^TASTE-v(\d+)\.md$/.exec(name);
      if (match) max = Math.max(max, Number(match[1]));
    }
  } catch {
    // Directory may not exist yet.
  }
  return max;
}

export function writeProfileSnapshot(
  db: DatabaseSync
): { version: number; path: string; changed: boolean } {
  const dir = profilesDir();
  mkdirSync(dir, { recursive: true });
  const profile = buildProfile(db);
  const state = currentState(dir);
  const latestPath = join(dir, 'TASTE.md');
  if (state && state.hash === profile.hash) {
    return { version: state.version, path: latestPath, changed: false };
  }
  const version = Math.max(state?.version ?? 0, latestVersion(dir)) + 1;
  const header = `> 版本 v${version} · 生成于 ${new Date().toISOString()} · 来源 mem (Cline)\n\n`;
  const content = header + profile.markdown;
  const versionPath = join(dir, `TASTE-v${version}.md`);
  writeFileSync(versionPath, content, { mode: 0o600 });
  writeFileSync(latestPath, content, { mode: 0o600 });
  writeFileSync(
    join(dir, '.state.json'),
    `${JSON.stringify({ version, hash: profile.hash })}\n`,
    { mode: 0o600 }
  );
  return { version, path: versionPath, changed: true };
}

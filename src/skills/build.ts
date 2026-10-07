import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DistillConfig } from '../core/config.ts';
import { chatComplete, type FetchLike } from '../distill/provider.ts';
import { bestPathTools } from '../core/trajectory.ts';

interface ProcedureUnit {
  id: number;
  statement: string;
  detail: string | null;
}

export interface SkillSources {
  units: ProcedureUnit[];
  sessions: string[];
  repeated: Array<{ sequence: string; sessions: string[] }>;
  paths: Array<{ goal: string; bestSessionId: string; score: number; tools: string[] }>;
}

export function collectSkillSources(db: DatabaseSync): SkillSources {
  const units = db
    .prepare(
      `SELECT id, statement, detail FROM memory_units
       WHERE type = 'procedure' AND status IN ('active', 'candidate')
       ORDER BY confidence DESC, id DESC LIMIT 20`
    )
    .all() as ProcedureUnit[];
  const sessions = [
    ...new Set(
      units
        .map(
          (unit) =>
            (
              db
                .prepare('SELECT source_session FROM memory_units WHERE id = ?')
                .get(unit.id) as { source_session: string | null } | undefined
            )?.source_session ?? ''
        )
        .filter(Boolean)
    ),
  ];
  const sequences = db
    .prepare(
      `SELECT session_id, group_concat(tool_name, '>') AS seq FROM (
         SELECT session_id, tool_name FROM tool_calls
         WHERE tool_name IS NOT NULL GROUP BY session_id, tool_name ORDER BY session_id, id
       ) GROUP BY session_id`
    )
    .all() as Array<{ session_id: string; seq: string }>;
  const grouped = new Map<string, string[]>();
  for (const row of sequences) {
    const list = grouped.get(row.seq) ?? [];
    list.push(row.session_id);
    grouped.set(row.seq, list);
  }
  const repeated = [...grouped.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([sequence, list]) => ({ sequence, sessions: list }));
  let paths: SkillSources['paths'] = [];
  try {
    paths = (
      db
        .prepare('SELECT goal, best_session_id, score FROM paths ORDER BY score DESC LIMIT 5')
        .all() as Array<{ goal: string; best_session_id: string; score: number }>
    ).map((row) => ({
      goal: row.goal,
      bestSessionId: row.best_session_id,
      score: row.score,
      tools: bestPathTools(db, row.best_session_id),
    }));
  } catch {
    paths = [];
  }
  return { units, sessions, repeated, paths };
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || `skill-${Date.now()}`
  );
}

function heuristicDraft(sources: SkillSources): { name: string; description: string; body: string } {
  if (sources.units.length > 0) {
    return {
      name: sources.units[0].statement.slice(0, 40),
      description: sources.units[0].statement,
      body:
        '## 步骤\n' +
        sources.units.map((unit, index) => `${index + 1}. ${unit.statement}`).join('\n'),
    };
  }
  if (sources.paths.length > 0 && sources.paths[0].tools.length > 0) {
    const best = sources.paths[0];
    return {
      name: `已验证流程 ${best.tools.slice(0, 3).join(' → ')}`,
      description: `来自最优路径（score ${best.score}）：${best.goal.slice(0, 80)}`,
      body:
        '## 步骤\n' +
        best.tools.map((tool, index) => `${index + 1}. 调用 \`${tool}\``).join('\n') +
        `\n\n## 证据\n最优会话 ${best.bestSessionId}，评分 ${best.score}。`,
    };
  }
  const sequence = sources.repeated[0].sequence.split('>');
  return {
    name: `重复流程 ${sequence.join(' → ')}`,
    description: `在多个会话中重复出现的工具流程：${sequence.join(' → ')}`,
    body:
      '## 步骤\n' +
      sequence.map((tool, index) => `${index + 1}. 调用 \`${tool}\``).join('\n') +
      `\n\n## 证据\n重复出现于 ${sources.repeated[0].sessions.length} 个会话。`,
  };
}

export async function draftSkill(
  db: DatabaseSync,
  config: DistillConfig,
  fetchImpl?: FetchLike
): Promise<number | null> {
  const sources = collectSkillSources(db);
  if (sources.units.length === 0 && sources.repeated.length === 0) return null;

  let draft: { name: string; description: string; body: string } | null = null;
  if (config.apiKey) {
    try {
      const content =
        '已确认的做法（procedure 单元）：\n' +
        sources.units.map((unit) => `- ${unit.statement}`).join('\n') +
        '\n\n重复工具流程：\n' +
        sources.repeated
          .map((item) => `- ${item.sequence}（${item.sessions.length} 次）`)
          .join('\n') +
        '\n\n已验证的最优路径（按 score 排序，优先参考）：\n' +
        sources.paths
          .map(
            (item) =>
              `- ${item.goal.slice(0, 80)}（score ${item.score}，会话 ${item.bestSessionId}）：` +
              item.tools.join(' → ')
          )
          .join('\n');
      const result = await chatComplete(
        config,
        [
          {
            role: 'system',
            content:
              '你是技能编写器。根据证据写一个可复用的 SKILL.md 草稿。只输出 JSON：' +
              '{"name":"短名称","description":"一句话说明何时使用","body":"markdown 步骤、前置条件、验证方法、注意事项"}',
          },
          { role: 'user', content },
        ],
        fetchImpl ?? fetch
      );
      const start = result.text.indexOf('{');
      const end = result.text.lastIndexOf('}');
      if (start >= 0 && end > start) {
        const parsed = JSON.parse(result.text.slice(start, end + 1)) as Record<string, string>;
        if (parsed.name && parsed.body) {
          draft = {
            name: parsed.name.slice(0, 80),
            description: parsed.description ?? '',
            body: parsed.body,
          };
        }
      }
    } catch {
      draft = null;
    }
  }
  if (!draft) draft = heuristicDraft(sources);

  const slug = slugify(draft.name);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO skills (name, slug, description, body, status, evidence_json, source_units_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       slug=excluded.slug, description=excluded.description, body=excluded.body,
       evidence_json=excluded.evidence_json, source_units_json=excluded.source_units_json,
       updated_at=excluded.updated_at`
  ).run(
    draft.name,
    slug,
    draft.description,
    draft.body,
    JSON.stringify({ sessions: sources.sessions, repeated: sources.repeated }),
    JSON.stringify(sources.units.map((unit) => unit.id)),
    now,
    now
  );
  const row = db.prepare('SELECT id FROM skills WHERE name = ?').get(draft.name) as { id: number };
  return row.id;
}

export function skillsDir(): string {
  return process.env.CLINE_SKILLS_DIR ?? join(homedir(), '.cline', 'skills');
}

export function activateSkill(
  db: DatabaseSync,
  id: number
): { path: string; name: string } | null {
  const skill = db
    .prepare('SELECT id, name, slug, description, body FROM skills WHERE id = ?')
    .get(id) as { id: number; name: string; slug: string; description: string; body: string } | undefined;
  if (!skill) return null;
  const dir = join(skillsDir(), skill.slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'SKILL.md');
  const content = `---\nname: ${skill.name}\ndescription: ${skill.description ?? ''}\n---\n\n${skill.body}\n`;
  writeFileSync(path, content, { mode: 0o600 });
  db.prepare(
    `UPDATE skills SET status = 'active', path = ?, activated_at = ?, updated_at = ? WHERE id = ?`
  ).run(path, new Date().toISOString(), new Date().toISOString(), id);
  return { path, name: skill.name };
}

export function recordSkillOutcome(db: DatabaseSync, id: number, success: boolean): boolean {
  const result = db
    .prepare(
      `UPDATE skills SET use_count = coalesce(use_count, 0) + 1,
         success_count = coalesce(success_count, 0) + ?,
         fail_count = coalesce(fail_count, 0) + ?,
         updated_at = ? WHERE id = ?`
    )
    .run(success ? 1 : 0, success ? 0 : 1, new Date().toISOString(), id);
  return Number(result.changes ?? 0) > 0;
}

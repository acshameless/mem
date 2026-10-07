import type { DatabaseSync } from 'node:sqlite';

export interface PathGroup {
  goal_key: string;
  goal: string;
  session_ids: string[];
  best_session_id: string | null;
  score: number;
  best_steps: number | null;
  updated_at: string;
}

export function normalizeGoal(goal: string): string {
  return goal
    .replace(/^\s*<user_input[^>]*>/i, '')
    .replace(/<\/user_input>\s*$/i, '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 160);
}

function toolStats(db: DatabaseSync, sessionId: string): { total: number; failed: number } {
  return db
    .prepare(
      `SELECT count(*) total, coalesce(sum(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) failed
       FROM tool_calls WHERE session_id = ?`
    )
    .get(sessionId) as { total: number; failed: number };
}

function correctionCount(db: DatabaseSync, sessionId: string): number {
  const row = db
    .prepare(
      `SELECT count(*) c FROM turns
       WHERE session_id = ? AND role = 'user' AND kind = 'text'
         AND (display_role IS NULL OR display_role != 'system')`
    )
    .get(sessionId) as { c: number };
  return Math.max(0, row.c - 1);
}

export function scoreSession(db: DatabaseSync, sessionId: string): number {
  const session = db
    .prepare('SELECT lifecycle FROM sessions WHERE session_id = ?')
    .get(sessionId) as { lifecycle: string | null } | undefined;
  let score = 0.4;
  switch (session?.lifecycle ?? 'unknown') {
    case 'completed':
      score += 0.3;
      break;
    case 'failed':
      score -= 0.35;
      break;
    case 'aborted_unknown':
      score -= 0.25;
      break;
    case 'cancelled':
      score -= 0.15;
      break;
    case 'in_progress':
      score -= 0.05;
      break;
    default:
      break;
  }
  const tools = toolStats(db, sessionId);
  if (tools.total > 0) {
    score -= 0.2 * (tools.failed / tools.total);
    if (tools.failed === 0) score += 0.05;
  }
  score -= Math.min(0.15, correctionCount(db, sessionId) * 0.03);
  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}

export function rebuildPaths(db: DatabaseSync): number {
  const sessions = db
    .prepare(
      `SELECT session_id, prompt FROM sessions
       WHERE prompt IS NOT NULL AND trim(prompt) != ''`
    )
    .all() as Array<{ session_id: string; prompt: string }>;
  const groups = new Map<string, { goal: string; sessions: string[] }>();
  for (const session of sessions) {
    const key = normalizeGoal(session.prompt);
    if (key.length < 4) continue;
    const group = groups.get(key) ?? { goal: session.prompt.slice(0, 200), sessions: [] };
    group.sessions.push(session.session_id);
    groups.set(key, group);
  }
  db.prepare('DELETE FROM paths').run();
  const insert = db.prepare(
    `INSERT INTO paths (goal_key, goal, session_ids_json, best_session_id, score, best_steps, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const now = new Date().toISOString();
  let stored = 0;
  for (const [key, group] of groups) {
    const stepsOf = (sessionId: string) =>
      (
        db
          .prepare('SELECT count(*) c FROM tool_calls WHERE session_id = ?')
          .get(sessionId) as { c: number }
      ).c;
    const raw = group.sessions.map((sessionId) => ({
      sessionId,
      score: scoreSession(db, sessionId),
      steps: stepsOf(sessionId),
      lifecycle:
        (
          db
            .prepare('SELECT lifecycle FROM sessions WHERE session_id = ?')
            .get(sessionId) as { lifecycle: string | null } | undefined
        )?.lifecycle ?? 'unknown',
    }));
    const minSteps = Math.max(
      1,
      Math.min(...raw.filter((item) => item.steps > 0).map((item) => item.steps), Number.MAX_SAFE_INTEGER)
    );
    const scored = raw
      .map((item) => {
        // Step efficiency matters only for successful paths. Weight: 0.05 max.
        const efficiency =
          item.lifecycle === 'completed' && item.steps > 0
            ? 0.05 * (minSteps / item.steps)
            : 0;
        return { ...item, score: Math.min(1, Number((item.score + efficiency).toFixed(3))) };
      })
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    insert.run(
      key,
      group.goal,
      JSON.stringify(group.sessions),
      best.sessionId,
      best.score,
      best.steps,
      now
    );
    stored += 1;
  }
  return stored;
}

export function listPaths(db: DatabaseSync, limit = 50): PathGroup[] {
  try {
    const rows = db
      .prepare('SELECT * FROM paths ORDER BY score DESC, updated_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, any>>;
    return rows.map((row) => ({
      ...row,
      session_ids: JSON.parse(row.session_ids_json) as string[],
    })) as unknown as PathGroup[];
  } catch {
    return [];
  }
}

export function bestPathTools(db: DatabaseSync, sessionId: string, limit = 12): string[] {
  return (
    db
      .prepare(
        `SELECT tool_name FROM tool_calls WHERE session_id = ? AND tool_name IS NOT NULL
         ORDER BY id LIMIT ?`
      )
      .all(sessionId, limit) as Array<{ tool_name: string }>
  ).map((row) => row.tool_name);
}

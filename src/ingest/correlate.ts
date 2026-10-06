import type { DatabaseSync } from 'node:sqlite';

const MAX_DELTA_MS = 30_000;

export function correlateSessions(db: DatabaseSync): number {
  const sessions = db
    .prepare(
      `SELECT session_id, workspace_root, started_at
       FROM sessions WHERE hook_task_id IS NULL`
    )
    .all() as Array<{ session_id: string; workspace_root: string | null; started_at: string | null }>;
  const starts = db
    .prepare(
      `SELECT task_id, hook_ts, workspace_root
       FROM hook_events WHERE event = 'TaskStart'`
    )
    .all() as Array<{ task_id: string; hook_ts: number | null; workspace_root: string | null }>;
  const update = db.prepare(
    'UPDATE sessions SET hook_task_id = ?, correlation = ? WHERE session_id = ?'
  );

  let linked = 0;
  for (const session of sessions) {
    if (!session.started_at) continue;
    const started = Date.parse(session.started_at);
    if (!Number.isFinite(started)) continue;
    let best: { task_id: string; delta: number } | null = null;
    for (const start of starts) {
      if (!start.task_id || start.hook_ts == null) continue;
      if (
        start.workspace_root &&
        session.workspace_root &&
        start.workspace_root !== session.workspace_root
      ) {
        continue;
      }
      const delta = Math.abs(start.hook_ts - started);
      if (delta > MAX_DELTA_MS) continue;
      if (!best || delta < best.delta) best = { task_id: start.task_id, delta };
    }
    if (best) {
      update.run(best.task_id, `time_delta_ms=${best.delta}`, session.session_id);
      linked += 1;
    }
  }
  return linked;
}

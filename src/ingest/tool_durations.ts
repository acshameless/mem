import type { DatabaseSync } from 'node:sqlite';

interface SessionRow {
  session_id: string;
  hook_task_id: string;
}

interface PostRow {
  payload_json: string;
}

interface CallRow {
  id: number;
  tool_name: string | null;
}

// Merge PostToolUse durations and success state into tool_calls.
// Correlation is per session and per order. Counts must match for a merge.
export function mergeHookToolDurations(db: DatabaseSync): number {
  const sessions = db
    .prepare(
      `SELECT session_id, hook_task_id FROM sessions
       WHERE hook_task_id IS NOT NULL AND hook_task_id != ''`
    )
    .all() as SessionRow[];
  const getPosts = db.prepare(
    `SELECT payload_json FROM hook_events
     WHERE event = 'PostToolUse' AND task_id = ?
     ORDER BY hook_ts, id`
  );
  const getCalls = db.prepare(
    'SELECT id, tool_name FROM tool_calls WHERE session_id = ? ORDER BY id'
  );
  const update = db.prepare(
    `UPDATE tool_calls SET duration_ms = ?, success = ?, source = 'session+hook'
     WHERE id = ?`
  );

  let merged = 0;
  for (const session of sessions) {
    const posts = getPosts.all(session.hook_task_id) as PostRow[];
    const calls = getCalls.all(session.session_id) as CallRow[];
    if (posts.length === 0 || posts.length !== calls.length) continue;
    for (let i = 0; i < posts.length; i += 1) {
      const payload = JSON.parse(posts[i].payload_json) as Record<string, any>;
      const post = (payload.postToolUse ?? {}) as Record<string, any>;
      const name = typeof post.toolName === 'string' ? post.toolName : null;
      if (name && calls[i].tool_name && name !== calls[i].tool_name) continue;
      const duration =
        Number.isFinite(Number(post.executionTimeMs)) && post.executionTimeMs != null
          ? Number(post.executionTimeMs)
          : null;
      const success = post.success === false ? 0 : 1;
      update.run(duration, success, calls[i].id);
      merged += 1;
    }
  }
  return merged;
}

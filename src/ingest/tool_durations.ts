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
  parameters_json: string | null;
}

function canonical(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return canonical(JSON.parse(value) as unknown);
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${key}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function key(toolName: string | null, parameters: unknown): string {
  return `${toolName ?? ''}\u0000${canonical(parameters ?? {})}`;
}

// Merge PostToolUse durations and success state into tool_calls.
// Match by tool name and parameters first. Fall back to order only when the
// remaining counts are equal, which protects parallel calls of the same tool.
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
    'SELECT id, tool_name, parameters_json FROM tool_calls WHERE session_id = ? ORDER BY id'
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

    const remaining = new Set(calls.map((call) => call.id));
    const unmatchedPosts: Array<{ post: Record<string, any>; index: number }> = [];
    posts.forEach((row, index) => {
      const payload = JSON.parse(row.payload_json) as Record<string, any>;
      const post = (payload.postToolUse ?? {}) as Record<string, any>;
      const wanted = key(post.toolName ?? null, post.parameters);
      const match = calls.find(
        (call) => remaining.has(call.id) && key(call.tool_name, call.parameters_json) === wanted
      );
      if (match) {
        const duration =
          Number.isFinite(Number(post.executionTimeMs)) && post.executionTimeMs != null
            ? Number(post.executionTimeMs)
            : null;
        update.run(duration, post.success === false ? 0 : 1, match.id);
        remaining.delete(match.id);
        merged += 1;
      } else {
        unmatchedPosts.push({ post, index });
      }
    });

    // Fallback: pair the remaining calls by order.
    const leftoverCalls = calls.filter((call) => remaining.has(call.id));
    if (unmatchedPosts.length === leftoverCalls.length) {
      unmatchedPosts.forEach((item, index) => {
        const call = leftoverCalls[index];
        const duration =
          Number.isFinite(Number(item.post.executionTimeMs)) && item.post.executionTimeMs != null
            ? Number(item.post.executionTimeMs)
            : null;
        update.run(duration, item.post.success === false ? 0 : 1, call.id);
        merged += 1;
      });
    }
  }
  return merged;
}

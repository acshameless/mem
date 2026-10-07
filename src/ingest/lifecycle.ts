import type { DatabaseSync } from 'node:sqlite';

export type SessionLifecycle =
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'aborted_unknown'
  | 'idle';

const ABORT_AFTER_MS = 10 * 60 * 1000;

// Derive how a session ended from Cline state + hook events.
// completed  : TaskComplete fired
// cancelled  : TaskCancel fired
// failed     : Cline status says failed/error
// aborted_unknown: TaskStart without completion and quiet for >10 minutes
// in_progress: started recently, no end event yet
export function updateSessionLifecycle(db: DatabaseSync): number {
  let sessions: Array<{
    session_id: string;
    hook_task_id: string | null;
    status: string | null;
    updated_at: string | null;
    source: string | null;
  }> = [];
  try {
    sessions = db
      .prepare('SELECT session_id, hook_task_id, status, updated_at, source FROM sessions')
      .all() as typeof sessions;
  } catch {
    return 0;
  }
  const eventsFor = db.prepare('SELECT event FROM hook_events WHERE task_id = ?');
  const update = db.prepare('UPDATE sessions SET lifecycle = ? WHERE session_id = ?');
  const now = Date.now();
  let updated = 0;
  for (const session of sessions) {
    const events = new Set(
      (session.hook_task_id
        ? (eventsFor.all(session.hook_task_id) as Array<{ event: string }>)
        : []
      ).map((row) => row.event)
    );
    const status = (session.status ?? '').toLowerCase();
    let lifecycle: SessionLifecycle;
    if (status.includes('fail') || status.includes('error')) lifecycle = 'failed';
    else if (events.has('TaskComplete') || status === 'completed') lifecycle = 'completed';
    else if (events.has('TaskCancel')) lifecycle = 'cancelled';
    else if (events.has('TaskStart')) {
      const updatedMs = Date.parse(session.updated_at ?? '');
      lifecycle =
        Number.isFinite(updatedMs) && now - updatedMs > ABORT_AFTER_MS
          ? 'aborted_unknown'
          : 'in_progress';
    } else {
      lifecycle = status === 'idle' ? 'idle' : 'aborted_unknown';
    }
    updated += Number(update.run(lifecycle, session.session_id).changes ?? 0);
  }
  return updated;
}

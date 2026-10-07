import type { DatabaseSync } from 'node:sqlite';

export interface TaskPref {
  task_id: string;
  memory_enabled: number;
  capture_enabled: number;
  updated_at: string | null;
}

export function getTaskPrefs(db: DatabaseSync, taskId: string): TaskPref | null {
  try {
    return (
      (db.prepare('SELECT * FROM task_prefs WHERE task_id = ?').get(taskId) as TaskPref | undefined) ??
      null
    );
  } catch {
    return null;
  }
}

export function isMemoryEnabled(db: DatabaseSync, taskId: string | null): boolean {
  if (!taskId) return true;
  const pref = getTaskPrefs(db, taskId);
  return pref ? pref.memory_enabled !== 0 : true;
}

export function isCaptureEnabled(db: DatabaseSync, taskId: string | null): boolean {
  if (!taskId) return true;
  const pref = getTaskPrefs(db, taskId);
  return pref ? pref.capture_enabled !== 0 : true;
}

export function setTaskPref(
  db: DatabaseSync,
  taskId: string,
  fields: { memory?: boolean; capture?: boolean }
): void {
  const current = getTaskPrefs(db, taskId);
  const memory = fields.memory ?? (current ? current.memory_enabled !== 0 : true);
  const capture = fields.capture ?? (current ? current.capture_enabled !== 0 : true);
  db.prepare(
    `INSERT INTO task_prefs (task_id, memory_enabled, capture_enabled, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET
       memory_enabled=excluded.memory_enabled,
       capture_enabled=excluded.capture_enabled,
       updated_at=excluded.updated_at`
  ).run(taskId, memory ? 1 : 0, capture ? 1 : 0, new Date().toISOString());
}

export function listTaskPrefs(db: DatabaseSync, limit = 50): TaskPref[] {
  try {
    return db
      .prepare('SELECT * FROM task_prefs ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as TaskPref[];
  } catch {
    return [];
  }
}

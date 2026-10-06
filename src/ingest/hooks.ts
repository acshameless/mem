import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { forgottenValues } from '../core/forget.ts';

export function ingestHookFile(db: DatabaseSync, filePath: string): number {
  const text = readFileSync(filePath, 'utf8');
  const insert = db.prepare(
    `INSERT OR IGNORE INTO hook_events
       (dedupe_key, event, received_at, task_id, hook_ts, workspace_root, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  let added = 0;
  const forgottenTasks = forgottenValues(db, 'task');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    if (typeof payload.taskId === 'string' && forgottenTasks.has(payload.taskId)) continue;
    const dedupe = createHash('sha256').update(trimmed).digest('hex');
    const roots = payload.workspaceRoots;
    const workspace = Array.isArray(roots) && roots.length > 0 ? String(roots[0]) : null;
    const rawTs = payload.timestamp;
    const ts = rawTs != null && Number.isFinite(Number(rawTs)) ? Number(rawTs) : null;
    const result = insert.run(
      dedupe,
      String(record.event ?? 'unknown'),
      typeof record.received_at === 'string' ? record.received_at : null,
      typeof payload.taskId === 'string' ? payload.taskId : null,
      ts,
      workspace,
      JSON.stringify(payload)
    );
    added += Number(result.changes ?? 0);
  }
  return added;
}

export function ingestHookDir(db: DatabaseSync, dir: string): { files: number; events: number } {
  let files = 0;
  let events = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { files, events };
  }
  for (const name of names.filter((n) => n.endsWith('.jsonl')).sort()) {
    files += 1;
    events += ingestHookFile(db, join(dir, name));
  }
  return { files, events };
}

import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { hookRawDir, memHome } from './paths.ts';
import { statementHash } from './units.ts';

export function rememberForget(
  db: DatabaseSync,
  kind: string,
  value: string,
  note?: string
): void {
  db.prepare(
    `INSERT OR IGNORE INTO forget_list (kind, value, created_at, note) VALUES (?, ?, ?, ?)`
  ).run(kind, value, new Date().toISOString(), note ?? null);
}

export function isForgotten(db: DatabaseSync, kind: string, value: string): boolean {
  try {
    return (
      db.prepare('SELECT 1 FROM forget_list WHERE kind = ? AND value = ? LIMIT 1').get(kind, value) !==
      undefined
    );
  } catch {
    return false;
  }
}

export function forgottenValues(db: DatabaseSync, kind: string): Set<string> {
  try {
    const rows = db.prepare('SELECT value FROM forget_list WHERE kind = ?').all(kind) as Array<{
      value: string;
    }>;
    return new Set(rows.map((row) => row.value));
  } catch {
    return new Set();
  }
}

function rewriteJsonl(
  dir: string,
  keep: (record: Record<string, any>) => boolean
): number {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.jsonl'))) {
    const path = join(dir, name);
    const lines = readFileSync(path, 'utf8').split('\n');
    const kept: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as Record<string, any>;
        if (keep(record)) kept.push(trimmed);
        else removed += 1;
      } catch {
        kept.push(trimmed);
      }
    }
    if (removed > 0) {
      const tmp = `${path}.tmp.${process.pid}`;
      writeFileSync(tmp, kept.length > 0 ? `${kept.join('\n')}\n` : '');
      renameSync(tmp, path);
    }
  }
  return removed;
}

export interface ForgetSessionResult {
  counts: Record<string, number>;
  hookTaskId: string | null;
  hookLinesRemoved: number;
  injectionLinesRemoved: number;
}

export function forgetSession(
  db: DatabaseSync,
  sessionId: string,
  options: { includeActive?: boolean } = {}
): ForgetSessionResult {
  const session = db
    .prepare('SELECT hook_task_id FROM sessions WHERE session_id = ?')
    .get(sessionId) as { hook_task_id: string | null } | undefined;
  const hookTaskId = session?.hook_task_id ?? null;

  const counts: Record<string, number> = {};
  for (const table of ['injections', 'turns', 'tool_calls', 'session_cards', 'distill_state']) {
    counts[table] = Number(db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId).changes ?? 0);
  }
  counts.sessions = Number(db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId).changes ?? 0);

  const units = db
    .prepare('SELECT id, statement, status FROM memory_units WHERE source_session = ?')
    .all(sessionId) as Array<{ id: number; statement: string; status: string }>;
  let removedUnits = 0;
  for (const unit of units) {
    if (unit.status === 'active' && !options.includeActive) continue;
    db.prepare('DELETE FROM memory_units WHERE id = ?').run(unit.id);
    rememberForget(db, 'unit-statement', statementHash(unit.statement), `forgotten with ${sessionId}`);
    removedUnits += 1;
  }
  counts.memory_units = removedUnits;

  rememberForget(db, 'session', sessionId);
  if (hookTaskId) rememberForget(db, 'task', hookTaskId);

  const hookLinesRemoved = rewriteJsonl(hookRawDir(), (record) => {
    const taskId = record?.payload?.taskId;
    return !(hookTaskId && taskId === hookTaskId);
  });
  const injectionLinesRemoved = rewriteJsonl(join(memHome(), 'raw', 'injections'), (record) => {
    return record?.session_id !== sessionId;
  });

  return { counts, hookTaskId, hookLinesRemoved, injectionLinesRemoved };
}

export function forgetUnit(db: DatabaseSync, id: number): string | null {
  const unit = db
    .prepare('SELECT id, statement FROM memory_units WHERE id = ?')
    .get(id) as { id: number; statement: string } | undefined;
  if (!unit) return null;
  db.prepare('DELETE FROM memory_units WHERE id = ?').run(id);
  rememberForget(db, 'unit-statement', statementHash(unit.statement), `forgotten unit ${id}`);
  return unit.statement;
}

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { forgottenValues } from '../core/forget.ts';

export function ingestInjectionFile(db: DatabaseSync, filePath: string): number {
  const text = readFileSync(filePath, 'utf8');
  const insert = db.prepare(
    `INSERT OR IGNORE INTO injections
       (dedupe_key, ts, task_id, session_id, sections_json, unit_ids_json, cards, turns, chars)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let added = 0;
  const forgottenSessions = forgottenValues(db, 'session');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: Record<string, any>;
    try {
      record = JSON.parse(trimmed) as Record<string, any>;
    } catch {
      continue;
    }
    const dedupe = createHash('sha256').update(trimmed).digest('hex');
    if (typeof record.session_id === 'string' && forgottenSessions.has(record.session_id)) continue;
    const result = insert.run(
      dedupe,
      record.ts ?? null,
      record.task_id ?? null,
      record.session_id ?? null,
      JSON.stringify(record.sections ?? []),
      JSON.stringify(record.unit_ids ?? []),
      Number(record.cards ?? 0),
      Number(record.turns ?? 0),
      Number(record.chars ?? 0)
    );
    added += Number(result.changes ?? 0);
  }
  return added;
}

export function ingestInjectionDir(
  db: DatabaseSync,
  dir: string
): { files: number; records: number } {
  let files = 0;
  let records = 0;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return { files, records };
  }
  for (const name of names.filter((entry) => entry.endsWith('.jsonl')).sort()) {
    files += 1;
    records += ingestInjectionFile(db, join(dir, name));
  }
  return { files, records };
}

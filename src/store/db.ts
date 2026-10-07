import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backfillTurnSegments } from '../ingest/backfill.ts';

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));
const SCHEMA_SEG_PATH = fileURLToPath(new URL('./schema_seg.sql', import.meta.url));

function tryExec(db: DatabaseSync, sql: string): void {
  try {
    db.exec(sql);
  } catch {
    // Best-effort migration: a read-only or locked database stays usable;
    // the next writable process applies the migration.
  }
}

export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  tryExec(db, 'PRAGMA journal_mode = WAL;');
  tryExec(db, readFileSync(SCHEMA_PATH, 'utf8'));
  const columns = db.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'text_seg')) {
    tryExec(db, 'ALTER TABLE turns ADD COLUMN text_seg TEXT');
  }
  const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  if (!sessionColumns.some((column) => column.name === 'lifecycle')) {
    tryExec(db, 'ALTER TABLE sessions ADD COLUMN lifecycle TEXT');
  }
  const unitColumns = db.prepare('PRAGMA table_info(memory_units)').all() as Array<{
    name: string;
  }>;
  if (!unitColumns.some((column) => column.name === 'supersedes_id')) {
    tryExec(db, 'ALTER TABLE memory_units ADD COLUMN supersedes_id INTEGER');
  }
  if (!unitColumns.some((column) => column.name === 'use_count')) {
    tryExec(db, 'ALTER TABLE memory_units ADD COLUMN use_count INTEGER DEFAULT 0');
  }
  if (!unitColumns.some((column) => column.name === 'pinned')) {
    tryExec(db, 'ALTER TABLE memory_units ADD COLUMN pinned INTEGER DEFAULT 0');
  }
  if (!unitColumns.some((column) => column.name === 'positive_feedback')) {
    tryExec(db, 'ALTER TABLE memory_units ADD COLUMN positive_feedback INTEGER DEFAULT 0');
  }
  if (!unitColumns.some((column) => column.name === 'negative_feedback')) {
    tryExec(db, 'ALTER TABLE memory_units ADD COLUMN negative_feedback INTEGER DEFAULT 0');
  }
  const toolColumns = db.prepare('PRAGMA table_info(tool_calls)').all() as Array<{ name: string }>;
  if (!toolColumns.some((column) => column.name === 'blob_hash')) {
    tryExec(db, 'ALTER TABLE tool_calls ADD COLUMN blob_hash TEXT');
  }
  const cardColumns = db.prepare('PRAGMA table_info(session_cards)').all() as Array<{ name: string }>;
  for (const [name, type] of [
    ['summary', 'TEXT'],
    ['decisions_json', 'TEXT'],
    ['open_questions_json', 'TEXT'],
    ['lessons_json', 'TEXT'],
    ['generated_by', 'TEXT'],
  ] as Array<[string, string]>) {
    if (!cardColumns.some((column) => column.name === name)) {
      tryExec(db, `ALTER TABLE session_cards ADD COLUMN ${name} ${type}`);
    }
  }
  const pathColumns = db.prepare('PRAGMA table_info(paths)').all() as Array<{ name: string }>;
  if (!pathColumns.some((column) => column.name === 'best_steps')) {
    tryExec(db, 'ALTER TABLE paths ADD COLUMN best_steps INTEGER');
  }
  // Fill segments before the segmented triggers exist, so no trigger deletes
  // rows from an index that was never built.
  try {
    backfillTurnSegments(db);
  } catch {
    // Read-only open: segments are filled by the next writable process.
  }
  let hadSegIndex = true;
  try {
    hadSegIndex =
      (
        db
          .prepare(
            `SELECT count(*) c FROM sqlite_master WHERE type = 'table' AND name = 'turns_fts_seg'`
          )
          .get() as { c: number }
      ).c > 0;
  } catch {
    hadSegIndex = true;
  }
  tryExec(db, readFileSync(SCHEMA_SEG_PATH, 'utf8'));
  if (!hadSegIndex) {
    tryExec(db, `INSERT INTO turns_fts_seg(turns_fts_seg) VALUES('rebuild')`);
  }
  return db;
}

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backfillTurnSegments } from '../ingest/backfill.ts';

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));
const SCHEMA_SEG_PATH = fileURLToPath(new URL('./schema_seg.sql', import.meta.url));

export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  const columns = db.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'text_seg')) {
    db.exec('ALTER TABLE turns ADD COLUMN text_seg TEXT');
  }
  const unitColumns = db.prepare('PRAGMA table_info(memory_units)').all() as Array<{
    name: string;
  }>;
  if (!unitColumns.some((column) => column.name === 'supersedes_id')) {
    db.exec('ALTER TABLE memory_units ADD COLUMN supersedes_id INTEGER');
  }
  // Fill segments before the segmented triggers exist, so no trigger deletes
  // rows from an index that was never built.
  backfillTurnSegments(db);
  const hadSegIndex =
    (
      db
        .prepare(
          `SELECT count(*) c FROM sqlite_master WHERE type = 'table' AND name = 'turns_fts_seg'`
        )
        .get() as { c: number }
    ).c > 0;
  db.exec(readFileSync(SCHEMA_SEG_PATH, 'utf8'));
  if (!hadSegIndex) {
    db.exec(`INSERT INTO turns_fts_seg(turns_fts_seg) VALUES('rebuild')`);
  }
  return db;
}

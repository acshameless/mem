import type { DatabaseSync } from 'node:sqlite';
import { segmentForSearch } from '../core/tokenize.ts';

// Fill text_seg for rows that were ingested before the segmented index existed.
export function backfillTurnSegments(db: DatabaseSync): number {
  const rows = db
    .prepare(
      `SELECT id, text FROM turns
       WHERE text IS NOT NULL AND (text_seg IS NULL OR text_seg = '')`
    )
    .all() as Array<{ id: number; text: string }>;
  if (rows.length === 0) return 0;
  const update = db.prepare('UPDATE turns SET text_seg = ? WHERE id = ?');
  for (const row of rows) update.run(segmentForSearch(row.text), row.id);
  return rows.length;
}

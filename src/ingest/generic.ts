import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { segmentForSearch } from '../core/tokenize.ts';
import { isForgotten } from '../core/forget.ts';

interface GenericLine {
  role?: string;
  content?: string;
  text?: string;
  ts?: string;
}

// Ingest foreign conversations from one JSONL file per session.
// Each line: {"role":"user|assistant","content":"...","ts":"ISO"}
export function ingestGenericDir(db: DatabaseSync, dir: string): number {
  if (!existsSync(dir)) return 0;
  let sessions = 0;
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.jsonl'))) {
    const sessionId = basename(name, '.jsonl');
    if (isForgotten(db, 'session', sessionId)) continue;
    const lines = readFileSync(join(dir, name), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as GenericLine;
        } catch {
          return null;
        }
      })
      .filter((line): line is GenericLine => line !== null);
    if (lines.length === 0) continue;

    const firstUser = lines.find((line) => line.role === 'user');
    const startedAt = lines[0].ts ?? null;
    const updatedAt = lines[lines.length - 1].ts ?? null;
    db.prepare(
      `INSERT INTO sessions
         (session_id, source, workspace_root, status, started_at, updated_at, prompt, raw_json)
       VALUES (?, 'generic', NULL, 'idle', ?, ?, ?, '{}')
       ON CONFLICT(session_id) DO UPDATE SET
         updated_at=excluded.updated_at, prompt=excluded.prompt`
    ).run(sessionId, startedAt, updatedAt, firstUser?.content ?? firstUser?.text ?? null);

    db.prepare('DELETE FROM turns WHERE session_id = ?').run(sessionId);
    const insertTurn = db.prepare(
      `INSERT INTO turns
         (session_id, turn_index, block_index, role, display_role, kind, text, text_seg, content_json)
       VALUES (?, ?, 0, ?, NULL, 'text', ?, ?, ?)`
    );
    lines.forEach((line, index) => {
      const text = line.content ?? line.text ?? '';
      if (!text) return;
      insertTurn.run(
        sessionId,
        index,
        line.role ?? 'unknown',
        text,
        segmentForSearch(text),
        JSON.stringify(line)
      );
    });
    sessions += 1;
  }
  return sessions;
}

import { existsSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { storeBlobBuffer } from '../core/blobs.ts';

interface AttachmentResult {
  stored: number;
}

function insertAttachment(
  db: DatabaseSync,
  row: {
    origin: string;
    sessionId: string | null;
    taskId: string | null;
    kind: string;
    mime: string | null;
    hash: string | null;
    relpath: string | null;
    size: number | null;
  }
): void {
  db.prepare(
    `INSERT OR IGNORE INTO attachments
       (origin, session_id, task_id, kind, mime, hash, relpath, size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.origin,
    row.sessionId,
    row.taskId,
    row.kind,
    row.mime,
    row.hash,
    row.relpath,
    row.size,
    new Date().toISOString()
  );
}

// Read attachment references from UserPromptSubmit hook payloads.
// Strings can be a data URL, a file path, or an opaque reference.
export function ingestHookAttachments(db: DatabaseSync): number {
  let stored = 0;
  let rows: Array<{ task_id: string | null; payload_json: string }> = [];
  try {
    rows = db
      .prepare(
        `SELECT task_id, payload_json FROM hook_events WHERE event = 'UserPromptSubmit'`
      )
      .all() as typeof rows;
  } catch {
    return 0;
  }
  for (const row of rows) {
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(row.payload_json) as Record<string, any>;
    } catch {
      continue;
    }
    const attachments = payload.userPromptSubmit?.attachments;
    if (!Array.isArray(attachments)) continue;
    const session = row.task_id
      ? (db
          .prepare('SELECT session_id FROM sessions WHERE hook_task_id = ? LIMIT 1')
          .get(row.task_id) as { session_id: string } | undefined)
      : undefined;
    for (const item of attachments) {
      const text = typeof item === 'string' ? item : JSON.stringify(item);
      const dataUrl = /^data:([^;]+);base64,(.*)$/s.exec(text);
      try {
        if (dataUrl) {
          const blob = storeBlobBuffer(db, Buffer.from(dataUrl[2], 'base64'));
          insertAttachment(db, {
            origin: 'hook',
            sessionId: session?.session_id ?? null,
            taskId: row.task_id,
            kind: 'user_attachment',
            mime: dataUrl[1],
            hash: blob.hash,
            relpath: null,
            size: blob.size,
          });
        } else if (existsSync(text)) {
          const blob = storeBlobBuffer(db, readFileSync(text));
          insertAttachment(db, {
            origin: 'hook',
            sessionId: session?.session_id ?? null,
            taskId: row.task_id,
            kind: 'user_attachment',
            mime: null,
            hash: blob.hash,
            relpath: text,
            size: blob.size,
          });
        } else {
          insertAttachment(db, {
            origin: 'hook',
            sessionId: session?.session_id ?? null,
            taskId: row.task_id,
            kind: 'user_attachment',
            mime: null,
            hash: null,
            relpath: text.slice(0, 500),
            size: null,
          });
        }
        stored += 1;
      } catch {
        // Attachment capture is best effort.
      }
    }
  }
  return stored;
}

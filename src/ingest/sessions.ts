import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { segmentForSearch } from '../core/tokenize.ts';
import { isForgotten } from '../core/forget.ts';
import { storeBlob, storeBlobBuffer } from '../core/blobs.ts';

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface Message {
  role?: string;
  content?: ContentBlock[];
  metadata?: { displayRole?: string };
}

interface MessagesDoc {
  updated_at?: string;
  system_prompt?: string;
  messages?: Message[];
}

export function discoverSessionDirs(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return names.map((name) => join(root, name)).sort();
}

export function ingestSessionDir(db: DatabaseSync, dir: string): boolean {
  const metaName = readdirSync(dir).find((n) => n.endsWith('.json') && !n.endsWith('.messages.json'));
  if (!metaName) return false;
  const id = metaName.replace(/\.json$/, '');
  if (isForgotten(db, 'session', id)) return false;
  const meta = JSON.parse(readFileSync(join(dir, metaName), 'utf8')) as Record<string, any>;
  const messagesPath = join(dir, `${id}.messages.json`);
  const doc: MessagesDoc = existsSync(messagesPath)
    ? (JSON.parse(readFileSync(messagesPath, 'utf8')) as MessagesDoc)
    : {};
  const metaInfo = (meta.metadata ?? {}) as Record<string, any>;

  db.prepare(
    `INSERT INTO sessions
       (session_id, source, provider, model, cwd, workspace_root, status, started_at,
        updated_at, prompt, title, tokens_in, tokens_out, cost, messages_path,
        system_prompt, raw_json, parent_session_id, parent_agent_id, is_subagent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       source=excluded.source, provider=excluded.provider, model=excluded.model,
       cwd=excluded.cwd, workspace_root=excluded.workspace_root, status=excluded.status,
       started_at=excluded.started_at, updated_at=excluded.updated_at,
       prompt=excluded.prompt, title=excluded.title, tokens_in=excluded.tokens_in,
       tokens_out=excluded.tokens_out, cost=excluded.cost,
       messages_path=excluded.messages_path, system_prompt=excluded.system_prompt,
       raw_json=excluded.raw_json, parent_session_id=excluded.parent_session_id,
       parent_agent_id=excluded.parent_agent_id, is_subagent=excluded.is_subagent`
  ).run(
    String(meta.session_id ?? id),
    meta.source ?? null,
    meta.provider ?? null,
    meta.model ?? null,
    meta.cwd ?? null,
    meta.workspace_root ?? null,
    meta.status ?? null,
    meta.started_at ?? null,
    doc.updated_at ?? null,
    meta.prompt ?? null,
    metaInfo.title ?? null,
    Number(metaInfo.tokensIn ?? 0) || null,
    Number(metaInfo.tokensOut ?? 0) || null,
    Number(metaInfo.totalCost ?? 0) || null,
    messagesPath,
    doc.system_prompt ?? null,
    JSON.stringify(meta),
    meta.parent_session_id ?? meta.parentSessionId ?? metaInfo.parentSessionId ?? null,
    meta.parent_agent_id ?? meta.parentAgentId ?? metaInfo.parentAgentId ?? null,
    meta.is_subagent === true || meta.isSubagent === true || metaInfo.isSubagent === true ? 1 : 0
  );

  db.prepare('DELETE FROM turns WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM tool_calls WHERE session_id = ?').run(id);

  const insertTurn = db.prepare(
    `INSERT INTO turns
       (session_id, turn_index, block_index, role, display_role, kind, text, text_seg,
        tool_name, tool_call_id, is_error, content_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertTool = db.prepare(
    `INSERT INTO tool_calls
       (session_id, turn_index, tool_call_id, tool_name, parameters_json,
        result_text, success, duration_ms, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const updateToolResult = db.prepare(
    `UPDATE tool_calls SET result_text = ?, success = ?, blob_hash = ?
     WHERE session_id = ? AND tool_call_id = ?`
  );

  const messages = doc.messages ?? [];
  messages.forEach((message, turnIndex) => {
    (message.content ?? []).forEach((block, blockIndex) => {
      let text: string | null = null;
      if (block.type === 'text') text = block.text ?? null;
      if (block.type === 'thinking') text = block.thinking ?? null;

      insertTurn.run(
        id,
        turnIndex,
        blockIndex,
        message.role ?? null,
        message.metadata?.displayRole ?? null,
        block.type ?? 'unknown',
        text,
        text ? segmentForSearch(text) : null,
        block.name ?? null,
        block.tool_use_id ?? block.id ?? null,
        block.is_error ? 1 : 0,
        JSON.stringify(block)
      );

      if (block.type === 'tool_use' && block.id) {
        insertTool.run(
          id,
          turnIndex,
          block.id,
          block.name ?? null,
          JSON.stringify(block.input ?? null),
          null,
          null,
          null,
          'session'
        );
      }
      if (block.type === 'tool_result' && block.tool_use_id) {
        let resultText =
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? null);
        let blobHash: string | null = null;
        if (resultText.length > 8192) {
          try {
            const blob = storeBlob(db, resultText);
            blobHash = blob.hash;
            resultText = `${resultText.slice(0, 2000)}\n\n[blob ${blob.hash} size=${blob.size}]`;
          } catch {
            blobHash = null;
          }
        }
        const items = Array.isArray(block.content) ? (block.content as Array<Record<string, unknown>>) : [];
        const success =
          block.is_error === true || items.some((item) => item.success === false) ? 0 : 1;
        updateToolResult.run(resultText, success, blobHash, id, block.tool_use_id);
      }
      if (
        block.type === 'image' ||
        block.type === 'file' ||
        block.type === 'document' ||
        block.type === 'attachment'
      ) {
        try {
          captureBlockAttachment(db, id, block as Record<string, any>);
        } catch {
          // Attachment capture is best effort.
        }
      }
    });
  });

  try {
    captureArtifacts(db, dir, id);
  } catch {
    // Checkpoint and artifact capture is best effort.
  }
  return true;
}

function captureBlockAttachment(
  db: DatabaseSync,
  sessionId: string,
  block: Record<string, any>
): void {
  const source = (block.source ?? {}) as Record<string, any>;
  const mime = String(
    source.media_type ?? block.mimeType ?? block.mime ?? 'application/octet-stream'
  );
  const data = source.data ?? block.data ?? block.base64;
  let blob: { hash: string; size: number } | null = null;
  let relpath: string | null = null;
  if (typeof data === 'string' && data.length > 0) {
    blob = storeBlobBuffer(db, Buffer.from(data, 'base64'));
  } else {
    const filePath = block.path ?? block.file_path ?? block.filePath;
    if (typeof filePath === 'string' && existsSync(filePath)) {
      blob = storeBlobBuffer(db, readFileSync(filePath));
      relpath = filePath;
    }
  }
  if (!blob) return;
  db.prepare(
    `INSERT OR IGNORE INTO attachments
       (origin, session_id, task_id, kind, mime, hash, relpath, size, created_at)
     VALUES ('session', ?, NULL, ?, ?, ?, ?, ?, ?)`
  ).run(sessionId, String(block.type ?? 'file'), mime, blob.hash, relpath, blob.size, new Date().toISOString());
}

function captureArtifacts(db: DatabaseSync, sessionDir: string, sessionId: string): void {
  const known = new Set([`${sessionId}.json`, `${sessionId}.messages.json`]);
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(sessionDir);
  const upsert = db.prepare(
    `INSERT INTO artifacts (session_id, relpath, hash, size, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id, relpath) DO UPDATE SET
       hash=excluded.hash, size=excluded.size, created_at=excluded.created_at`
  );
  for (const file of files) {
    const relpath = relative(sessionDir, file);
    if (known.has(relpath)) continue;
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) continue;
    const blob = storeBlobBuffer(db, readFileSync(file));
    upsert.run(sessionId, relpath, blob.hash, blob.size, new Date().toISOString());
  }
}

export function ingestAllSessions(db: DatabaseSync, root: string): number {
  let count = 0;
  for (const dir of discoverSessionDirs(root)) {
    if (ingestSessionDir(db, dir)) count += 1;
  }
  return count;
}

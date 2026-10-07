import type { DatabaseSync } from 'node:sqlite';
import { segmentedQueryTerms } from './tokenize.ts';

export interface RecallRow {
  id: number;
  session_id: string;
  turn_index: number;
  role: string | null;
  display_role: string | null;
  kind: string | null;
  snip: string;
  workspace_root: string | null;
  started_at: string | null;
  hook_task_id: string | null;
}

export interface SearchOptions {
  limit?: number;
  workspace?: string | null;
  excludeHookTaskId?: string | null;
  excludeSessionId?: string | null;
}

export interface CardRow {
  session_id: string;
  goal: string | null;
  outcome: string | null;
  tools_json: string | null;
  summary: string | null;
  decisions_json: string | null;
  open_questions_json: string | null;
  lessons_json: string | null;
  workspace_root: string | null;
  started_at: string | null;
}

export function ftsTokens(query: string): string[] {
  const raw = query
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of raw) {
    const trimmed = token.slice(0, 40);
    if (trimmed.length < 2 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    tokens.push(trimmed);
    if (tokens.length >= 8) break;
  }
  return tokens;
}

export function ftsQuery(query: string): string {
  const tokens = ftsTokens(query);
  if (tokens.length === 0) return '';
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ');
}

export function likeCandidates(query: string): string[] {
  const tokens = ftsTokens(query);
  const ascii = tokens.filter((token) => /^[\x00-\x7F]+$/.test(token));
  const cjk = tokens.filter((token) => !/^[\x00-\x7F]+$/.test(token));
  return [...ascii.sort((a, b) => a.length - b.length), ...cjk.sort((a, b) => a.length - b.length)];
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const SELECT_COLUMNS = `t.session_id, t.turn_index, t.role, t.display_role, t.kind,
         %SNIP% AS snip, s.workspace_root, s.started_at, s.hook_task_id`;

const EXCLUDE_TASK_CLAUSE = `(? IS NULL OR s.hook_task_id IS NULL OR s.hook_task_id != ?)`;
const EXCLUDE_SESSION_CLAUSE = `(? IS NULL OR t.session_id != ?)`;
const ORDER_CLAUSE = `CASE WHEN ? IS NOT NULL AND s.workspace_root = ? THEN 0 ELSE 1 END`;

export function searchTurns(
  db: DatabaseSync,
  query: string,
  options: SearchOptions = {}
): RecallRow[] {
  const limit = Math.max(1, Math.min(20, options.limit ?? 5));
  const workspace = options.workspace ?? null;
  const excludeTask = options.excludeHookTaskId ?? null;
  const excludeSession = options.excludeSessionId ?? null;
  const match = ftsQuery(query);

  const segTerms = segmentedQueryTerms(query);
  if (segTerms.length > 0) {
    try {
      const rows = db
        .prepare(
          `SELECT t.id AS id, ${SELECT_COLUMNS.replace('%SNIP%', 'substr(t.text, 1, 400)')}
           FROM turns_fts_seg
           JOIN turns t ON t.id = turns_fts_seg.rowid
           LEFT JOIN sessions s ON s.session_id = t.session_id
           WHERE turns_fts_seg MATCH ?
             AND ${EXCLUDE_SESSION_CLAUSE}
             AND ${EXCLUDE_TASK_CLAUSE}
           ORDER BY ${ORDER_CLAUSE}, rank, s.started_at DESC LIMIT ?`
        )
        .all(
          segTerms.join(' OR '),
          excludeSession,
          excludeSession,
          excludeTask,
          excludeTask,
          workspace,
          workspace,
          limit
        ) as RecallRow[];
      if (rows.length > 0) return rows;
    } catch {
      // Segmented index may not exist yet on an old database.
    }
  }

  if (match) {
    try {
      const rows = db
        .prepare(
          `SELECT t.id AS id, ${SELECT_COLUMNS.replace('%SNIP%', "snippet(turns_fts, 0, '', '', '...', 20)")}
           FROM turns_fts
           JOIN turns t ON t.id = turns_fts.rowid
           LEFT JOIN sessions s ON s.session_id = t.session_id
           WHERE turns_fts MATCH ?
             AND ${EXCLUDE_SESSION_CLAUSE}
             AND ${EXCLUDE_TASK_CLAUSE}
           ORDER BY ${ORDER_CLAUSE}, rank, s.started_at DESC LIMIT ?`
        )
        .all(
          match,
          excludeSession,
          excludeSession,
          excludeTask,
          excludeTask,
          workspace,
          workspace,
          limit
        ) as RecallRow[];
      if (rows.length > 0) return rows;
    } catch {
      // Fall through to the LIKE path.
    }
  }

  // Fallback for CJK phrases and partial matches that unicode61 does not segment.
  const likeStatement = db.prepare(
    `SELECT t.id AS id, ${SELECT_COLUMNS.replace('%SNIP%', 'substr(t.text, 1, 400)')}
     FROM turns t
     LEFT JOIN sessions s ON s.session_id = t.session_id
     WHERE t.text LIKE ?
       AND ${EXCLUDE_SESSION_CLAUSE}
       AND ${EXCLUDE_TASK_CLAUSE}
     ORDER BY ${ORDER_CLAUSE}, t.id DESC LIMIT ?`
  );
  for (const candidate of likeCandidates(query)) {
    const rows = likeStatement.all(
      `%${candidate}%`,
      excludeSession,
      excludeSession,
      excludeTask,
      excludeTask,
      workspace,
      workspace,
      limit
    ) as RecallRow[];
    if (rows.length > 0) return rows;
  }
  return [];
}

export function searchCards(
  db: DatabaseSync,
  query: string,
  options: SearchOptions = {}
): CardRow[] {
  const limit = Math.max(1, Math.min(10, options.limit ?? 3));
  const workspace = options.workspace ?? null;
  const excludeTask = options.excludeHookTaskId ?? null;
  const excludeSession = options.excludeSessionId ?? null;
  const cardExcludeSession = `(? IS NULL OR c.session_id != ?)`;
  const cardExcludeTask = `(? IS NULL OR s.hook_task_id IS NULL OR s.hook_task_id != ?)`;

  const segTerms = segmentedQueryTerms(query);
  if (segTerms.length > 0) {
    try {
      const rows = db
        .prepare(
          `SELECT c.session_id, c.goal, c.outcome, c.tools_json, c.summary,
                  c.decisions_json, c.open_questions_json, c.lessons_json,
                  s.workspace_root, s.started_at
           FROM session_cards_fts_seg
           JOIN session_cards c ON c.rowid = session_cards_fts_seg.rowid
           LEFT JOIN sessions s ON s.session_id = c.session_id
           WHERE session_cards_fts_seg MATCH ?
             AND ${cardExcludeSession}
             AND ${cardExcludeTask}
           ORDER BY ${ORDER_CLAUSE}, rank, s.started_at DESC LIMIT ?`
        )
        .all(
          segTerms.join(' OR '),
          excludeSession,
          excludeSession,
          excludeTask,
          excludeTask,
          workspace,
          workspace,
          limit
        ) as CardRow[];
      if (rows.length > 0) return rows;
    } catch {
      // Segmented card index may not exist on an old database.
    }
  }

  const match = ftsQuery(query);
  if (match) {
    try {
      const rows = db
        .prepare(
          `SELECT c.session_id, c.goal, c.outcome, c.tools_json, c.summary,
                  c.decisions_json, c.open_questions_json, c.lessons_json,
                  s.workspace_root, s.started_at
           FROM session_cards_fts
           JOIN session_cards c ON c.rowid = session_cards_fts.rowid
           LEFT JOIN sessions s ON s.session_id = c.session_id
           WHERE session_cards_fts MATCH ?
             AND ${cardExcludeSession}
             AND ${cardExcludeTask}
           ORDER BY ${ORDER_CLAUSE}, rank, s.started_at DESC LIMIT ?`
        )
        .all(
          match,
          excludeSession,
          excludeSession,
          excludeTask,
          excludeTask,
          workspace,
          workspace,
          limit
        ) as CardRow[];
      if (rows.length > 0) return rows;
    } catch {
      // Fall through to LIKE.
    }
  }

  try {
    const likeStatement = db.prepare(
      `SELECT c.session_id, c.goal, c.outcome, c.tools_json, c.summary,
              c.decisions_json, c.open_questions_json, c.lessons_json,
              s.workspace_root, s.started_at
       FROM session_cards c
       LEFT JOIN sessions s ON s.session_id = c.session_id
       WHERE (c.goal LIKE ? OR c.outcome LIKE ?)
         AND ${cardExcludeSession}
         AND ${cardExcludeTask}
       ORDER BY ${ORDER_CLAUSE}, s.started_at DESC LIMIT ?`
    );
    for (const candidate of likeCandidates(query)) {
      const rows = likeStatement.all(
        `%${candidate}%`,
        `%${candidate}%`,
        excludeSession,
        excludeSession,
        excludeTask,
        excludeTask,
        workspace,
        workspace,
        limit
      ) as CardRow[];
      if (rows.length > 0) return rows;
    }
  } catch {
    // Cards may not exist yet on an old database.
  }
  return [];
}

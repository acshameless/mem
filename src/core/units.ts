import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { segmentForSearch, segmentedQueryTerms } from './tokenize.ts';
import { ftsQuery, likeCandidates } from './recall.ts';

export interface MemoryUnitInput {
  type: string;
  statement: string;
  detail?: string | null;
  scope?: string;
  confidence?: number;
  status?: string;
  evidence?: unknown;
  sourceSession?: string | null;
  supersedesId?: number | null;
}

export interface MemoryUnitRow {
  id: number;
  type: string;
  statement: string;
  detail: string | null;
  scope: string;
  confidence: number;
  status: string;
  created_at: string | null;
  supersedes_id: number | null;
}

const UNIT_TYPES = new Set(['taste', 'preference', 'decision', 'fact', 'procedure', 'pitfall']);

export function insertUnit(db: DatabaseSync, unit: MemoryUnitInput): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO memory_units
         (type, statement, statement_seg, detail, detail_seg, scope, confidence, status,
          evidence_json, source_session, created_at, updated_at, supersedes_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      unit.type,
      unit.statement,
      segmentForSearch(unit.statement),
      unit.detail ?? null,
      unit.detail ? segmentForSearch(unit.detail) : null,
      unit.scope ?? 'person',
      Math.max(0, Math.min(1, unit.confidence ?? 0.5)),
      unit.status ?? 'candidate',
      unit.evidence ? JSON.stringify(unit.evidence) : null,
      unit.sourceSession ?? null,
      now,
      now,
      unit.supersedesId ?? null
    );
  return Number(result.lastInsertRowid ?? 0);
}

export function listUnits(
  db: DatabaseSync,
  options: { status?: string; limit?: number } = {}
): MemoryUnitRow[] {
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));
  if (options.status) {
    return db
      .prepare(
        `SELECT id, type, statement, detail, scope, confidence, status, created_at, supersedes_id
         FROM memory_units WHERE status = ? ORDER BY id DESC LIMIT ?`
      )
      .all(options.status, limit) as MemoryUnitRow[];
  }
  return db
    .prepare(
      `SELECT id, type, statement, detail, scope, confidence, status, created_at, supersedes_id
       FROM memory_units ORDER BY id DESC LIMIT ?`
    )
    .all(limit) as MemoryUnitRow[];
}

export function setUnitStatus(db: DatabaseSync, id: number, status: string): boolean {
  const now = new Date().toISOString();
  if (status === 'active') {
    const row = db
      .prepare('SELECT supersedes_id FROM memory_units WHERE id = ?')
      .get(id) as { supersedes_id: number | null } | undefined;
    if (row?.supersedes_id) {
      db.prepare(
        `UPDATE memory_units SET status = 'superseded', superseded_by = ?, updated_at = ?
         WHERE id = ?`
      ).run(id, now, row.supersedes_id);
    }
  }
  const result = db
    .prepare('UPDATE memory_units SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, now, id);
  return Number(result.changes ?? 0) > 0;
}

export function normalizeStatement(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .replace(/(用户|偏好|喜欢|习惯|倾向|要求|明确|一般|通常|应该|需要)/g, '');
}

export function statementHash(statement: string): string {
  return createHash('sha256').update(normalizeStatement(statement)).digest('hex');
}

export function findSimilarUnit(
  db: DatabaseSync,
  statement: string
): number | null {
  const normalized = normalizeStatement(statement);
  if (normalized.length < 4) return null;
  try {
    const forgotten = db
      .prepare(`SELECT 1 FROM forget_list WHERE kind = 'unit-statement' AND value = ? LIMIT 1`)
      .get(statementHash(statement));
    if (forgotten) return -1;
  } catch {
    // forget_list may not exist on an old database.
  }
  const rows = db
    .prepare('SELECT id, statement FROM memory_units')
    .all() as Array<{ id: number; statement: string }>;
  for (const row of rows) {
    const other = normalizeStatement(row.statement);
    if (other === normalized) return row.id;
    if (other.length >= 4 && normalized.length >= 4) {
      const bigrams = (text: string) => {
        const set = new Set<string>();
        for (let index = 0; index + 1 < text.length; index += 1) set.add(text.slice(index, index + 2));
        return set;
      };
      const a = bigrams(normalized);
      const b = bigrams(other);
      let intersection = 0;
      for (const gram of a) if (b.has(gram)) intersection += 1;
      const dice = (2 * intersection) / (a.size + b.size);
      const containment = intersection / Math.min(a.size, b.size);
      const lengthRatio =
        Math.min(a.size, b.size) / Math.max(a.size, b.size || Number.MIN_SAFE_INTEGER);
      if (lengthRatio >= 0.6 && (dice >= 0.7 || containment >= 0.75)) return row.id;
    }
  }
  return null;
}

export function searchUnits(
  db: DatabaseSync,
  query: string,
  options: { types?: string[]; scope?: string | null; limit?: number } = {}
): MemoryUnitRow[] {
  const limit = Math.max(1, Math.min(20, options.limit ?? 5));
  const types = options.types && options.types.length > 0 ? options.types : [...UNIT_TYPES];
  const typeList = types.map(() => '?').join(', ');
  const scope = options.scope ?? null;
  const scopeClause = `(? IS NULL OR scope = 'person' OR scope = ?)`;
  const select = `SELECT id, type, statement, detail, scope, confidence, status, created_at
                  FROM memory_units WHERE status = 'active' AND type IN (${typeList})`;

  const segTerms = segmentedQueryTerms(query);
  if (segTerms.length > 0) {
    try {
      const rows = db
        .prepare(
          `${select}
             AND rowid IN (SELECT rowid FROM memory_units_fts_seg WHERE memory_units_fts_seg MATCH ?)
             AND ${scopeClause}
           ORDER BY confidence DESC, id DESC LIMIT ?`
        )
        .all(...types, segTerms.join(' OR '), scope, scope, limit) as MemoryUnitRow[];
      if (rows.length > 0) return rows;
    } catch {
      // Index may not exist yet.
    }
  }

  const match = ftsQuery(query);
  if (match) {
    try {
      const rows = db
        .prepare(
          `${select}
             AND rowid IN (SELECT rowid FROM memory_units_fts WHERE memory_units_fts MATCH ?)
             AND ${scopeClause}
           ORDER BY confidence DESC, id DESC LIMIT ?`
        )
        .all(...types, match, scope, scope, limit) as MemoryUnitRow[];
      if (rows.length > 0) return rows;
    } catch {
      // Fall through to LIKE.
    }
  }

  try {
    const statement = db.prepare(
      `${select} AND (statement LIKE ? OR detail LIKE ?) AND ${scopeClause}
       ORDER BY confidence DESC, id DESC LIMIT ?`
    );
    for (const candidate of likeCandidates(query)) {
      const rows = statement.all(
        ...types,
        `%${candidate}%`,
        `%${candidate}%`,
        scope,
        scope,
        limit
      ) as MemoryUnitRow[];
      if (rows.length > 0) return rows;
    }
  } catch {
    // No units table yet.
  }
  return [];
}

export function topPersonUnits(db: DatabaseSync, limit = 2): MemoryUnitRow[] {
  try {
    return db
      .prepare(
        `SELECT id, type, statement, detail, scope, confidence, status, created_at
         FROM memory_units
         WHERE status = 'active' AND scope = 'person'
         ORDER BY confidence DESC, id DESC LIMIT ?`
      )
      .all(limit) as MemoryUnitRow[];
  } catch {
    return [];
  }
}

export function applyFeedback(
  db: DatabaseSync,
  unitId: number,
  signal: 'useful' | 'wrong',
  note?: string
): { confidence: number; status: string } | null {
  const unit = db
    .prepare('SELECT id, confidence, status FROM memory_units WHERE id = ?')
    .get(unitId) as { id: number; confidence: number; status: string } | undefined;
  if (!unit) return null;
  const delta = signal === 'useful' ? 0.05 : -0.15;
  const confidence = Math.max(0, Math.min(1, Number(unit.confidence) + delta));
  const status = confidence < 0.2 && unit.status === 'active' ? 'candidate' : unit.status;
  const now = new Date().toISOString();
  db.prepare('UPDATE memory_units SET confidence = ?, status = ?, updated_at = ? WHERE id = ?').run(
    confidence,
    status,
    now,
    unitId
  );
  db.prepare(
    'INSERT INTO unit_feedback (unit_id, signal, note, created_at) VALUES (?, ?, ?, ?)'
  ).run(unitId, signal, note ?? null, now);
  return { confidence, status };
}

// Refresh usage counters from the injection log.
export function updateUnitUsage(db: DatabaseSync): number {
  const usage = new Map<number, number>();
  try {
    const rows = db.prepare('SELECT unit_ids_json FROM injections').all() as Array<{
      unit_ids_json: string | null;
    }>;
    for (const row of rows) {
      try {
        for (const id of JSON.parse(row.unit_ids_json ?? '[]') as number[]) {
          usage.set(id, (usage.get(id) ?? 0) + 1);
        }
      } catch {
        // Ignore malformed rows.
      }
    }
  } catch {
    return 0;
  }
  const update = db.prepare('UPDATE memory_units SET use_count = ? WHERE id = ?');
  let updated = 0;
  for (const [id, count] of usage) {
    updated += Number(update.run(count, id).changes ?? 0);
  }
  return updated;
}

export function decayStaleUnits(db: DatabaseSync, days = 14): number {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT id, confidence FROM memory_units
       WHERE status = 'active' AND (use_count IS NULL OR use_count = 0)
         AND created_at IS NOT NULL AND created_at < ?`
    )
    .all(cutoff) as Array<{ id: number; confidence: number }>;
  const update = db.prepare('UPDATE memory_units SET confidence = ?, updated_at = ? WHERE id = ?');
  const now = new Date().toISOString();
  for (const row of rows) {
    update.run(Math.max(0, Number(row.confidence) - 0.05), now, row.id);
  }
  return rows.length;
}

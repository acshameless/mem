import type { DatabaseSync } from 'node:sqlite';
import type { DistillConfig } from '../core/config.ts';
import { redactSecrets } from '../core/redact.ts';
import { findSimilarUnit, insertUnit } from '../core/units.ts';
import { buildDistillMessages, parseDistillResult } from './prompt.ts';
import type { ActiveUnit } from './prompt.ts';
import { chatComplete, type FetchLike } from './provider.ts';

export interface DistillOptions {
  limit?: number;
  sessionId?: string;
  dryRun?: boolean;
  fetchImpl?: FetchLike;
  quietMinutes?: number;
  reDistillOnChange?: boolean;
}

export interface DistillSummary {
  sessions: number;
  units: number;
  skippedDuplicates: number;
  skippedSemanticDuplicates: number;
  skippedQuiet: number;
  skippedDistilled: number;
  errors: number;
  usage: Array<Record<string, unknown>>;
}

interface SessionRow {
  session_id: string;
  workspace_root: string | null;
  started_at: string | null;
  updated_at: string | null;
  model: string | null;
  distilled_at: string | null;
  distill_status: string | null;
}

export function buildBundle(
  db: DatabaseSync,
  session: SessionRow,
  maxChars: number
): string {
  const turns = db
    .prepare(
      `SELECT turn_index, role, kind, text FROM turns
       WHERE session_id = ? AND kind IN ('text', 'thinking') AND text IS NOT NULL
         AND (display_role IS NULL OR display_role != 'system')
       ORDER BY turn_index, block_index LIMIT 80`
    )
    .all(session.session_id) as Array<{
    turn_index: number;
    role: string | null;
    kind: string;
    text: string;
  }>;
  const tools = db
    .prepare(
      `SELECT tool_name, count(*) c FROM tool_calls
       WHERE session_id = ? AND tool_name IS NOT NULL GROUP BY tool_name`
    )
    .all(session.session_id) as Array<{ tool_name: string; c: number }>;
  const trajectory = db
    .prepare(
      `SELECT tool_name, parameters_json, result_text, success, duration_ms
       FROM tool_calls WHERE session_id = ? AND tool_name IS NOT NULL ORDER BY id LIMIT 40`
    )
    .all(session.session_id) as Array<{
    tool_name: string;
    parameters_json: string | null;
    result_text: string | null;
    success: number | null;
    duration_ms: number | null;
  }>;

  let bundle =
    `SESSION ${session.session_id}\n` +
    `DATE ${session.started_at ?? ''}\n` +
    `WORKSPACE ${session.workspace_root ?? ''}\n` +
    `MODEL ${session.model ?? ''}\n` +
    `TOOLS ${tools.map((row) => `${row.tool_name}×${row.c}`).join(', ')}\n\n`;
  if (trajectory.length > 0) {
    bundle += 'TRAJECTORY (tool → outcome; include skills and MCP calls):\n';
    trajectory.forEach((call, index) => {
      const args = String(call.parameters_json ?? '').replace(/\s+/g, ' ').slice(0, 160);
      const result = String(call.result_text ?? '').replace(/\s+/g, ' ').slice(0, 160);
      const outcome =
        call.success === 0 ? 'failed' : call.success === 1 ? 'ok' : 'unknown';
      bundle +=
        `[${index + 1}] ${call.tool_name}(${args}) -> ${outcome}` +
        `${call.duration_ms != null ? ` in ${call.duration_ms}ms` : ''}` +
        `${result ? `; result: ${result}` : ''}\n`;
    });
    bundle += '\n';
  }
  for (const turn of turns) {
    const role =
      turn.kind === 'thinking'
        ? 'THINKING'
        : turn.role === 'user'
          ? 'USER'
          : 'ASSISTANT';
    const text = turn.kind === 'thinking' ? turn.text.slice(0, 240) : turn.text;
    bundle += `[${role}] ${text}\n\n`;
    if (bundle.length >= maxChars) break;
  }
  return bundle.slice(0, maxChars);
}

export async function distillSessions(
  db: DatabaseSync,
  config: DistillConfig,
  options: DistillOptions = {}
): Promise<DistillSummary> {
  const limit = Math.max(1, options.limit ?? config.maxSessionsPerRun);
  const allSessions = db
    .prepare(
      `SELECT s.session_id, s.workspace_root, s.started_at, s.updated_at, s.model,
              d.distilled_at, d.status AS distill_status
       FROM sessions s
       LEFT JOIN distill_state d ON d.session_id = s.session_id
       ${options.sessionId ? 'WHERE s.session_id = ?' : ''}
       ORDER BY s.started_at ASC`
    )
    .all(...(options.sessionId ? [options.sessionId] : [])) as SessionRow[];

  const quietMs = Math.max(0, options.quietMinutes ?? 0) * 60_000;
  const nowMs = Date.now();
  let skippedQuiet = 0;
  let skippedDistilled = 0;
  const sessions = allSessions
    .filter((session) => {
      const updated = Date.parse(session.updated_at ?? session.started_at ?? '');
      if (quietMs > 0 && Number.isFinite(updated) && nowMs - updated < quietMs) {
        skippedQuiet += 1;
        return false;
      }
      if (!session.distill_status || session.distill_status === 'error') return true;
      if (session.distill_status !== 'done') {
        skippedDistilled += 1;
        return false;
      }
      if (options.reDistillOnChange === false) {
        skippedDistilled += 1;
        return false;
      }
      const distilled = Date.parse(session.distilled_at ?? '');
      const changed =
        Number.isFinite(updated) && Number.isFinite(distilled) && updated > distilled + 2000;
      if (!changed) skippedDistilled += 1;
      return changed;
    })
    .slice(0, limit);

  const summary: DistillSummary = {
    sessions: 0,
    units: 0,
    skippedDuplicates: 0,
    skippedSemanticDuplicates: 0,
    skippedQuiet,
    skippedDistilled,
    errors: 0,
    usage: [],
  };
  const markState = db.prepare(
    `INSERT INTO distill_state (session_id, distilled_at, model, units_created, status, error)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       distilled_at=excluded.distilled_at, model=excluded.model,
       units_created=excluded.units_created, status=excluded.status, error=excluded.error`
  );

  for (const session of sessions) {
    summary.sessions += 1;
    try {
      const bundle = redactSecrets(buildBundle(db, session, config.maxCharsPerSession));
      const activeUnits = db
        .prepare(
          `SELECT id, type, statement, scope FROM memory_units
           WHERE status = 'active' ORDER BY confidence DESC, id DESC LIMIT 50`
        )
        .all() as ActiveUnit[];
      const messages = buildDistillMessages(bundle, activeUnits);
      const result = await chatComplete(config, messages, options.fetchImpl ?? fetch);
      if (result.usage) summary.usage.push(result.usage);
      const { units, session: sessionSummary } = parseDistillResult(result.text);
      if (sessionSummary && !options.dryRun) {
        db.prepare(
          `INSERT INTO session_cards
             (session_id, summary, decisions_json, open_questions_json, lessons_json, generated_by, generated_at)
           VALUES (?, ?, ?, ?, ?, 'llm', ?)
           ON CONFLICT(session_id) DO UPDATE SET
             summary=excluded.summary, decisions_json=excluded.decisions_json,
             open_questions_json=excluded.open_questions_json,
             lessons_json=excluded.lessons_json,
             generated_by='llm', generated_at=excluded.generated_at`
        ).run(
          session.session_id,
          sessionSummary.summary,
          JSON.stringify(sessionSummary.decisions),
          JSON.stringify(sessionSummary.openQuestions),
          JSON.stringify(sessionSummary.lessons),
          new Date().toISOString(),
        );
      }
      let created = 0;
      for (const unit of units) {
        if (unit.relation === 'duplicate') {
          summary.skippedSemanticDuplicates += 1;
          continue;
        }
        let supersedesId: number | null = null;
        if (unit.relation === 'supersedes' && unit.targetId) {
          const target = db
            .prepare(`SELECT id FROM memory_units WHERE id = ? AND status = 'active'`)
            .get(unit.targetId) as { id: number } | undefined;
          if (target) supersedesId = target.id;
        }
        if (options.dryRun) {
          created += 1;
          continue;
        }
        const duplicate = findSimilarUnit(db, unit.statement) !== null;
        if (duplicate) {
          summary.skippedDuplicates += 1;
          continue;
        }
        const evidence = unit.evidence.map((item) =>
          typeof item === 'object' && item !== null
            ? { ...(item as Record<string, unknown>), session_id: session.session_id }
            : { quote: String(item), session_id: session.session_id }
        );
        const scope =
          unit.scope === 'workspace' && session.workspace_root ? session.workspace_root : unit.scope;
        insertUnit(db, {
          type: unit.type,
          statement: unit.statement,
          detail: unit.detail,
          scope,
          confidence: unit.confidence,
          status: 'candidate',
          evidence,
          sourceSession: session.session_id,
          supersedesId,
        });
        created += 1;
        summary.units += 1;
      }
      if (!options.dryRun) {
        markState.run(
          session.session_id,
          new Date().toISOString(),
          config.model,
          created,
          'done',
          null
        );
      }
    } catch (error) {
      summary.errors += 1;
      if (!options.dryRun) {
        markState.run(
          session.session_id,
          new Date().toISOString(),
          config.model,
          0,
          'error',
          String(error).slice(0, 500)
        );
      }
    }
  }

  return summary;
}

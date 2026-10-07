import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { segmentForSearch } from '../core/tokenize.ts';
import { isForgotten } from '../core/forget.ts';

interface CodexEvent {
  timestamp?: string;
  type?: string;
  payload?: Record<string, any>;
}

interface CodexTurn {
  role: string;
  kind: 'text' | 'tool_use' | 'tool_result';
  text: string;
  toolName?: string;
  toolCallId?: string;
}

function walkJsonl(dir: string): string[] {
  const files: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    try {
      if (statSync(path).isDirectory()) files.push(...walkJsonl(path));
      else if (entry.endsWith('.jsonl')) files.push(path);
    } catch {
      // Skip unreadable entries.
    }
  }
  return files;
}

function isScaffolding(text: string): boolean {
  return (
    text.startsWith('<environment_context') ||
    text.startsWith('<skills_instructions') ||
    text.startsWith('<user_instructions') ||
    text.startsWith('<multi_agent_mode')
  );
}

export function codexSessionsRoot(): string {
  return process.env.CODEX_SESSIONS_DIR ?? join(homedir(), '.codex', 'sessions');
}

export function ingestCodexDir(db: DatabaseSync, root: string): number {
  if (!existsSync(root)) return 0;
  let sessions = 0;
  for (const file of walkJsonl(root)) {
    const events: CodexEvent[] = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as CodexEvent);
      } catch {
        // Skip malformed lines.
      }
    }
    if (events.length === 0) continue;
    const meta = events.find((event) => event.type === 'session_meta')?.payload ?? {};
    const sessionId = String(
      meta.session_id ??
        meta.id ??
        file.split('/').pop()?.replace(/^rollout-/, '').replace(/\.jsonl$/, '') ??
        ''
    );
    if (!sessionId || isForgotten(db, 'session', sessionId)) continue;

    const turns: CodexTurn[] = [];
    const toolCalls: Array<{ callId: string; name: string; args: string; output?: string }> = [];
    for (const event of events) {
      if (event.type !== 'response_item' || !event.payload) continue;
      const payload = event.payload;
      if (payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
        const text = (payload.content ?? [])
          .filter((block: Record<string, any>) => block.type === 'input_text' || block.type === 'output_text')
          .map((block: Record<string, any>) => String(block.text ?? ''))
          .join('\n')
          .trim();
        if (!text || isScaffolding(text)) continue;
        turns.push({ role: payload.role, kind: 'text', text });
      } else if (payload.type === 'function_call') {
        const callId = String(payload.call_id ?? payload.id ?? '');
        turns.push({
          role: 'assistant',
          kind: 'tool_use',
          text: '',
          toolName: String(payload.name ?? 'tool'),
          toolCallId: callId,
        });
        toolCalls.push({ callId, name: String(payload.name ?? 'tool'), args: String(payload.arguments ?? '') });
      } else if (payload.type === 'function_call_output') {
        const callId = String(payload.call_id ?? '');
        const output =
          typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '');
        turns.push({
          role: 'user',
          kind: 'tool_result',
          text: output,
          toolName: 'tool',
          toolCallId: callId,
        });
        const call = toolCalls.find((item) => item.callId === callId);
        if (call) call.output = output;
      }
    }
    if (turns.length === 0) continue;

    const timestamps = events.map((event) => event.timestamp).filter((value): value is string => !!value);
    const firstUser = turns.find((turn) => turn.role === 'user' && turn.kind === 'text');
    db.prepare(
      `INSERT INTO sessions
         (session_id, source, provider, model, cwd, workspace_root, status, started_at, updated_at, prompt, raw_json,
          parent_session_id, is_subagent)
       VALUES (?, 'codex', ?, ?, ?, ?, 'completed', ?, ?, ?, '{}', ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         updated_at=excluded.updated_at, prompt=excluded.prompt,
         provider=excluded.provider, model=excluded.model`
    ).run(
      sessionId,
      meta.model_provider ?? null,
      meta.model ?? null,
      meta.cwd ?? null,
      (meta.runtime_workspace_roots ?? [])[0] ?? meta.cwd ?? null,
      timestamps[0] ?? meta.timestamp ?? null,
      timestamps[timestamps.length - 1] ?? null,
      firstUser?.text ?? null,
      meta.parent_session_id ?? meta.parentSessionId ?? null,
      meta.is_subagent === true || meta.isSubagent === true ? 1 : 0
    );

    db.prepare('DELETE FROM turns WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM tool_calls WHERE session_id = ?').run(sessionId);
    const insertTurn = db.prepare(
      `INSERT INTO turns
         (session_id, turn_index, block_index, role, display_role, kind, text, text_seg,
          tool_name, tool_call_id, content_json)
       VALUES (?, ?, 0, ?, NULL, ?, ?, ?, ?, ?, '{}')`
    );
    const insertTool = db.prepare(
      `INSERT INTO tool_calls
         (session_id, turn_index, tool_call_id, tool_name, parameters_json, result_text, success, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'codex')`
    );
    turns.forEach((turn, index) => {
      insertTurn.run(
        sessionId,
        index,
        turn.role,
        turn.kind,
        turn.text || null,
        turn.text ? segmentForSearch(turn.text) : null,
        turn.toolName ?? null,
        turn.toolCallId ?? null
      );
    });
    for (const call of toolCalls) {
      insertTool.run(
        sessionId,
        turns.findIndex((turn) => turn.toolCallId === call.callId),
        call.callId,
        call.name,
        call.args,
        call.output ?? null,
        call.output ? 1 : null
      );
    }
    sessions += 1;
  }
  return sessions;
}

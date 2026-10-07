import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { memHome } from '../core/paths.ts';
import { defaultHooksDir, hooksDoctor } from '../core/hooks_doctor.ts';
import { dirname } from 'node:path';
import { ingestHookAttachments } from '../ingest/attachments.ts';
import { updateSessionLifecycle } from '../ingest/lifecycle.ts';
import { ingestSessionDir } from '../ingest/sessions.ts';

// Re-read one session from disk. This makes acceptance deterministic and
// independent of the daemon version that is currently running.
function reingestSession(db: DatabaseSync, sessionId: string): void {
  const row = db
    .prepare('SELECT messages_path FROM sessions WHERE session_id = ?')
    .get(sessionId) as { messages_path: string | null } | undefined;
  if (row?.messages_path && existsSync(row.messages_path)) {
    try {
      ingestSessionDir(db, dirname(row.messages_path));
    } catch {
      // Best effort: verification below reports the result.
    }
  }
  try {
    ingestHookAttachments(db);
    updateSessionLifecycle(db);
  } catch {
    // Best effort.
  }
}

export interface AcceptanceStep {
  id: string;
  title: string;
  status: 'pass' | 'fail' | 'skip' | 'manual';
  detail: string;
}

function count(db: DatabaseSync, sql: string, ...params: unknown[]): number {
  try {
    return (db.prepare(sql).get(...params) as { c: number }).c;
  } catch {
    return 0;
  }
}

export function nonce(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// Verify one completed acceptance session. Used by the interactive runner and
// by tests.
export function verifySession(db: DatabaseSync, marker: string): AcceptanceStep[] {
  const steps: AcceptanceStep[] = [];
  const session = db
    .prepare(
      `SELECT session_id, hook_task_id, lifecycle, messages_path
       FROM sessions WHERE prompt LIKE ? COLLATE NOCASE ORDER BY started_at DESC LIMIT 1`
    )
    .get(`%${marker}%`) as
    | { session_id: string; hook_task_id: string | null; lifecycle: string | null; messages_path: string | null }
    | undefined;

  steps.push({
    id: 'session',
    title: 'Cline session captured',
    status: session ? 'pass' : 'fail',
    detail: session ? session.session_id : `no session contains ${marker}`,
  });
  if (!session) return steps;

  const events = session.hook_task_id
    ? count(db, 'SELECT count(*) c FROM hook_events WHERE task_id = ?', session.hook_task_id)
    : 0;
  steps.push({
    id: 'hooks',
    title: 'hook events for the session',
    status: events >= 2 ? 'pass' : 'fail',
    detail: `${events} event(s)`,
  });

  const turns = count(db, 'SELECT count(*) c FROM turns WHERE session_id = ?', session.session_id);
  steps.push({
    id: 'turns',
    title: 'conversation turns stored',
    status: turns >= 2 ? 'pass' : 'fail',
    detail: `${turns} turn(s)`,
  });

  let injected = false;
  if (session.messages_path && existsSync(session.messages_path)) {
    injected = readFileSync(session.messages_path, 'utf8').includes('<hook_context');
  }
  steps.push({
    id: 'injection',
    title: 'memory block injected into the session',
    status: injected ? 'pass' : 'fail',
    detail: injected ? 'hook_context found' : 'no hook_context in messages.json',
  });

  steps.push({
    id: 'lifecycle',
    title: 'session lifecycle',
    status: session.lifecycle === 'completed' ? 'pass' : 'manual',
    detail: session.lifecycle ?? 'unknown',
  });
  return steps;
}

function staticChecks(db: DatabaseSync): AcceptanceStep[] {
  const steps: AcceptanceStep[] = [];
  const hooks = hooksDoctor(db, defaultHooksDir());
  const bad = hooks.filter((row) => row.health === 'missing' || row.health === 'not_executable');
  steps.push({
    id: 'hooks_installed',
    title: '9 hooks installed and executable',
    status: bad.length === 0 ? 'pass' : 'fail',
    detail: bad.length === 0 ? 'ok' : bad.map((row) => `${row.event}:${row.health}`).join(', '),
  });
  const sessions = count(db, 'SELECT count(*) c FROM sessions');
  steps.push({
    id: 'store',
    title: 'store reachable',
    status: sessions > 0 ? 'pass' : 'manual',
    detail: `${sessions} session(s)`,
  });
  return steps;
}

async function waitForSession(
  db: DatabaseSync,
  marker: string,
  timeoutMs: number,
  sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<{ found: boolean; seenInRaw: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let seenInRaw = false;
  let lastNotice = 0;
  while (Date.now() < deadline) {
    const found = count(
      db,
      'SELECT count(*) c FROM sessions WHERE prompt LIKE ? COLLATE NOCASE',
      `%${marker}%`
    );
    if (found > 0) return { found: true, seenInRaw };
    try {
      const dir = join(memHome(), 'raw', 'hooks');
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.jsonl')) continue;
        if (readFileSync(join(dir, name), 'utf8').includes(marker)) {
          seenInRaw = true;
          break;
        }
      }
    } catch {
      // The raw directory may not exist yet.
    }
    if (Date.now() - lastNotice > 20000) {
      lastNotice = Date.now();
      console.log(`  still waiting (${Math.round((deadline - Date.now()) / 1000)}s left). Send the prompt in a NEW Cline task.`);
    }
    await sleep(2000);
  }
  return { found: false, seenInRaw };
}

export interface AcceptanceOptions {
  check?: boolean;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function runAcceptance(
  db: DatabaseSync,
  options: AcceptanceOptions = {}
): Promise<number> {
  const steps: AcceptanceStep[] = [];
  steps.push(...staticChecks(db));

  if (!options.check) {
    const marker = `MEM-ACCEPT-${nonce()}`;
    console.log('');
    console.log('== Step 1: basic turn ==');
    console.log('This tool cannot press keys. You must send the prompt in VS Code.');
    console.log('1. Open VS Code and Cline.');
    console.log('2. Start a NEW task.');
    console.log(`3. Paste and send exactly:  ${marker}。请只回复 OK。`);
    console.log(`Waiting up to ${Math.round((options.timeoutMs ?? 180000) / 1000)}s...`);
    const wait1 = await waitForSession(db, marker, options.timeoutMs ?? 180000, options.sleep);
    if (wait1.found) {
      const found = db
        .prepare('SELECT session_id FROM sessions WHERE prompt LIKE ? COLLATE NOCASE ORDER BY started_at DESC LIMIT 1')
        .get(`%${marker}%`) as { session_id: string } | undefined;
      if (found) reingestSession(db, found.session_id);
      steps.push(...verifySession(db, marker));
    } else {
      steps.push({
        id: 'session',
        title: 'Cline session captured',
        status: 'fail',
        detail: wait1.seenInRaw
          ? `hook event found in raw/hooks, but the database has no session (check the daemon)`
          : `no hook event and no session for ${marker}: the prompt was not sent in Cline, or hooks did not fire`,
      });
    }

    if (!wait1.found) {
      steps.push({
        id: 'attachment',
        title: 'image attachment stored',
        status: 'skip',
        detail: 'skipped because step 1 failed',
      });
    } else {
    const attachMarker = `MEM-ATTACH-${nonce()}`;
    console.log('');
    console.log('== Step 2: attachment ==');
    console.log('1. Start a NEW Cline task.');
    console.log('2. Attach one image.');
    console.log(`3. Paste and send exactly:  ${attachMarker}。描述这张图。`);
    const wait2 = await waitForSession(db, attachMarker, options.timeoutMs ?? 180000, options.sleep);
    if (wait2.found) {
      const session = db
        .prepare('SELECT session_id FROM sessions WHERE prompt LIKE ? COLLATE NOCASE ORDER BY started_at DESC LIMIT 1')
        .get(`%${attachMarker}%`) as { session_id: string } | undefined;
      let attachments = 0;
      if (session) {
        // The image block can arrive a moment after the first message.
        for (let attempt = 0; attempt < 5 && attachments === 0; attempt += 1) {
          reingestSession(db, session.session_id);
          attachments = count(
            db,
            'SELECT count(*) c FROM attachments WHERE session_id = ?',
            session.session_id
          );
          if (attachments === 0) await (options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))))(2000);
        }
      }
      steps.push({
        id: 'attachment',
        title: 'image attachment stored',
        status: attachments > 0 ? 'pass' : 'fail',
        detail: `${attachments} attachment row(s)`,
      });
    } else {
      steps.push({
        id: 'attachment',
        title: 'image attachment stored',
        status: 'fail',
        detail: wait2.seenInRaw
          ? 'hook event found, but the database has no session (check the daemon)'
          : 'no hook event: the attachment prompt was not sent',
      });
    }
    }

    // Step 3: @nomem must suppress injection but keep capture.
    const nomemMarker = `MEM-NOMEM-${nonce()}`;
    console.log('');
    console.log('== Step 3: @nomem switch ==');
    console.log('1. Start a NEW Cline task.');
    console.log(`2. Paste and send exactly:  ${nomemMarker} @nomem 请只回复 OK。`);
    const wait3 = await waitForSession(db, nomemMarker, options.timeoutMs ?? 180000, options.sleep);
    if (wait3.found) {
      const row = db
        .prepare(
          'SELECT session_id, messages_path FROM sessions WHERE prompt LIKE ? COLLATE NOCASE ORDER BY started_at DESC LIMIT 1'
        )
        .get(`%${nomemMarker}%`) as { session_id: string; messages_path: string | null } | undefined;
      if (row) reingestSession(db, row.session_id);
      let suppressed = false;
      if (row?.messages_path && existsSync(row.messages_path)) {
        suppressed = !readFileSync(row.messages_path, 'utf8').includes('<hook_context');
      }
      steps.push({
        id: 'nomem',
        title: '@nomem suppresses injection',
        status: row ? (suppressed ? 'pass' : 'fail') : 'fail',
        detail: row ? (suppressed ? 'no hook_context found' : 'hook_context was injected') : 'session not found',
      });
    } else {
      steps.push({
        id: 'nomem',
        title: '@nomem suppresses injection',
        status: 'fail',
        detail: 'timeout: prompt not sent',
      });
    }

    // Step 4: an MCP tool call must be recorded.
    const mcpMarker = `MEM-MCP-${nonce()}`;
    console.log('');
    console.log('== Step 4: MCP tool ==');
    console.log('1. Start a NEW Cline task.');
    console.log(`2. Paste and send exactly:  ${mcpMarker}。请调用 mem_status 工具，然后只回复 OK。`);
    const wait4 = await waitForSession(db, mcpMarker, options.timeoutMs ?? 180000, options.sleep);
    if (wait4.found) {
      const row = db
        .prepare(
          'SELECT session_id FROM sessions WHERE prompt LIKE ? COLLATE NOCASE ORDER BY started_at DESC LIMIT 1'
        )
        .get(`%${mcpMarker}%`) as { session_id: string } | undefined;
      let calls = 0;
      if (row) {
        for (let attempt = 0; attempt < 5 && calls === 0; attempt += 1) {
          reingestSession(db, row.session_id);
          calls = count(
            db,
            `SELECT count(*) c FROM tool_calls WHERE session_id = ? AND tool_name LIKE 'mem_%'`,
            row.session_id
          );
          if (calls === 0) await (options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))))(2000);
        }
      }
      steps.push({
        id: 'mcp',
        title: 'MCP tool call recorded',
        status: calls > 0 ? 'pass' : 'fail',
        detail: `${calls} MCP call(s)`,
      });
    } else {
      steps.push({
        id: 'mcp',
        title: 'MCP tool call recorded',
        status: 'fail',
        detail: 'timeout: prompt not sent',
      });
    }
  }

  const reportDir = join(memHome(), 'acceptance');
  const failed = steps.filter((step) => step.status === 'fail').length;
  const report =
    `# mem acceptance ${new Date().toISOString()}\n\n` +
    steps
      .map((step) => `- [${step.status}] ${step.id}: ${step.title} — ${step.detail}`)
      .join('\n') +
    `\n\nfailures: ${failed}\n`;
  let reportPath: string | null = null;
  try {
    mkdirSync(reportDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    reportPath = join(reportDir, `${stamp}.md`);
    writeFileSync(reportPath, report, { mode: 0o600 });
  } catch {
    reportPath = null;
  }
  console.log('');
  for (const step of steps) console.log(`[${step.status}] ${step.id}: ${step.title} — ${step.detail}`);
  console.log('');
  console.log(reportPath ? `report: ${reportPath}` : 'report: not written (read-only store)');
  console.log('For GUI steps that need a click (cancel, compaction, MCP), use docs/manual-acceptance.md.');
  return failed > 0 ? 1 : 0;
}

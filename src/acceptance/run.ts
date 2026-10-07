import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { memHome } from '../core/paths.ts';
import { defaultHooksDir, hooksDoctor } from '../core/hooks_doctor.ts';

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
       FROM sessions WHERE prompt LIKE ? ORDER BY started_at DESC LIMIT 1`
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
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = count(db, 'SELECT count(*) c FROM sessions WHERE prompt LIKE ?', `%${marker}%`);
    if (found > 0) return true;
    await sleep(2000);
  }
  return false;
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
    console.log('Open VS Code. Start a NEW Cline task in any workspace.');
    console.log(`Send this prompt:  ${marker}。请只回复 OK。`);
    console.log(`Waiting up to ${Math.round((options.timeoutMs ?? 180000) / 1000)}s for the session...`);
    if (await waitForSession(db, marker, options.timeoutMs ?? 180000, options.sleep)) {
      steps.push(...verifySession(db, marker));
    } else {
      steps.push({
        id: 'session',
        title: 'Cline session captured',
        status: 'fail',
        detail: `timeout: no session with ${marker}`,
      });
    }

    const attachMarker = `MEM-ATTACH-${nonce()}`;
    console.log('');
    console.log('== Step 2: attachment ==');
    console.log(`Start a NEW task, attach one image, send:  ${attachMarker}。描述这张图。`);
    if (await waitForSession(db, attachMarker, options.timeoutMs ?? 180000, options.sleep)) {
      const session = db
        .prepare('SELECT session_id FROM sessions WHERE prompt LIKE ? ORDER BY started_at DESC LIMIT 1')
        .get(`%${attachMarker}%`) as { session_id: string } | undefined;
      const attachments = session
        ? count(db, 'SELECT count(*) c FROM attachments WHERE session_id = ?', session.session_id)
        : 0;
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
        detail: 'timeout',
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

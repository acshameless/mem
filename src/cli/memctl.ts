#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { openDb } from '../store/db.ts';
import { clineDataDir, hookRawDir, memDbPath, memHome } from '../core/paths.ts';
import { ingestHookDir } from '../ingest/hooks.ts';
import { ingestAllSessions } from '../ingest/sessions.ts';
import { correlateSessions } from '../ingest/correlate.ts';
import { mergeHookToolDurations } from '../ingest/tool_durations.ts';
import { backfillTurnSegments } from '../ingest/backfill.ts';
import { generateSessionCards } from '../ingest/cards.ts';
import { configPath, loadDistillConfig } from '../core/config.ts';
import { loadAutoDistillConfig, loadConfig, saveConfig } from '../core/config.ts';
import { distillSessions } from '../distill/run.ts';
import { listUnits, setUnitStatus } from '../core/units.ts';
import { decayStaleUnits, updateUnitUsage } from '../core/units.ts';
import { mergeUnits, setPinned, updateUnit } from '../core/units.ts';
import { activateSkill, draftSkill, recordSkillOutcome } from '../skills/build.ts';
import { exportStore, importStore } from '../core/portable.ts';
import { redactRawStore, scanStore } from '../core/scan.ts';
import { listTaskPrefs, setTaskPref } from '../core/prefs.ts';
import { runTui } from '../tui/review.ts';
import { updateSessionLifecycle } from '../ingest/lifecycle.ts';
import { defaultHooksDir, hooksDoctor } from '../core/hooks_doctor.ts';
import { validateStoredContracts } from '../core/hook_contract.ts';
import { ingestHookAttachments } from '../ingest/attachments.ts';
import { listPaths, rebuildPaths } from '../core/trajectory.ts';
import { runApp } from '../tui/app.ts';
import { buildProfile, profilesDir, writeProfileSnapshot } from '../profile/build.ts';
import { lineDiff } from '../profile/diff.ts';
import { listAdapters } from '../adapters/index.ts';
import { ingestInjectionDir } from '../ingest/injections.ts';
import { forgetSession, forgetUnit } from '../core/forget.ts';
import { loadGenericDir } from '../core/config.ts';
import { ingestGenericDir } from '../ingest/generic.ts';
import { codexSessionsRoot, ingestCodexDir } from '../ingest/codex.ts';
import { loadEmbeddingConfig } from '../core/config.ts';
import { embedPendingTurns, semanticSearch } from '../embed/embed.ts';
import { embedTexts } from '../embed/embed.ts';
import { EMBEDDING_PRESETS } from '../embed/presets.ts';
import { LLM_PRESETS } from '../distill/presets.ts';
import { checkLlm } from '../distill/check.ts';
import { bootstrapEmbedding, type Runner } from '../embed/bootstrap.ts';
import { runAcceptance } from '../acceptance/run.ts';
import { spawn } from 'node:child_process';
import { decide } from '../decide/provider.ts';
import { loadDecisionConfig } from '../core/config.ts';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync as readFile } from 'node:fs';
import { join } from 'node:path';

const [command, ...args] = process.argv.slice(2);

function fmt(n: unknown): string {
  return typeof n === 'number' ? n.toLocaleString('en-US') : String(n ?? '');
}

function open() {
  return openDb(memDbPath());
}

function runImport(): void {
  const db = open();
  updateUnitUsage(db);
  const hooks = ingestHookDir(db, hookRawDir());
  const sessions = ingestAllSessions(db, `${clineDataDir()}/sessions`);
  const segments = backfillTurnSegments(db);
  const cards = generateSessionCards(db);
  const injections = ingestInjectionDir(db, `${memHome()}/raw/injections`);
  const genericDir = loadGenericDir();
  const generic = genericDir ? ingestGenericDir(db, genericDir) : 0;
  const codex = ingestCodexDir(db, codexSessionsRoot());
  const linked = correlateSessions(db);
  const lifecycle = updateSessionLifecycle(db);
  const attachments = ingestHookAttachments(db);
  const paths = rebuildPaths(db);
  const merged = mergeHookToolDurations(db);
  console.log(`db        ${memDbPath()}`);
  console.log(`hooks     ${fmt(hooks.events)} new events from ${fmt(hooks.files)} files`);
  console.log(`sessions  ${fmt(sessions)} sessions imported`);
  console.log(`segments  ${fmt(segments)} turns indexed for CJK search`);
  console.log(`cards     ${fmt(cards)} session cards generated`);
  console.log(`injects   ${fmt(injections.records)} injection records imported`);
  if (genericDir) console.log(`generic   ${fmt(generic)} sessions imported from ${genericDir}`);
  console.log(`codex     ${fmt(codex)} sessions imported from ${codexSessionsRoot()}`);
  console.log(`linked    ${fmt(linked)} sessions correlated to hook tasks`);
  console.log(`lifecycle ${fmt(lifecycle)} sessions classified (completed/cancelled/failed/aborted_unknown)`);
  console.log(`attach    ${fmt(attachments)} hook attachments stored (images/files)`);
  console.log(`paths     ${fmt(paths)} goal groups scored`);
  console.log(`tools     ${fmt(merged)} tool calls enriched with hook durations`);
  db.close();
}

function runStatus(): void {
  const db = open();
  const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  console.log(`db              ${memDbPath()}`);
  const events = db
    .prepare('SELECT event, count(*) c FROM hook_events GROUP BY event ORDER BY c DESC')
    .all() as Array<{ event: string; c: number }>;
  console.log(`hook events     ${fmt(count('SELECT count(*) c FROM hook_events'))}`);
  for (const row of events) console.log(`  ${row.event.padEnd(16)} ${fmt(row.c)}`);
  console.log(`sessions        ${fmt(count('SELECT count(*) c FROM sessions'))}`);
  console.log(`turns           ${fmt(count('SELECT count(*) c FROM turns'))}`);
  console.log(`tool calls      ${fmt(count('SELECT count(*) c FROM tool_calls'))}`);
  console.log(`correlated      ${fmt(count('SELECT count(*) c FROM sessions WHERE hook_task_id IS NOT NULL'))}`);
  const latest = db
    .prepare(
      `SELECT session_id, workspace_root, model, status, started_at
       FROM sessions ORDER BY started_at DESC LIMIT 1`
    )
    .get() as Record<string, unknown> | undefined;
  if (latest) {
    console.log(`latest session  ${latest.session_id}`);
    console.log(`  workspace     ${latest.workspace_root ?? ''}`);
    console.log(`  model         ${latest.model ?? ''} (${latest.status ?? ''})`);
  }
  db.close();
}

function runSessions(): void {
  const db = open();
  const limit = Number(args[0] ?? 10);
  const rows = db
    .prepare(
      `SELECT session_id, workspace_root, provider, model, status, lifecycle, started_at,
              parent_session_id, is_subagent,
              tokens_in, tokens_out, hook_task_id
       FROM sessions ORDER BY started_at DESC LIMIT ?`
    )
    .all(limit) as Array<Record<string, unknown>>;
  for (const row of rows) {
    console.log(
      `${row.is_subagent ? '  ↳ ' : ''}${row.session_id}  ${row.started_at}  ${row.model}  [${row.lifecycle ?? '?'}]  ${row.workspace_root}` +
        `${row.parent_session_id ? `  parent=${row.parent_session_id}` : ''}\n` +
        `  tokens=${fmt(row.tokens_in)}/${fmt(row.tokens_out)}  hook=${row.hook_task_id ?? '-'}`
    );
  }
  db.close();
}

function runSearch(): void {
  const query = args.join(' ').trim();
  if (!query) {
    console.error('usage: memctl search <query>');
    process.exit(2);
  }
  const db = open();
  const match = query
    .split(/\s+/)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(' ');
  const rows = db
    .prepare(
      `SELECT t.session_id, t.turn_index, t.role, t.display_role, t.kind,
              snippet(turns_fts, 0, '[', ']', '...', 12) AS snip
       FROM turns_fts
       JOIN turns t ON t.id = turns_fts.rowid
       WHERE turns_fts MATCH ?
       ORDER BY rank LIMIT 10`
    )
    .all(match) as Array<Record<string, unknown>>;
  for (const row of rows) {
    console.log(
      `${row.session_id} #${row.turn_index} ${row.role}${row.display_role ? `/${row.display_role}` : ''} ${row.kind}\n  ${row.snip}`
    );
  }
  if (rows.length === 0) console.log('no matches');
  db.close();
}

function runTools(): void {
  const db = open();
  const limit = Number(args[0] ?? 10);
  const rows = db
    .prepare(
      `SELECT session_id, tool_name, success, duration_ms, substr(parameters_json, 1, 120) p
       FROM tool_calls ORDER BY id DESC LIMIT ?`
    )
    .all(limit) as Array<Record<string, unknown>>;
  for (const row of rows) {
    console.log(
      `${row.session_id}  ${row.tool_name}  success=${row.success ?? '?'}  ${row.duration_ms ?? ''}ms\n  ${row.p}`
    );
  }
  db.close();
}

async function runDistill(): Promise<void> {
  const limitArg = args.indexOf('--limit');
  const sessionArg = args.indexOf('--session');
  const dryRun = args.includes('--dry-run');
  const config = loadDistillConfig();
  if (!config.apiKey) {
    console.error(`missing distill.apiKey in ${configPath()}`);
    console.error(
      process.platform === 'win32'
        ? 'run: powershell -ExecutionPolicy Bypass -File scripts\\windows\\configure-model.ps1'
        : 'run: bash scripts/configure-model.sh'
    );
    process.exit(1);
  }
  const db = open();
  const summary = await distillSessions(db, config, {
    limit: limitArg >= 0 ? Number(args[limitArg + 1]) : undefined,
    sessionId: sessionArg >= 0 ? args[sessionArg + 1] : undefined,
    dryRun,
  });
  console.log(`model      ${config.model} (${config.provider})`);
  console.log(`sessions   ${fmt(summary.sessions)}`);
  console.log(`units      ${fmt(summary.units)} candidates`);
  console.log(`duplicates ${fmt(summary.skippedDuplicates)} skipped`);
  console.log(`semantic   ${fmt(summary.skippedSemanticDuplicates)} semantic duplicates skipped`);
  console.log(`errors     ${fmt(summary.errors)}`);
  if (summary.usage.length > 0) {
    const input = summary.usage.reduce((sum, row) => sum + Number(row.prompt_tokens ?? 0), 0);
    const output = summary.usage.reduce((sum, row) => sum + Number(row.completion_tokens ?? 0), 0);
    console.log(`tokens     ${fmt(input)} in / ${fmt(output)} out`);
  }
  if (summary.units > 0 && !dryRun) {
    console.log('candidates');
    for (const unit of listUnits(db, { status: 'candidate', limit: 20 })) {
      console.log(`  ${unit.id}  ${unit.type}  conf=${unit.confidence}  ${unit.statement}`);
    }
    console.log('approve    node src/cli/memctl.ts units approve <id>');
    console.log('reject     node src/cli/memctl.ts units reject <id>');
  }
  db.close();
}

function runUnits(): void {
  const sub = args[0] ?? 'list';
  const db = open();
  if (sub === 'list') {
    const statusArg = args.indexOf('--status');
    const limitArg = args.indexOf('--limit');
    const status = statusArg >= 0 ? args[statusArg + 1] : 'candidate';
    const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : 50;
    const units = listUnits(db, { status, limit });
    for (const unit of units) {
      console.log(
        `${unit.id}  [${unit.status}] ${unit.type} scope=${unit.scope} conf=${unit.confidence}` +
          `${unit.supersedes_id ? ` supersedes=${unit.supersedes_id}` : ''}\n  ${unit.statement}`
      );
    }
    console.log(`${units.length} units`);
  } else if (sub === 'approve' || sub === 'reject') {
    const id = Number(args[1]);
    if (!Number.isInteger(id)) {
      console.error(`usage: memctl units ${sub} <id>`);
      process.exit(2);
    }
    const status = sub === 'approve' ? 'active' : 'rejected';
    const ok = setUnitStatus(db, id, status);
    console.log(ok ? `unit ${id} -> ${status}` : `unit ${id} not found`);
    if (ok) {
      const profile = writeProfileSnapshot(db);
      console.log(
        profile.changed
          ? `profile updated -> ${profile.path}`
          : 'profile unchanged'
      );
    }
  } else if (sub === 'edit') {
    const id = Number(args[1]);
    const valueOf = (flag: string) => {
      const index = args.indexOf(flag);
      return index >= 0 ? args[index + 1] : undefined;
    };
    if (!Number.isInteger(id)) {
      console.error('usage: memctl units edit <id> [--statement ...] [--detail ...] [--scope ...] [--type ...]');
      process.exit(2);
    }
    const ok = updateUnit(db, id, {
      statement: valueOf('--statement'),
      detail: valueOf('--detail'),
      scope: valueOf('--scope'),
      type: valueOf('--type'),
    });
    console.log(ok ? `unit ${id} updated` : `unit ${id} not found`);
    if (ok) writeProfileSnapshot(db);
  } else if (sub === 'merge') {
    const keepId = Number(args[1]);
    const mergeId = Number(args[2]);
    const ok = mergeUnits(db, keepId, mergeId);
    console.log(ok ? `unit ${mergeId} merged into ${keepId}` : 'merge failed: unit not found');
    if (ok) writeProfileSnapshot(db);
  } else if (sub === 'pin' || sub === 'unpin') {
    const id = Number(args[1]);
    const ok = setPinned(db, id, sub === 'pin');
    console.log(ok ? `unit ${id} ${sub === 'pin' ? 'pinned' : 'unpinned'}` : `unit ${id} not found`);
    if (ok) writeProfileSnapshot(db);
  } else {
    console.log('memctl units <list|approve|reject|edit|merge|pin|unpin>');
  }
  db.close();
}

function runProfile(): void {
  const sub = args[0] ?? 'show';
  const dir = profilesDir();
  if (sub === 'list') {
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith('.md')).sort();
    } catch {
      names = [];
    }
    for (const name of names) console.log(name);
    console.log(`${names.length} profiles`);
    return;
  }
  if (sub === 'show') {
    const version = args[1];
    const path = version ? join(dir, `TASTE-v${version}.md`) : join(dir, 'TASTE.md');
    console.log(readFile(path, 'utf8'));
    return;
  }
  if (sub === 'diff') {
    const [beforeVersion, afterVersion] = [args[1], args[2]];
    if (!beforeVersion || !afterVersion) {
      console.error('usage: memctl profile diff <versionA> <versionB>');
      process.exit(2);
    }
    const before = readFile(join(dir, `TASTE-v${beforeVersion}.md`), 'utf8');
    const after = readFile(join(dir, `TASTE-v${afterVersion}.md`), 'utf8');
    for (const line of lineDiff(before, after)) {
      if (line.type === 'same') continue;
      console.log(`${line.type === 'add' ? '+' : '-'} ${line.line}`);
    }
    return;
  }
  const db = open();
  if (sub === 'write') {
    const result = writeProfileSnapshot(db);
    console.log(
      result.changed ? `profile v${result.version} -> ${result.path}` : 'profile unchanged'
    );
  } else {
    console.log(buildProfile(db).markdown);
  }
  db.close();
}

function runMetrics(): void {
  const db = open();
  const injection = db
    .prepare(
      `SELECT count(*) c, coalesce(avg(chars),0) avg_chars,
              coalesce(avg(cards),0) avg_cards, coalesce(avg(turns),0) avg_turns
       FROM injections`
    )
    .get() as { c: number; avg_chars: number; avg_cards: number; avg_turns: number };
  const injectedSessions = db
    .prepare(`SELECT count(DISTINCT session_id) c FROM injections WHERE session_id IS NOT NULL`)
    .get() as { c: number };
  const statuses = db
    .prepare(`SELECT status, count(*) c FROM memory_units GROUP BY status`)
    .all() as Array<{ status: string; c: number }>;
  const statusMap = new Map(statuses.map((row) => [row.status, row.c]));
  const lifecycleRows = db
    .prepare(`SELECT coalesce(lifecycle, 'unknown') lifecycle, count(*) c FROM sessions GROUP BY lifecycle`)
    .all() as Array<{ lifecycle: string; c: number }>;
  console.log('session lifecycle');
  for (const row of lifecycleRows) console.log(`  ${row.lifecycle.padEnd(15)} ${fmt(row.c)}`);
  console.log(`injections        ${fmt(injection.c)}`);
  console.log(`injected sessions ${fmt(injectedSessions.c)}`);
  console.log(`avg block chars   ${injection.avg_chars.toFixed(0)}`);
  console.log(`avg cards/turns   ${injection.avg_cards.toFixed(1)} / ${injection.avg_turns.toFixed(1)}`);
  console.log(
    `units             active=${fmt(statusMap.get('active') ?? 0)} candidate=${fmt(
      statusMap.get('candidate') ?? 0
    )} rejected=${fmt(statusMap.get('rejected') ?? 0)} superseded=${fmt(
      statusMap.get('superseded') ?? 0
    )}`
  );

  const usage = new Map<number, number>();
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
  const top = [...usage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (top.length > 0) {
    console.log('top used units');
    for (const [id, count] of top) {
      const unit = db
        .prepare('SELECT statement, status FROM memory_units WHERE id = ?')
        .get(id) as { statement: string; status: string } | undefined;
      console.log(`  ${id} ×${count} [${unit?.status ?? 'gone'}] ${(unit?.statement ?? '').slice(0, 60)}`);
    }
  }
  const days = db
    .prepare(
      `SELECT substr(ts, 1, 10) day, count(*) c FROM injections
       WHERE ts IS NOT NULL GROUP BY day ORDER BY day DESC LIMIT 7`
    )
    .all() as Array<{ day: string; c: number }>;
  for (const row of days) console.log(`  ${row.day}  ${fmt(row.c)} injections`);
  db.close();
}

function runReview(): void {
  const notify = args.includes('--notify');
  const db = open();
  const statuses = db
    .prepare(`SELECT status, count(*) c FROM memory_units GROUP BY status`)
    .all() as Array<{ status: string; c: number }>;
  const statusMap = new Map(statuses.map((row) => [row.status, row.c]));
  const candidateCount = statusMap.get('candidate') ?? 0;
  console.log(
    `candidates ${fmt(candidateCount)}  active ${fmt(statusMap.get('active') ?? 0)}  rejected ${fmt(
      statusMap.get('rejected') ?? 0
    )}`
  );
  for (const unit of listUnits(db, { status: 'candidate', limit: 10 })) {
    console.log(`  ${unit.id}  ${unit.type} conf=${unit.confidence}  ${unit.statement.slice(0, 80)}`);
  }
  if (notify && candidateCount > 0) {
    if (process.platform === 'darwin') {
      try {
        execFileSync('osascript', [
          '-e',
          `display notification "${candidateCount} 个记忆候选待审核" with title "mem review"`,
        ]);
      } catch {
        // Notification failure must not fail the command.
      }
    } else if (process.platform === 'win32') {
      try {
        const script =
          'Add-Type -AssemblyName System.Windows.Forms;' +
          'Add-Type -AssemblyName System.Drawing;' +
          '$n=New-Object System.Windows.Forms.NotifyIcon;' +
          '$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;' +
          `$n.ShowBalloonTip(5000,'mem review','${candidateCount} 个候选待审核','Info');` +
          'Start-Sleep -Seconds 6;$n.Dispose()';
        execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
          stdio: 'ignore',
        });
      } catch {
        // Notification failure must not fail the command.
      }
    }
  }
  db.close();
}

function runSources(): void {
  for (const adapter of listAdapters()) {
    console.log(`${adapter.id}  ${adapter.name}`);
    console.log(`  sessions: ${adapter.sessionsRoot}`);
  }
}

function runCard(): void {
  const sessionId = args[0];
  if (!sessionId) {
    console.error('usage: memctl card <sessionId>');
    process.exit(2);
  }
  const db = open();
  const card = db
    .prepare('SELECT * FROM session_cards WHERE session_id = ?')
    .get(sessionId) as Record<string, any> | undefined;
  if (!card) {
    console.log('no card for this session');
  } else {
    console.log(`session   ${card.session_id}`);
    console.log(`goal      ${card.goal ?? ''}`);
    console.log(`outcome   ${card.outcome ?? ''}`);
    console.log(`tools     ${card.tools_json ?? ''}`);
    console.log(`summary   ${card.summary ?? '(heuristic only)'}`);
    console.log(`decisions ${card.decisions_json ?? '[]'}`);
    console.log(`open      ${card.open_questions_json ?? '[]'}`);
    console.log(`lessons   ${card.lessons_json ?? '[]'}`);
    console.log(`source    ${card.generated_by ?? 'heuristic'}`);
  }
  db.close();
}

function runScan(): void {
  const home = memHome();
  const db = open();
  const result = scanStore(db, home);
  console.log(`raw files scanned   ${fmt(result.filesScanned)}`);
  console.log(`files with secrets  ${fmt(result.filesWithSecrets.length)}`);
  console.log(`raw lines affected  ${fmt(result.rawMatches)}`);
  console.log(`turns with secrets  ${fmt(result.turnMatches)} (derived; redacted at injection/distill time)`);
  for (const file of result.filesWithSecrets.slice(0, 10)) console.log(`  ${file}`);
  if (args.includes('--redact-raw')) {
    if (!args.includes('--yes')) {
      console.log('add --yes to rewrite raw hook/injection files with [REDACTED]');
    } else {
      const redacted = redactRawStore(home);
      console.log(`redacted ${fmt(redacted.lines)} lines in ${fmt(redacted.files)} files`);
    }
  }
  db.close();
}

function runHooks(): void {
  const dir = args[0] && !args[0].startsWith('-') ? args[0] : defaultHooksDir();
  const db = open();
  if (args.includes('--validate')) {
    const report = validateStoredContracts(db);
    console.log(`checked ${report.checked} hook event(s)`);
    for (const row of report.violations.slice(0, 20)) {
      console.log(`VIOLATION ${row.event} task=${row.task_id ?? '-'}: ${row.errors.join('; ')}`);
    }
    console.log(`${report.violations.length} violation(s)`);
    db.close();
    if (report.violations.length > 0) process.exitCode = 1;
    return;
  }
  const rows = hooksDoctor(db, dir);
  console.log(`hooks dir  ${dir}`);
  console.log('event             installed  last seen             count  health');
  let errors = 0;
  let warnings = 0;
  for (const row of rows) {
    if (row.health === 'missing' || row.health === 'not_executable') errors += 1;
    if (row.health === 'warn_never_fired') warnings += 1;
    console.log(
      `${row.event.padEnd(17)} ${row.installed ? (row.executable ? 'yes      ' : 'no-exec  ') : 'no       '} ` +
        `${(row.lastSeen ?? '-').slice(0, 22).padEnd(22)} ${String(row.count).padStart(5)}  ${row.health}`
    );
  }
  console.log(
    errors === 0
      ? `hooks ok (${warnings} event(s) not seen yet; this is normal)`
      : `${errors} hook(s) are missing or not executable`
  );
  db.close();
  if (errors > 0) process.exitCode = 1;
}

function runPaths(): void {
  const db = open();
  const limitArg = args.find((value) => /^\d+$/.test(value));
  if (args.includes('--rebuild') || listPaths(db, 1).length === 0) {
    rebuildPaths(db);
  }
  const rows = listPaths(db, limitArg ? Number(limitArg) : 50);
  console.log('score  best session           members  steps  goal');
  for (const row of rows) {
    console.log(
      `${row.score.toFixed(2)}   ${String(row.best_session_id ?? '-').padEnd(21)} ${String(
        row.session_ids.length
      ).padStart(4)}  ${String(row.best_steps ?? 0).padStart(5)}  ${String(row.goal)
        .replace(/\s+/g, ' ')
        .slice(0, 60)}`
    );
  }
  console.log(`${rows.length} path group(s)`);
  db.close();
}

function runTaskPrefs(): void {
  // `args` excludes the command. Use `command` for the subcommand.
  const sub = command === 'tasks' || !command ? 'list' : command;
  const db = open();
  if (sub === 'on' || sub === 'off' || sub === 'capture-on' || sub === 'capture-off') {
    const taskId = args[0];
    if (!taskId) {
      console.error(`usage: memctl ${sub} <taskId>`);
      process.exit(2);
    }
    if (sub === 'on' || sub === 'off') {
      setTaskPref(db, taskId, { memory: sub === 'on' });
      console.log(`task ${taskId} memory ${sub === 'on' ? 'enabled' : 'disabled'}`);
    } else {
      setTaskPref(db, taskId, { capture: sub === 'capture-on' });
      console.log(`task ${taskId} capture ${sub === 'capture-on' ? 'enabled' : 'disabled'}`);
    }
  } else if (sub === 'list') {
    for (const pref of listTaskPrefs(db)) {
      console.log(
        `${pref.task_id}  memory=${pref.memory_enabled ? 'on' : 'off'}  capture=${pref.capture_enabled ? 'on' : 'off'}  ${pref.updated_at ?? ''}`
      );
    }
  } else {
    console.log('memctl <on|off|capture-on|capture-off> <taskId> | memctl tasks');
  }
  db.close();
}

function runForget(): void {
  const sub = args[0];
  const db = open();
  if (sub === 'list') {
    const rows = db
      .prepare('SELECT kind, value, created_at, note FROM forget_list ORDER BY created_at DESC LIMIT 50')
      .all() as Array<{ kind: string; value: string; created_at: string; note: string | null }>;
    for (const row of rows) console.log(`${row.kind}  ${row.value}  ${row.created_at}`);
    console.log(`${rows.length} entries`);
    db.close();
    return;
  }
  const yes = args.includes('--yes');
  if (sub === 'session') {
    const id = args[1];
    if (!id) {
      console.error('usage: memctl forget session <sessionId> [--include-active] --yes');
      process.exit(2);
    }
    const includeActive = args.includes('--include-active');
    if (!yes) {
      const count = (table: string) =>
        (db.prepare(`SELECT count(*) c FROM ${table} WHERE session_id = ?`).get(id) as { c: number }).c;
      console.log(`session ${id}`);
      console.log(`  turns          ${count('turns')}`);
      console.log(`  tool_calls     ${count('tool_calls')}`);
      console.log(`  cards          ${count('session_cards')}`);
      console.log(`  distill_state  ${count('distill_state')}`);
      console.log(`  injections     ${count('injections')}`);
      const unitSql = includeActive
        ? 'SELECT count(*) c FROM memory_units WHERE source_session = ?'
        : `SELECT count(*) c FROM memory_units WHERE source_session = ? AND status != 'active'`;
      console.log(`  units          ${(db.prepare(unitSql).get(id) as { c: number }).c}${includeActive ? '' : ' (active units kept)'}`);
      console.log('add --yes to execute. Raw hook lines for this task will be removed.');
      db.close();
      return;
    }
    const result = forgetSession(db, id, { includeActive });
    console.log(`forgotten session ${id}`);
    for (const [table, count] of Object.entries(result.counts)) {
      console.log(`  ${table.padEnd(14)} ${count}`);
    }
    console.log(`  raw hook lines ${result.hookLinesRemoved}`);
    console.log(`  injections raw ${result.injectionLinesRemoved}`);
    console.log(`  denylisted     session${result.hookTaskId ? ' + task' : ''}`);
    writeProfileSnapshot(db);
    db.close();
    return;
  }
  if (sub === 'unit') {
    const id = Number(args[1]);
    if (!Number.isInteger(id)) {
      console.error('usage: memctl forget unit <id> --yes');
      process.exit(2);
    }
    if (!yes) {
      const unit = db
        .prepare('SELECT statement, status FROM memory_units WHERE id = ?')
        .get(id) as { statement: string; status: string } | undefined;
      console.log(unit ? `unit ${id} [${unit.status}] ${unit.statement}` : `unit ${id} not found`);
      console.log('add --yes to execute.');
      db.close();
      return;
    }
    const statement = forgetUnit(db, id);
    console.log(statement ? `forgotten unit ${id}: ${statement}` : `unit ${id} not found`);
    if (statement) writeProfileSnapshot(db);
    db.close();
    return;
  }
  console.log('memctl forget <list|session|unit>');
  db.close();
}

function runArchive(): void {
  const index = join(memHome(), 'archive', 'index.jsonl');
  if (!existsSync(index)) {
    console.log('no archives');
    return;
  }
  const lines = readFile(index, 'utf8').split('\n').filter(Boolean).slice(-20);
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as Record<string, any>;
      console.log(
        `${record.ts}  session=${record.session_id}  files=${record.files?.length ?? 0}  size=${record.context_size ?? '-'}  tokens=${record.tokens_in ?? '-'}/${record.tokens_out ?? '-'}`
      );
    } catch {
      // Skip malformed lines.
    }
  }
  console.log(`${lines.length} recent archives`);
}

function runReport(): void {
  const db = open();
  const statuses = db
    .prepare(`SELECT status, count(*) c FROM memory_units GROUP BY status`)
    .all() as Array<{ status: string; c: number }>;
  const statusMap = new Map(statuses.map((row) => [row.status, row.c]));
  const active = statusMap.get('active') ?? 0;
  const rejected = statusMap.get('rejected') ?? 0;
  const candidates = statusMap.get('candidate') ?? 0;
  const adoption = active + rejected > 0 ? ((active / (active + rejected)) * 100).toFixed(1) : 'n/a';
  const injection = db
    .prepare(
      `SELECT count(*) c, coalesce(avg(unit_ids_json != '[]'), 0) unit_rate, coalesce(avg(chars), 0) chars
       FROM injections`
    )
    .get() as { c: number; unit_rate: number; chars: number };
  const days = db
    .prepare(
      `SELECT substr(ts, 1, 10) day, count(*) c FROM injections
       WHERE ts IS NOT NULL GROUP BY day ORDER BY day DESC LIMIT 7`
    )
    .all() as Array<{ day: string; c: number }>;
  console.log('# mem weekly report');
  console.log(`units      active=${fmt(active)} candidate=${fmt(candidates)} rejected=${fmt(rejected)}`);
  console.log(`adoption   ${adoption}%`);
  console.log(`injections ${fmt(injection.c)}  unit-carrying rate ${(injection.unit_rate * 100).toFixed(0)}%  avg ${injection.chars.toFixed(0)} chars`);
  const stale = db
    .prepare(
      `SELECT id, statement FROM memory_units
       WHERE status = 'active' AND (use_count IS NULL OR use_count = 0) LIMIT 10`
    )
    .all() as Array<{ id: number; statement: string }>;
  if (stale.length > 0) {
    console.log('stale candidates (no injection usage)');
    for (const row of stale) console.log(`  ${row.id}  ${row.statement.slice(0, 60)}`);
  }
  for (const row of days) console.log(`  ${row.day}  ${fmt(row.c)} injections`);
  db.close();
}

function runDecay(): void {
  const daysArg = args.indexOf('--days');
  const days = daysArg >= 0 ? Number(args[daysArg + 1]) : 14;
  const db = open();
  const decayed = decayStaleUnits(db, days);
  const profile = writeProfileSnapshot(db);
  db.close();
  console.log(`decayed ${fmt(decayed)} units older than ${days} days with no usage`);
  console.log(profile.changed ? `profile updated -> ${profile.path}` : 'profile unchanged');
}

function runPortable(): void {
  // `args` excludes the command. The command is `export` or `import`.
  const sub = command;
  const db = open();
  if (sub === 'export') {
    const outArg = args.indexOf('--out');
    const outDir = outArg >= 0 ? args[outArg + 1] : join(memHome(), 'exports', `mem-${Date.now()}`);
    const result = exportStore(db, outDir, { includeRaw: args.includes('--raw') });
    console.log(`exported  units=${result.units} cards=${result.cards} skills=${result.skills} profiles=${result.profiles}`);
    console.log(`dir       ${result.dir}`);
    console.log(`hash      ${result.hash}`);
    console.log('note      config.json and API keys are never exported');
  } else if (sub === 'import') {
    const dir = args[0];
    if (!dir) {
      console.error('usage: memctl import <exportDir>');
      process.exit(2);
    }
    const result = importStore(db, dir);
    console.log(`imported  units=${result.units} skipped=${result.skipped} cards=${result.cards} skills=${result.skills} profiles=${result.profiles}`);
  } else {
    console.log('memctl export --out <dir> [--raw] | memctl import <dir>');
  }
  db.close();
}

async function runSkills(): Promise<void> {
  const sub = args[0] ?? 'list';
  const db = open();
  if (sub === 'list') {
    const rows = db
      .prepare(
        `SELECT id, name, status, use_count, success_count, fail_count, path FROM skills ORDER BY id DESC LIMIT 50`
      )
      .all() as Array<Record<string, any>>;
    for (const row of rows) {
      console.log(
        `${row.id}  [${row.status}] ${row.name}  use=${row.use_count ?? 0} ok=${row.success_count ?? 0} fail=${row.fail_count ?? 0}${row.path ? `  ${row.path}` : ''}`
      );
    }
    console.log(`${rows.length} skills`);
  } else if (sub === 'draft') {
    const config = loadDistillConfig();
    const id = await draftSkill(db, config);
    console.log(id ? `draft skill ${id} created; review with: memctl skills list` : 'no procedure evidence to crystallize yet');
  } else if (sub === 'approve') {
    const id = Number(args[1]);
    const result = activateSkill(db, id);
    console.log(result ? `skill ${id} active -> ${result.path}` : `skill ${id} not found`);
  } else if (sub === 'reject' || sub === 'retire') {
    const id = Number(args[1]);
    const status = sub === 'reject' ? 'rejected' : 'retired';
    const result = db.prepare('UPDATE skills SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id);
    console.log(Number(result.changes ?? 0) > 0 ? `skill ${id} -> ${status}` : `skill ${id} not found`);
  } else if (sub === 'outcome') {
    const id = Number(args[1]);
    const success = args.includes('--success');
    console.log(recordSkillOutcome(db, id, success) ? `skill ${id} outcome recorded (${success ? 'success' : 'fail'})` : `skill ${id} not found`);
  } else {
    console.log('memctl skills <list|draft|approve <id>|reject <id>|retire <id>|outcome <id> --success|--fail>');
  }
  db.close();
}

async function runEmbed(): Promise<void> {
  const limitArg = args.indexOf('--limit');
  const config = loadEmbeddingConfig();
  if (!config.enabled || !config.baseUrl || !config.model) {
    console.error('embedding is not configured');
    console.error(
      'add to ~/.llm-memory/config.json: {"embedding":{"enabled":true,"baseUrl":"https://...","model":"...","apiKey":"..."}}'
    );
    process.exit(1);
  }
  const db = open();
  if (args.includes('--check')) {
    const started = performance.now();
    try {
      const [vector] = await embedTexts(config, ['mem embedding check'], undefined, 'query');
      const ms = Math.round(performance.now() - started);
      console.log(`provider  ${config.provider}  model ${config.model}`);
      console.log(`endpoint  ${config.baseUrl}`);
      console.log(`ok        dims=${vector?.length ?? 0}  ${ms}ms`);
    } catch (error) {
      console.error(`FAILED    ${String(error).slice(0, 200)}`);
      process.exitCode = 1;
    }
    db.close();
    return;
  }
  const result = await embedPendingTurns(db, config, {
    limit: limitArg >= 0 ? Number(args[limitArg + 1]) : undefined,
  });
  db.close();
  console.log(`candidates ${fmt(result.candidates)}`);
  console.log(`embedded   ${fmt(result.embedded)}`);
}

function runEmbeddingPreset(): void {
  const name = args[1];
  const preset = name ? EMBEDDING_PRESETS[name] : undefined;
  if (!preset) {
    console.log(`memctl embedding preset <${Object.keys(EMBEDDING_PRESETS).join('|')}>`);
    return;
  }
  const config = loadConfig();
  const existing = loadEmbeddingConfig();
  config.embedding = {
    ...preset,
    // Keep an already configured secret unless the preset supplies a new one.
    apiKey: existing.apiKey && !preset.apiKey ? existing.apiKey : preset.apiKey,
  };
  saveConfig(config);
  console.log(`embedding preset: ${name}`);
  console.log(`  provider ${config.embedding.provider}`);
  console.log(`  baseUrl  ${config.embedding.baseUrl}`);
  console.log(`  model    ${config.embedding.model}`);
  console.log(`  dims     ${config.embedding.dimensions ?? 'model default'}`);
  console.log('check: memctl embed --check');
}

async function runLlm(): Promise<void> {
  const sub = args[0] ?? 'preset';
  if (sub === 'check') {
    const config = loadDistillConfig();
    const result = await checkLlm(config);
    console.log(`model   ${result.model}`);
    console.log(`latency ${result.latencyMs}ms`);
    console.log(`json    ${result.ok ? 'ok' : `FAILED: ${result.error}`}`);
    if (result.sample) console.log(`sample  ${result.sample.replace(/\s+/g, ' ')}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (sub === 'model') {
    const name = args[1];
    if (!name) {
      console.error('usage: memctl llm model <name>');
      process.exit(2);
    }
    const config = loadConfig();
    config.distill = { ...loadDistillConfig(), model: name };
    saveConfig(config);
    console.log(`llm model set to ${name}`);
    console.log('check: memctl llm check');
    return;
  }
  const name = args[1];
  const preset = name ? LLM_PRESETS[name] : undefined;
  if (!preset) {
    console.log(
      `memctl llm preset <${Object.keys(LLM_PRESETS).join('|')}> | llm model <name> | llm check`
    );
    return;
  }
  const config = loadConfig();
  const existing = loadDistillConfig();
  config.distill = {
    ...preset,
    apiKey: existing.apiKey && !preset.apiKey ? existing.apiKey : preset.apiKey,
  };
  saveConfig(config);
  console.log(`llm preset: ${name}`);
  console.log(`  provider ${config.distill.provider}`);
  console.log(`  baseUrl  ${config.distill.baseUrl}`);
  console.log(`  model    ${config.distill.model}`);
  console.log('check: memctl llm check');
}

async function runSemantic(): Promise<void> {
  const query = args.join(' ').trim();
  if (!query) {
    console.error('usage: memctl semantic <query>');
    process.exit(2);
  }
  const config = loadEmbeddingConfig();
  if (!config.enabled || !config.baseUrl || !config.model) {
    console.error('embedding is not configured');
    process.exit(1);
  }
  const db = open();
  const hits = await semanticSearch(db, config, query, { limit: 10 });
  for (const hit of hits) {
    console.log(
      `${hit.score.toFixed(3)}  ${hit.session_id}  ${hit.role}  ${(hit.started_at ?? '').slice(0, 19)}\n  ${hit.text.replace(/\s+/g, ' ').slice(0, 120)}`
    );
  }
  if (hits.length === 0) console.log('no matches');
  db.close();
}

function runAuto(): void {
  const sub = args[0] ?? 'status';
  const quietArg = args.indexOf('--quiet');
  const scanArg = args.indexOf('--scan');
  const maxArg = args.indexOf('--max');
  const current = loadAutoDistillConfig();

  if (sub === 'status') {
    console.log(`enabled          ${current.enabled}`);
    console.log(`quietMinutes     ${current.quietMinutes}`);
    console.log(`scanMinutes      ${current.scanMinutes}`);
    console.log(`maxPerCycle      ${current.maxSessionsPerCycle}`);
    console.log(`reDistillOnChange ${current.reDistillOnChange}`);
    return;
  }
  if (sub !== 'on' && sub !== 'off') {
    console.log('memctl auto <on|off|status> [--quiet N] [--scan N] [--max N]');
    return;
  }
  const config = loadConfig();
  config.autoDistill = {
    ...current,
    enabled: sub === 'on',
    ...(quietArg >= 0 ? { quietMinutes: Number(args[quietArg + 1]) } : {}),
    ...(scanArg >= 0 ? { scanMinutes: Number(args[scanArg + 1]) } : {}),
    ...(maxArg >= 0 ? { maxSessionsPerCycle: Number(args[maxArg + 1]) } : {}),
  };
  saveConfig(config);
  console.log(`autoDistill ${sub === 'on' ? 'enabled' : 'disabled'}`);
  console.log(`quiet ${config.autoDistill.quietMinutes}m  scan ${config.autoDistill.scanMinutes}m  max ${config.autoDistill.maxSessionsPerCycle}/cycle`);
}

switch (command) {
  case 'import':
    runImport();
    break;
  case 'status':
    runStatus();
    break;
  case 'sessions':
    runSessions();
    break;
  case 'search':
    runSearch();
    break;
  case 'tools':
    runTools();
    break;
  case 'watch': {
    const { startDaemon } = await import('../daemon/memd.ts');
    startDaemon();
    break;
  }
  case 'distill':
    await runDistill();
    break;
  case 'units':
    runUnits();
    break;
  case 'auto':
    runAuto();
    break;
  case 'profile':
    runProfile();
    break;
  case 'metrics':
    runMetrics();
    break;
  case 'review':
    runReview();
    break;
  case 'sources':
    runSources();
    break;
  case 'card':
    runCard();
    break;
  case 'scan':
    runScan();
    break;
  case 'hooks':
    runHooks();
    break;
  case 'paths':
    runPaths();
    break;
  case 'on':
  case 'off':
  case 'capture-on':
  case 'capture-off':
  case 'tasks':
    runTaskPrefs();
    break;
  case 'tui': {
    const db = open();
    if (args.includes('--review')) runTui(db);
    else runApp(db);
    process.on('exit', () => {
      try {
        db.close();
      } catch {
        // Already closed.
      }
    });
    break;
  }
  case 'ui': {
    const portArg = args.indexOf('--port');
    const port = portArg >= 0 ? Number(args[portArg + 1]) : 8787;
    const { startUi } = await import('../ui/server.ts');
    const db = open();
    const ui = await startUi(db, { port });
    console.log(`mem UI  http://127.0.0.1:${ui.port}`);
    console.log('press Ctrl+C to stop');
    const shutdown = () => {
      ui.close();
      try {
        db.close();
      } catch {
        // Already closed.
      }
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    break;
  }
  case 'acceptance': {
    const db = open();
    const timeoutArg = args.indexOf('--timeout');
    const code = await runAcceptance(db, {
      check: args.includes('--check'),
      full: args.includes('--full'),
      timeoutMs: timeoutArg >= 0 ? Number(args[timeoutArg + 1]) * 1000 : undefined,
    });
    db.close();
    if (code !== 0) process.exitCode = code;
    break;
  }
  case 'decide': {
    const question = args.join(' ');
    const labelsIndex = args.indexOf('--labels');
    if (!question || labelsIndex < 0) {
      console.log('memctl decide <question> --labels a,b,...');
      break;
    }
    const questionText = args.slice(0, labelsIndex).join(' ');
    const labels = String(args[labelsIndex + 1] ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const result = await decide(loadDecisionConfig(), { question: questionText, labels });
    console.log(`${result.label}  probability=${result.probability.toFixed(3)}`);
    break;
  }
  case 'embedding-install': {
    const config = loadEmbeddingConfig();
    const effective = {
      ...config,
      enabled: true,
      provider: 'local' as const,
      baseUrl: config.baseUrl || 'http://127.0.0.1:11434/v1',
      model: config.model || 'embeddinggemma-2',
    };
    if (config.provider !== 'local' || !config.enabled) {
      const stored = loadConfig();
      stored.embedding = { ...EMBEDDING_PRESETS.local, ...stored.embedding, ...effective };
      saveConfig(stored);
      console.log('embedding set to local EmbeddingGemma 2');
    }
    const cliRunner: Runner = (command, commandArgs, runnerOptions) =>
      new Promise((resolve, reject) => {
        const child = spawn(command, commandArgs, {
          stdio: runnerOptions?.detach ? 'ignore' : 'pipe',
          detached: runnerOptions?.detach === true,
        });
        if (runnerOptions?.detach) {
          child.unref();
          resolve({ code: 0, stdout: '' });
          return;
        }
        let stdout = '';
        child.stdout?.on('data', (chunk) => {
          stdout += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolve({ code: 0, stdout }) : reject(new Error(`${command} exit ${code}`))
        );
      });
    const result = await bootstrapEmbedding(effective, { runner: cliRunner });
    for (const step of result.steps) console.log(`  ${step}`);
    if (!result.ok) {
      console.error(`embedding bootstrap failed: ${result.guidance ?? 'unknown'}`);
      process.exitCode = 1;
      break;
    }
    const { embedTexts } = await import('../embed/embed.ts');
    const [vector] = await embedTexts(effective, ['mem embedding probe'], undefined, 'query');
    console.log(`probe ok: dimensions=${vector?.length ?? 0}`);
    break;
  }
  case 'forget':
    runForget();
    break;
  case 'archive':
    runArchive();
    break;
  case 'report':
    runReport();
    break;
  case 'embed':
    await runEmbed();
    break;
  case 'embedding':
    runEmbeddingPreset();
    break;
  case 'llm':
    await runLlm();
    break;
  case 'semantic':
    await runSemantic();
    break;
  case 'decay':
    runDecay();
    break;
  case 'skills':
    await runSkills();
    break;
  case 'export':
  case 'import':
    runPortable();
    break;
  default:
    console.log('memctl <import|status|sessions|search|tools>');
    console.log(`  db: ${memDbPath()}`);
    console.log(`  cline data: ${clineDataDir()}`);
    console.log(`  hook raw: ${hookRawDir()}`);
    if (!existsSync(clineDataDir())) console.log('  note: cline data dir not found');
    if (command) process.exit(2);
}

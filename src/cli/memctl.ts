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
import { buildProfile, profilesDir, writeProfileSnapshot } from '../profile/build.ts';
import { lineDiff } from '../profile/diff.ts';
import { listAdapters } from '../adapters/index.ts';
import { ingestInjectionDir } from '../ingest/injections.ts';
import { forgetSession, forgetUnit } from '../core/forget.ts';
import { loadGenericDir } from '../core/config.ts';
import { ingestGenericDir } from '../ingest/generic.ts';
import { loadEmbeddingConfig } from '../core/config.ts';
import { embedPendingTurns, semanticSearch } from '../embed/embed.ts';
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
  const hooks = ingestHookDir(db, hookRawDir());
  const sessions = ingestAllSessions(db, `${clineDataDir()}/sessions`);
  const segments = backfillTurnSegments(db);
  const cards = generateSessionCards(db);
  const injections = ingestInjectionDir(db, `${memHome()}/raw/injections`);
  const genericDir = loadGenericDir();
  const generic = genericDir ? ingestGenericDir(db, genericDir) : 0;
  const linked = correlateSessions(db);
  const merged = mergeHookToolDurations(db);
  console.log(`db        ${memDbPath()}`);
  console.log(`hooks     ${fmt(hooks.events)} new events from ${fmt(hooks.files)} files`);
  console.log(`sessions  ${fmt(sessions)} sessions imported`);
  console.log(`segments  ${fmt(segments)} turns indexed for CJK search`);
  console.log(`cards     ${fmt(cards)} session cards generated`);
  console.log(`injects   ${fmt(injections.records)} injection records imported`);
  if (genericDir) console.log(`generic   ${fmt(generic)} sessions imported from ${genericDir}`);
  console.log(`linked    ${fmt(linked)} sessions correlated to hook tasks`);
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
      `SELECT session_id, workspace_root, provider, model, status, started_at,
              tokens_in, tokens_out, hook_task_id
       FROM sessions ORDER BY started_at DESC LIMIT ?`
    )
    .all(limit) as Array<Record<string, unknown>>;
  for (const row of rows) {
    console.log(
      `${row.session_id}  ${row.started_at}  ${row.model}  ${row.workspace_root}\n` +
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
  } else {
    console.log('memctl units <list|approve|reject>');
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
  for (const row of days) console.log(`  ${row.day}  ${fmt(row.c)} injections`);
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
  const result = await embedPendingTurns(db, config, {
    limit: limitArg >= 0 ? Number(args[limitArg + 1]) : undefined,
  });
  db.close();
  console.log(`candidates ${fmt(result.candidates)}`);
  console.log(`embedded   ${fmt(result.embedded)}`);
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
  case 'semantic':
    await runSemantic();
    break;
  default:
    console.log('memctl <import|status|sessions|search|tools>');
    console.log(`  db: ${memDbPath()}`);
    console.log(`  cline data: ${clineDataDir()}`);
    console.log(`  hook raw: ${hookRawDir()}`);
    if (!existsSync(clineDataDir())) console.log('  note: cline data dir not found');
    if (command) process.exit(2);
}

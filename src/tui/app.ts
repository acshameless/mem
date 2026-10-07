import type { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadAutoDistillConfig, loadConfig, loadDistillConfig, saveConfig } from '../core/config.ts';
import { memDbPath, memHome } from '../core/paths.ts';
import { listTaskPrefs, setTaskPref } from '../core/prefs.ts';
import { searchTurns } from '../core/recall.ts';
import { forgetSession, forgetUnit } from '../core/forget.ts';
import { scanStore } from '../core/scan.ts';
import { updateUnit, setPinned, setUnitStatus } from '../core/units.ts';
import { distillSessions } from '../distill/run.ts';
import { exportStore, importStore } from '../core/portable.ts';
import { writeProfileSnapshot } from '../profile/build.ts';
import { activateSkill, draftSkill, recordSkillOutcome } from '../skills/build.ts';
import { clampIndex, loadItems, type TuiItem } from './review.ts';

export interface TuiRow {
  id: string | number;
  title: string;
  subtitle: string;
  detail?: string[];
}

export interface AppController {
  setStatus: (message: string) => void;
  reload: () => void;
  input: (label: string, onSubmit: (value: string) => void | Promise<void>) => void;
  quit: () => void;
}

export interface Screen {
  id: string;
  title: string;
  load: (db: DatabaseSync) => TuiRow[];
  actions?: Array<{
    key: string;
    help: string;
    run: (row: TuiRow | undefined, ctx: AppController) => void | Promise<void>;
  }>;
}

function count(db: DatabaseSync, sql: string): number {
  try {
    return (db.prepare(sql).get() as { c: number }).c;
  } catch {
    return 0;
  }
}

export function loadDashboard(db: DatabaseSync): TuiRow[] {
  const auto = loadAutoDistillConfig();
  const rows: TuiRow[] = [
    {
      id: 'sessions',
      title: `Sessions ${count(db, 'SELECT count(*) c FROM sessions')}`,
      subtitle: `turns ${count(db, 'SELECT count(*) c FROM turns')}  cards ${count(db, 'SELECT count(*) c FROM session_cards')}`,
    },
    {
      id: 'memory',
      title: `Memory units`,
      subtitle: `active ${count(db, "SELECT count(*) c FROM memory_units WHERE status='active'")}  candidate ${count(db, "SELECT count(*) c FROM memory_units WHERE status='candidate'")}  rejected ${count(db, "SELECT count(*) c FROM memory_units WHERE status='rejected'")}`,
    },
    {
      id: 'injections',
      title: `Injections ${count(db, 'SELECT count(*) c FROM injections')}`,
      subtitle: `skills ${count(db, 'SELECT count(*) c FROM skills')}  cards ${count(db, 'SELECT count(*) c FROM session_cards')}`,
    },
    {
      id: 'auto',
      title: `Auto-distill ${auto.enabled ? 'ON' : 'OFF'}`,
      subtitle: `quiet ${auto.quietMinutes}m  scan ${auto.scanMinutes}m  max ${auto.maxSessionsPerCycle}/cycle`,
    },
    { id: 'db', title: 'Database', subtitle: memDbPath() },
    { id: 'store', title: 'Store', subtitle: memHome() },
  ];
  try {
    const recent = db
      .prepare('SELECT session_id, started_at, workspace_root FROM sessions ORDER BY started_at DESC LIMIT 5')
      .all() as Array<Record<string, any>>;
    for (const row of recent) {
      rows.push({
        id: row.session_id,
        title: `recent  ${String(row.started_at ?? '').slice(0, 19)}`,
        subtitle: `${row.session_id}  ${row.workspace_root ?? ''}`,
      });
    }
  } catch {
    // Empty database.
  }
  return rows;
}

export function loadSessions(db: DatabaseSync): TuiRow[] {
  const rows = db
    .prepare(
      `SELECT session_id, started_at, workspace_root, model, tokens_in, tokens_out, status, lifecycle,
              parent_session_id, is_subagent
       FROM sessions ORDER BY started_at DESC LIMIT 200`
    )
    .all() as Array<Record<string, any>>;
  return rows.map((row) => {
    const card = db
      .prepare(
        'SELECT goal, outcome, summary, decisions_json, lessons_json, tools_json FROM session_cards WHERE session_id = ?'
      )
      .get(row.session_id) as Record<string, any> | undefined;
    const detail = card
      ? [
          `goal: ${card.goal ?? ''}`,
          `outcome: ${card.outcome ?? ''}`,
          `summary: ${card.summary ?? '(heuristic only)'}`,
          `decisions: ${card.decisions_json ?? '[]'}`,
          `lessons: ${card.lessons_json ?? '[]'}`,
          `tools: ${card.tools_json ?? '[]'}`,
        ]
      : ['no card yet'];
    return {
      id: row.session_id,
      title: `${String(row.started_at ?? '').slice(0, 19)}  ${row.model ?? ''}  ${row.status ?? ''}  [${row.lifecycle ?? '?'}]`,
      subtitle: `${row.is_subagent ? '↳ ' : ''}${row.session_id}  tokens ${row.tokens_in ?? 0}/${row.tokens_out ?? 0}  ${row.workspace_root ?? ''}${row.parent_session_id ? `  parent=${row.parent_session_id}` : ''}`,
      detail,
    };
  });
}

export function loadSearch(db: DatabaseSync, query: string): TuiRow[] {
  if (!query.trim()) return [{ id: 'hint', title: 'press / to search', subtitle: '' }];
  return searchTurns(db, query, { limit: 100 }).map((row) => ({
    id: row.id,
    title: `${row.session_id} #${row.turn_index}  ${row.role}`,
    subtitle: String(row.snip ?? '').replace(/\s+/g, ' ').slice(0, 140),
  }));
}

export function loadTasks(db: DatabaseSync): TuiRow[] {
  const rows = listTaskPrefs(db, 200).map((pref) => ({
    id: pref.task_id,
    title: `${pref.memory_enabled ? 'memory:on ' : 'memory:off'}  ${pref.capture_enabled ? 'capture:on' : 'capture:off'}`,
    subtitle: pref.task_id,
  }));
  if (rows.length === 0) {
    return [{ id: 'hint', title: 'no task overrides', subtitle: 'press i to add a task id' }];
  }
  return rows;
}

export function loadMetrics(db: DatabaseSync): TuiRow[] {
  const injection = db
    .prepare('SELECT count(*) c, coalesce(avg(chars), 0) chars FROM injections')
    .get() as { c: number; chars: number };
  const adoption = db
    .prepare(
      `SELECT sum(CASE WHEN status='active' THEN 1 ELSE 0 END) a,
              sum(CASE WHEN status='rejected' THEN 1 ELSE 0 END) r FROM memory_units`
    )
    .get() as { a: number | null; r: number | null };
  const total = (adoption.a ?? 0) + (adoption.r ?? 0);
  const rate = total > 0 ? (((adoption.a ?? 0) / total) * 100).toFixed(1) : 'n/a';
  return [
    { id: 'injections', title: `Injections ${injection.c}`, subtitle: `avg ${injection.chars.toFixed(0)} chars` },
    { id: 'adoption', title: `Adoption ${rate}%`, subtitle: `active ${adoption.a ?? 0} / rejected ${adoption.r ?? 0}` },
    {
      id: 'usage',
      title: 'Top used units',
      subtitle: '',
      detail: (
        db
          .prepare(
            `SELECT id, use_count, statement FROM memory_units
             WHERE status='active' ORDER BY coalesce(use_count,0) DESC LIMIT 5`
          )
          .all() as Array<Record<string, any>>
      ).map((row) => `${row.id} ×${row.use_count ?? 0}  ${row.statement}`),
    },
  ];
}

export function loadConfigScreen(db: DatabaseSync): TuiRow[] {
  const config = loadConfig();
  const auto = loadAutoDistillConfig();
  const distill = loadDistillConfig();
  return [
    { id: 'model', title: `model ${distill.model} (${distill.provider})`, subtitle: distill.baseUrl },
    {
      id: 'key',
      title: `api key ${distill.apiKey ? 'configured' : 'missing'}`,
      subtitle: distill.apiKey ? 'stored in ~/.llm-memory/config.json (0600)' : 'run configure-model',
    },
    {
      id: 'auto',
      title: `auto-distill ${auto.enabled ? 'ON' : 'OFF'}`,
      subtitle: `quiet ${auto.quietMinutes}m scan ${auto.scanMinutes}m max ${auto.maxSessionsPerCycle}`,
    },
    {
      id: 'injection',
      title: `injection budget ${(config.injection?.budgetChars ?? 3000)} chars`,
      subtitle: `useEmbeddings ${config.injection?.useEmbeddings === true}`,
    },
    { id: 'sources', title: 'sources', subtitle: JSON.stringify(config.sources ?? {}) },
    { id: 'embedding', title: 'embedding', subtitle: JSON.stringify(config.embedding ?? { enabled: false }) },
  ];
}

export function screens(): Screen[] {
  return [
    { id: 'dashboard', title: 'Dashboard', load: loadDashboard },
    {
      id: 'sessions',
      title: 'Sessions',
      load: loadSessions,
      actions: [
        {
          key: 'd',
          help: 'distill this session',
          run: async (row, ctx) => {
            if (!row) return;
            const config = loadDistillConfig();
            if (!config.apiKey) {
              ctx.setStatus('missing api key: run configure-model');
              return;
            }
            ctx.setStatus(`distilling ${row.id}...`);
            const summary = await distillSessions(ctxDb(ctx), config, { sessionId: String(row.id) });
            ctx.setStatus(`distill: sessions ${summary.sessions} units ${summary.units} errors ${summary.errors}`);
            ctx.reload();
          },
        },
        {
          key: 'f',
          help: 'forget session',
          run: (row, ctx) => {
            if (!row) return;
            ctx.input(`type yes to forget session ${row.id}: `, (value) => {
              if (value.trim().toLowerCase() !== 'yes') return;
              const result = forgetSession(currentDb, String(row.id), { includeActive: false });
              ctx.setStatus(
                `forgotten ${row.id}: rows ${Object.values(result.counts).reduce((a, b) => a + b, 0)}`
              );
              ctx.reload();
            });
          },
        },
      ],
    },
    { id: 'search', title: 'Search', load: () => loadSearch(ctxDbPlaceholder, ''), actions: [] },
    { id: 'candidates', title: 'Candidates', load: (db) => reviewRows(db, 'candidate'), actions: unitActions('candidate') },
    { id: 'active', title: 'Active', load: (db) => reviewRows(db, 'active'), actions: unitActions('active') },
    { id: 'skills', title: 'Skills', load: skillRows, actions: skillActions() },
    { id: 'tasks', title: 'Tasks', load: loadTasks, actions: taskActions() },
    { id: 'metrics', title: 'Metrics', load: loadMetrics },
    { id: 'config', title: 'Config', load: loadConfigScreen, actions: configActions() },
  ];
}

// Helpers used by screens; the app injects the live db via this module-level hook.
let ctxDbPlaceholder: DatabaseSync;
let currentDb: DatabaseSync;
function ctxDb(_ctx: AppController): DatabaseSync {
  return currentDb;
}

function reviewRows(db: DatabaseSync, status: 'candidate' | 'active'): TuiRow[] {
  const items = loadItems(db, status === 'candidate' ? 'candidates' : 'active');
  return items.map((item) => {
    const detail = db
      .prepare('SELECT detail, evidence_json, use_count, coalesce(pinned,0) pinned FROM memory_units WHERE id = ?')
      .get(item.id) as Record<string, any> | undefined;
    return {
      id: item.id,
      title: item.label,
      subtitle: item.subtitle,
      detail: detail
        ? [
            detail.detail ? `detail: ${detail.detail}` : '',
            `evidence: ${String(detail.evidence_json ?? '[]').slice(0, 200)}`,
            `use_count: ${detail.use_count ?? 0}${detail.pinned ? '  pinned' : ''}`,
          ].filter(Boolean)
        : [],
    };
  });
}

function unitActions(kind: 'candidate' | 'active'): Screen['actions'] {
  return [
    {
      key: 'a',
      help: 'approve',
      run: (row, ctx) => {
        if (!row || kind !== 'candidate') return;
        setUnitStatus(currentDb, Number(row.id), 'active');
        writeProfileSnapshot(currentDb);
        ctx.setStatus(`unit ${row.id} approved`);
        ctx.reload();
      },
    },
    {
      key: 'r',
      help: kind === 'active' ? 'retire' : 'reject',
      run: (row, ctx) => {
        if (!row) return;
        setUnitStatus(currentDb, Number(row.id), kind === 'active' ? 'retired' : 'rejected');
        writeProfileSnapshot(currentDb);
        ctx.setStatus(`unit ${row.id} ${kind === 'active' ? 'retired' : 'rejected'}`);
        ctx.reload();
      },
    },
    {
      key: 'p',
      help: 'pin',
      run: (row, ctx) => {
        if (!row) return;
        setPinned(currentDb, Number(row.id), true);
        writeProfileSnapshot(currentDb);
        ctx.setStatus(`unit ${row.id} pinned`);
        ctx.reload();
      },
    },
    {
      key: 'u',
      help: 'unpin',
      run: (row, ctx) => {
        if (!row) return;
        setPinned(currentDb, Number(row.id), false);
        writeProfileSnapshot(currentDb);
        ctx.setStatus(`unit ${row.id} unpinned`);
        ctx.reload();
      },
    },
    {
      key: 'e',
      help: 'edit',
      run: (row, ctx) => {
        if (!row) return;
        ctx.input('new statement: ', (value) => {
          if (!value.trim()) return;
          updateUnit(currentDb, Number(row.id), { statement: value.trim() });
          writeProfileSnapshot(currentDb);
          ctx.setStatus(`unit ${row.id} updated`);
          ctx.reload();
        });
      },
    },
    {
      key: 'f',
      help: 'forget',
      run: (row, ctx) => {
        if (!row) return;
        ctx.input(`type yes to forget unit ${row.id}: `, (value) => {
          if (value.trim().toLowerCase() !== 'yes') return;
          forgetUnit(currentDb, Number(row.id));
          writeProfileSnapshot(currentDb);
          ctx.setStatus(`unit ${row.id} forgotten`);
          ctx.reload();
        });
      },
    },
  ];
}

function skillRows(db: DatabaseSync): TuiRow[] {
  const rows = db
    .prepare('SELECT id, name, description, body, status, use_count, success_count, fail_count FROM skills ORDER BY id DESC LIMIT 200')
    .all() as Array<Record<string, any>>;
  if (rows.length === 0) {
    return [{ id: 'hint', title: 'no skills yet', subtitle: 'press n to draft from procedure memory' }];
  }
  return rows.map((row) => ({
    id: row.id,
    title: `[${row.id}] ${row.status}  ${row.name}`,
    subtitle: `${row.description ?? ''}  use=${row.use_count ?? 0} ok=${row.success_count ?? 0} fail=${row.fail_count ?? 0}`,
    detail: [`body: ${String(row.body ?? '').slice(0, 200)}`],
  }));
}

function skillActions(): Screen['actions'] {
  return [
    {
      key: 'n',
      help: 'draft skill',
      run: async (_row, ctx) => {
        const config = loadDistillConfig();
        ctx.setStatus('drafting skill...');
        const id = await draftSkill(currentDb, config);
        ctx.setStatus(id ? `skill ${id} drafted` : 'no procedure evidence');
        ctx.reload();
      },
    },
    {
      key: 'a',
      help: 'activate',
      run: (row, ctx) => {
        if (!row || typeof row.id !== 'number') return;
        const result = activateSkill(currentDb, row.id);
        ctx.setStatus(result ? `skill -> ${result.path}` : 'skill not found');
        ctx.reload();
      },
    },
    {
      key: 'r',
      help: 'reject',
      run: (row, ctx) => {
        if (!row || typeof row.id !== 'number') return;
        currentDb
          .prepare(`UPDATE skills SET status = 'rejected', updated_at = ? WHERE id = ?`)
          .run(new Date().toISOString(), row.id);
        ctx.setStatus(`skill ${row.id} rejected`);
        ctx.reload();
      },
    },
    {
      key: 'o',
      help: 'outcome success',
      run: (row, ctx) => {
        if (!row || typeof row.id !== 'number') return;
        recordSkillOutcome(currentDb, row.id, true);
        ctx.setStatus(`skill ${row.id} success recorded`);
        ctx.reload();
      },
    },
    {
      key: 'x',
      help: 'outcome fail',
      run: (row, ctx) => {
        if (!row || typeof row.id !== 'number') return;
        recordSkillOutcome(currentDb, row.id, false);
        ctx.setStatus(`skill ${row.id} fail recorded`);
        ctx.reload();
      },
    },
  ];
}

function taskActions(): Screen['actions'] {
  return [
    {
      key: 'm',
      help: 'toggle memory',
      run: (row, ctx) => {
        if (!row) return;
        const pref = listTaskPrefs(currentDb, 500).find((item) => item.task_id === row.id);
        if (!pref) return;
        setTaskPref(currentDb, String(row.id), { memory: pref.memory_enabled === 0 });
        ctx.setStatus(`task ${row.id} memory ${pref.memory_enabled === 0 ? 'enabled' : 'disabled'}`);
        ctx.reload();
      },
    },
    {
      key: 'c',
      help: 'toggle capture',
      run: (row, ctx) => {
        if (!row) return;
        const pref = listTaskPrefs(currentDb, 500).find((item) => item.task_id === row.id);
        if (!pref) return;
        setTaskPref(currentDb, String(row.id), { capture: pref.capture_enabled === 0 });
        ctx.setStatus(`task ${row.id} capture ${pref.capture_enabled === 0 ? 'enabled' : 'disabled'}`);
        ctx.reload();
      },
    },
    {
      key: 'i',
      help: 'add task id',
      run: (_row, ctx) => {
        ctx.input('task id: ', (value) => {
          if (!value.trim()) return;
          setTaskPref(currentDb, value.trim(), { memory: false });
          ctx.setStatus(`task ${value.trim()} memory disabled`);
          ctx.reload();
        });
      },
    },
  ];
}

function configActions(): Screen['actions'] {
  return [
    {
      key: 'a',
      help: 'toggle auto-distill',
      run: (_row, ctx) => {
        const config = loadConfig();
        const auto = loadAutoDistillConfig();
        config.autoDistill = { ...auto, enabled: !auto.enabled };
        saveConfig(config);
        ctx.setStatus(`auto-distill ${config.autoDistill.enabled ? 'ON' : 'OFF'}`);
        ctx.reload();
      },
    },
    {
      key: 'e',
      help: 'set quiet minutes',
      run: (_row, ctx) => {
        ctx.input('quiet minutes: ', (value) => {
          const minutes = Number(value);
          if (!Number.isFinite(minutes) || minutes <= 0) return;
          const config = loadConfig();
          config.autoDistill = { ...loadAutoDistillConfig(), quietMinutes: minutes };
          saveConfig(config);
          ctx.setStatus(`quiet window set to ${minutes}m`);
          ctx.reload();
        });
      },
    },
    {
      key: 'x',
      help: 'export',
      run: (_row, ctx) => {
        ctx.input('export dir (enter for default): ', (value) => {
          const dir = value || join(memHome(), 'exports', `tui-${Date.now()}`);
          const result = exportStore(currentDb, dir);
          ctx.setStatus(`exported ${result.units} units / ${result.cards} cards -> ${result.dir}`);
          ctx.reload();
        });
      },
    },
    {
      key: 'i',
      help: 'import',
      run: (_row, ctx) => {
        ctx.input('import dir: ', (value) => {
          const result = importStore(currentDb, value);
          ctx.setStatus(`imported ${result.units} units, skipped ${result.skipped}`);
          ctx.reload();
        });
      },
    },
    {
      key: 's',
      help: 'scan secrets',
      run: (_row, ctx) => {
        const result = scanStore(currentDb, memHome());
        ctx.setStatus(
          `scan: files ${result.filesScanned}, with secrets ${result.filesWithSecrets.length}, raw lines ${result.rawMatches}, turns ${result.turnMatches}`
        );
        ctx.reload();
      },
    },
  ];
}

export function runApp(db: DatabaseSync): void {
  currentDb = db;
  ctxDbPlaceholder = db;
  const screenList = screens();

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    for (const screen of screenList) {
      const rows = screen.load(db);
      console.log(`## ${screen.title} (${rows.length})`);
      for (const row of rows.slice(0, 10)) console.log(`  ${row.title}  ${row.subtitle}`);
    }
    console.log('run in an interactive terminal for the full TUI');
    return;
  }

  if (process.platform === 'win32') {
    try {
      execFileSync('chcp.com', ['65001'], { stdio: 'ignore' });
    } catch {
      // Code page change is best effort; Windows Terminal defaults to UTF-8.
    }
  }

  let screenIndex = 0;
  let cursor = 0;
  let rows: TuiRow[] = [];
  let status = 'ready';
  let inputMode: { label: string; buffer: string; onSubmit: (value: string) => void | Promise<void> } | null =
    null;

  const screen = () => screenList[screenIndex];

  const draw = () => {
    const tabs = screenList.map((item, index) => (index === screenIndex ? `[${item.title}]` : item.title)).join('  ');
    let out = '\x1b[2J\x1b[H';
    out += `mem TUI  ${tabs}\n`;
    out += `${'─'.repeat(Math.max(20, Math.min(100, (process.stdout.columns ?? 80))))}\n`;
    if (rows.length === 0) out += '  (empty)\n';
    rows.forEach((row, index) => {
      out += `${index === cursor ? '▶ ' : '  '}${row.title}\n     ${row.subtitle}\n`;
      if (index === cursor && row.detail) {
        for (const line of row.detail) out += `       ${line}\n`;
      }
    });
    out += `\n${status}\n`;
    const actions = (screen().actions ?? []).map((action) => `${action.key} ${action.help}`).join('  ');
    out += `keys: 1-9/Tab screens  j/k rows  / input  ${actions}  q quit\n`;
    if (inputMode) out += `${inputMode.label}${inputMode.buffer}`;
    process.stdout.write(out);
  };

  const reload = () => {
    rows = screen().load(db);
    cursor = clampIndex(cursor, rows.length);
    draw();
  };
  process.stdout.on('resize', () => draw());

  const controller: AppController = {
    setStatus: (message) => {
      status = message;
      draw();
    },
    reload,
    input: (label, onSubmit) => {
      inputMode = { label, buffer: '', onSubmit };
      draw();
    },
    quit: () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\x1b[2J\x1b[H');
    },
  };

  const finishInput = async (submit: boolean) => {
    if (!inputMode) return;
    const current = inputMode;
    inputMode = null;
    if (submit) {
      await current.onSubmit(current.buffer.trim());
    }
    draw();
  };

  const onData = async (key: string) => {
    if (inputMode) {
      if (key === '\r' || key === '\n') return finishInput(true);
      if (key === '\u001b') return finishInput(false);
      if (key === '\u007f' || key === '\b') inputMode.buffer = inputMode.buffer.slice(0, -1);
      else if (key >= ' ') inputMode.buffer += key;
      draw();
      return;
    }
    if (key === 'q' || key === '\u0003') return controller.quit();
    if (key === '\t') {
      screenIndex = (screenIndex + 1) % screenList.length;
      cursor = 0;
      return reload();
    }
    if (key === '\x1b[Z') {
      screenIndex = (screenIndex + screenList.length - 1) % screenList.length;
      cursor = 0;
      return reload();
    }
    if (/^[1-9]$/.test(key)) {
      const index = Number(key) - 1;
      if (index < screenList.length) {
        screenIndex = index;
        cursor = 0;
        reload();
      }
      return;
    }
    if (key === 'j' || key === '\x1b[B') {
      cursor = clampIndex(cursor + 1, rows.length);
      return draw();
    }
    if (key === 'k' || key === '\x1b[A') {
      cursor = clampIndex(cursor - 1, rows.length);
      return draw();
    }
    if (key === '/') {
      if (screen().id === 'search') {
        return controller.input('search: ', (value) => {
          screenList[screenIndex] = {
            ...screenList[screenIndex],
            load: (database) => loadSearch(database, value),
          };
          status = `search: ${value}`;
          reload();
        });
      }
      return;
    }
    const action = (screen().actions ?? []).find((item) => item.key === key);
    if (action) {
      try {
        await action.run(rows[cursor], controller);
      } catch (error) {
        status = `error: ${String(error).slice(0, 120)}`;
        draw();
      }
    }
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onData);
  reload();
}

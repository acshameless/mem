import { appendFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clineDataDir, hookRawDir, memDbPath, memHome } from '../core/paths.ts';
import { correlateSessions } from '../ingest/correlate.ts';
import { discoverSessionDirs, ingestAllSessions, ingestSessionDir } from '../ingest/sessions.ts';
import { ingestHookDir, ingestHookFile } from '../ingest/hooks.ts';
import { mergeHookToolDurations } from '../ingest/tool_durations.ts';
import { backfillTurnSegments } from '../ingest/backfill.ts';
import { generateSessionCards } from '../ingest/cards.ts';
import { loadAutoDistillConfig, loadDistillConfig } from '../core/config.ts';
import { distillSessions } from '../distill/run.ts';
import { ingestInjectionDir, ingestInjectionFile } from '../ingest/injections.ts';
import { updateUnitUsage } from '../core/units.ts';
import { openDb } from '../store/db.ts';

export interface DaemonOptions {
  pollMs?: number;
  resyncMs?: number;
}

export function startDaemon(options: DaemonOptions = {}): () => void {
  const db = openDb(memDbPath());
  const hooksDir = hookRawDir();
  const sessionsRoot = join(clineDataDir(), 'sessions');
  const injectionDir = join(memHome(), 'raw', 'injections');
  mkdirSync(hooksDir, { recursive: true });
  mkdirSync(sessionsRoot, { recursive: true });

  // launchd (macOS) already redirects stdout to memd.out.log; Windows Task
  // Scheduler does not, so only write the file when there is no redirect.
  const fileLogging = process.platform === 'win32' || process.env.MEM_LOG_FILE === '1';

  const log = (...parts: unknown[]) => {
    const line = `${new Date().toISOString()} ${parts.map((part) => String(part)).join(' ')}`;
    console.log(line);
    if (!fileLogging) return;
    try {
      mkdirSync(join(memHome(), 'logs'), { recursive: true });
      appendFileSync(join(memHome(), 'logs', 'memd.out.log'), `${line}\n`);
    } catch {
      // File logging is best effort.
    }
  };

  function syncAll(reason: string): void {
    const hooks = ingestHookDir(db, hooksDir);
    const sessions = ingestAllSessions(db, sessionsRoot);
    const segments = backfillTurnSegments(db);
    const cards = generateSessionCards(db);
    const usage = updateUnitUsage(db);
    const linked = correlateSessions(db);
    const merged = mergeHookToolDurations(db);
    log(
      `${reason}: hooks +${hooks.events}/${hooks.files} files, sessions ${sessions}, segments ${segments}, cards ${cards}, usage ${usage}, linked ${linked}, tool_durations ${merged}`
    );
  }

  syncAll('startup');

  const hookState = new Map<string, string>();
  const sessionState = new Map<string, string>();
  const injectionState = new Map<string, string>();

  function fileFingerprint(path: string): string {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  }

  function scanHooks(): void {
    for (const name of readdirSync(hooksDir).filter((entry) => entry.endsWith('.jsonl'))) {
      const path = join(hooksDir, name);
      const fingerprint = fileFingerprint(path);
      if (hookState.get(path) === fingerprint) continue;
      hookState.set(path, fingerprint);
      const added = ingestHookFile(db, path);
      if (added > 0) {
        correlateSessions(db);
        mergeHookToolDurations(db);
        log(`hook file ${name}: +${added} events`);
      }
    }
  }

  function scanSessions(): void {
    let changed = false;
    for (const dir of discoverSessionDirs(sessionsRoot)) {
      const fingerprint = readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => `${name}:${fileFingerprint(join(dir, name))}`)
        .join('|');
      if (sessionState.get(dir) === fingerprint) continue;
      sessionState.set(dir, fingerprint);
      if (ingestSessionDir(db, dir)) changed = true;
    }
    if (changed) {
      generateSessionCards(db);
      correlateSessions(db);
      mergeHookToolDurations(db);
      log('sessions synced');
    }
  }

  function scanInjections(): void {
    let names: string[] = [];
    try {
      names = readdirSync(injectionDir);
    } catch {
      return;
    }
    for (const name of names.filter((entry) => entry.endsWith('.jsonl'))) {
      const path = join(injectionDir, name);
      const fingerprint = fileFingerprint(path);
      if (injectionState.get(path) === fingerprint) continue;
      injectionState.set(path, fingerprint);
      const added = ingestInjectionFile(db, path);
      if (added > 0) log(`injection file ${name}: +${added} records`);
    }
  }

  scanHooks();
  scanSessions();
  scanInjections();

  let lastAutoDistill = 0;
  let distilling = false;
  async function maybeAutoDistill(): Promise<void> {
    const auto = loadAutoDistillConfig();
    if (!auto.enabled || distilling) return;
    const now = Date.now();
    if (now - lastAutoDistill < auto.scanMinutes * 60_000) return;
    lastAutoDistill = now;
    const distillConfig = loadDistillConfig();
    if (!distillConfig.apiKey) return;
    distilling = true;
    try {
      const summary = await distillSessions(db, distillConfig, {
        limit: auto.maxSessionsPerCycle,
        quietMinutes: auto.quietMinutes,
        reDistillOnChange: auto.reDistillOnChange,
      });
      if (summary.sessions > 0) {
        log(
          `auto-distill: sessions ${summary.sessions}, units ${summary.units}, duplicates ${summary.skippedDuplicates}, semantic-duplicates ${summary.skippedSemanticDuplicates}, errors ${summary.errors}`
        );
      } else if (summary.skippedQuiet > 0) {
        log(`auto-distill: ${summary.skippedQuiet} session(s) waiting for quiet window`);
      }
    } catch (error) {
      console.error(new Date().toISOString(), 'auto-distill error:', String(error));
    } finally {
      distilling = false;
    }
  }

  void maybeAutoDistill();

  const poll = setInterval(() => {
    try {
      scanHooks();
      scanSessions();
      scanInjections();
      void maybeAutoDistill();
    } catch (error) {
      console.error(new Date().toISOString(), 'poll error:', String(error));
    }
  }, options.pollMs ?? 2_000);

  const resync = setInterval(() => syncAll('resync'), options.resyncMs ?? 300_000);

  const stop = (): void => {
    clearInterval(resync);
    clearInterval(poll);
    db.close();
    log('stopped');
  };

  process.once('SIGINT', () => {
    stop();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    stop();
    process.exit(0);
  });

  log(`watching hooks=${hooksDir} sessions=${sessionsRoot} db=${memDbPath()}`);
  return stop;
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (entry === import.meta.url) {
  startDaemon();
}

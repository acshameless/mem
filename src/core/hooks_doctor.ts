import { accessSync, constants, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';

export const HOOK_EVENTS = [
  'TaskStart',
  'TaskResume',
  'TaskCancel',
  'TaskComplete',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'PreCompact',
  'Notification',
] as const;

export interface HookFileStatus {
  event: string;
  installed: boolean;
  executable: boolean;
  path: string;
}

export function defaultHooksDir(platform = process.platform): string {
  const documents = join(homedir(), 'Documents', 'Cline', 'Hooks');
  return process.env.CLINE_HOOKS_DIR ?? documents;
}

// Windows hooks use <Event>.ps1. Other platforms use the bare event name.
export function checkHookFiles(
  dir: string,
  platform = process.platform
): HookFileStatus[] {
  return HOOK_EVENTS.map((event) => {
    const path = join(dir, platform === 'win32' ? `${event}.ps1` : event);
    const installed = existsSync(path);
    let executable = installed;
    if (installed && platform !== 'win32') {
      try {
        accessSync(path, constants.X_OK);
        executable = true;
      } catch {
        executable = false;
      }
    }
    return { event, installed, executable, path };
  });
}

export interface HookEventStat {
  event: string;
  count: number;
  lastSeen: string | null;
}

export function hookEventStats(db: DatabaseSync): HookEventStat[] {
  const rows = db
    .prepare(
      `SELECT event, count(*) c, max(received_at) last_seen
       FROM hook_events GROUP BY event`
    )
    .all() as Array<{ event: string; c: number; last_seen: string | null }>;
  const map = new Map(rows.map((row) => [row.event, row]));
  return HOOK_EVENTS.map((event) => ({
    event,
    count: map.get(event)?.c ?? 0,
    lastSeen: map.get(event)?.last_seen ?? null,
  }));
}

export type HookHealth = 'ok' | 'warn_never_fired' | 'missing' | 'not_executable';

export interface HookDoctorRow extends HookFileStatus, HookEventStat {
  health: HookHealth;
}

export function hooksDoctor(
  db: DatabaseSync,
  dir: string,
  platform = process.platform
): HookDoctorRow[] {
  const files = new Map(checkHookFiles(dir, platform).map((row) => [row.event, row]));
  const stats = new Map(hookEventStats(db).map((row) => [row.event, row]));
  return HOOK_EVENTS.map((event) => {
    const file = files.get(event)!;
    const stat = stats.get(event)!;
    let health: HookHealth = 'ok';
    if (!file.installed) health = 'missing';
    else if (!file.executable) health = 'not_executable';
    else if (stat.count === 0) health = 'warn_never_fired';
    return { ...file, ...stat, health };
  });
}

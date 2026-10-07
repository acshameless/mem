import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkHookFiles, hookEventStats, hooksDoctor } from '../src/core/hooks_doctor.ts';
import { openDb } from '../src/store/db.ts';

test('hooks doctor detects missing, non-executable and never-fired hooks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-hooks-'));
  writeFileSync(join(dir, 'UserPromptSubmit'), '#!/bin/bash\n');
  chmodSync(join(dir, 'UserPromptSubmit'), 0o755);
  writeFileSync(join(dir, 'PreCompact'), '#!/bin/bash\n');
  chmodSync(join(dir, 'PreCompact'), 0o644);
  writeFileSync(join(dir, 'Notification'), '#!/bin/bash\n');
  chmodSync(join(dir, 'Notification'), 0o755);

  // Inject the permission check. Windows has no POSIX executable bit.
  const isExecutable = (path: string) => !path.endsWith('PreCompact');
  const files = checkHookFiles(dir, 'darwin', isExecutable);
  assert.equal(files.find((row) => row.event === 'UserPromptSubmit')!.executable, true);
  assert.equal(files.find((row) => row.event === 'PreCompact')!.executable, false);
  assert.equal(files.find((row) => row.event === 'TaskStart')!.installed, false);

  const db = openDb(join(dir, 'memory.db'));
  db.prepare(
    `INSERT INTO hook_events (dedupe_key, event, received_at, payload_json)
     VALUES ('k1', 'UserPromptSubmit', '2026-10-07T01:00:00Z', '{}')`
  ).run();
  const stats = hookEventStats(db);
  assert.equal(stats.find((row) => row.event === 'UserPromptSubmit')!.count, 1);
  assert.equal(stats.find((row) => row.event === 'TaskStart')!.count, 0);

  const rows = hooksDoctor(db, dir, 'darwin', isExecutable);
  assert.equal(rows.find((row) => row.event === 'UserPromptSubmit')!.health, 'ok');
  assert.equal(rows.find((row) => row.event === 'PreCompact')!.health, 'not_executable');
  assert.equal(rows.find((row) => row.event === 'TaskStart')!.health, 'missing');
  assert.equal(rows.find((row) => row.event === 'Notification')!.health, 'warn_never_fired');
  db.close();
});

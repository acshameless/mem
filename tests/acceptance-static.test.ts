import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { staticChecks, waitForSession } from '../src/acceptance/run.ts';
import { openDb } from '../src/store/db.ts';

test('acceptance static checks and wait helper', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mem-acc-static-'));
  const hooksDir = join(home, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const previous = process.env.CLINE_HOOKS_DIR;
  process.env.CLINE_HOOKS_DIR = hooksDir;
  const previousHome = process.env.MEM_HOME;
  process.env.MEM_HOME = home;
  try {
    for (const event of [
      'TaskStart',
      'TaskResume',
      'TaskCancel',
      'TaskComplete',
      'PreToolUse',
      'PostToolUse',
      'UserPromptSubmit',
      'PreCompact',
      'Notification',
    ]) {
      writeFileSync(join(hooksDir, event), '#!/bin/bash\n');
      chmodSync(join(hooksDir, event), 0o755);
    }
    const db = openDb(join(home, 'db', 'memory.db'));
    const checks = staticChecks(db);
    assert.equal(checks.find((step) => step.id === 'hooks_installed')!.status, 'pass');

    db.prepare(
      `INSERT INTO sessions (session_id, prompt, status, started_at)
       VALUES ('wait_session', 'MARKER-WAIT 测试', 'idle', '2026-10-08T01:00:00Z')`
    ).run();
    let slept = 0;
    const found = await waitForSession(db, 'MARKER-WAIT', 5000, async () => {
      slept += 1;
    });
    assert.equal(found.found, true);
    assert.equal(slept, 0);
    db.close();
  } finally {
    if (previous === undefined) delete process.env.CLINE_HOOKS_DIR;
    else process.env.CLINE_HOOKS_DIR = previous;
    if (previousHome === undefined) delete process.env.MEM_HOME;
    else process.env.MEM_HOME = previousHome;
  }
});

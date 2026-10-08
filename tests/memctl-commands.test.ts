import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { insertUnit } from '../src/core/units.ts';
import { openDb } from '../src/store/db.ts';

interface CliEnv {
  MEM_HOME: string;
  MEM_DB: string;
  MEM_CONFIG: string;
  CLINE_HOOKS_DIR: string;
  CLINE_SKILLS_DIR: string;
}

function setup(): { env: CliEnv; ids: number[] } {
  const home = mkdtempSync(join(tmpdir(), 'mem-cli-cmd-'));
  const env: CliEnv = {
    MEM_HOME: home,
    MEM_DB: join(home, 'db', 'memory.db'),
    MEM_CONFIG: join(home, 'config.json'),
    CLINE_HOOKS_DIR: join(home, 'hooks'),
    CLINE_SKILLS_DIR: join(home, 'skills'),
  };
  mkdirSync(env.CLINE_HOOKS_DIR, { recursive: true });
  const db = openDb(env.MEM_DB);
  const first = insertUnit(db, {
    type: 'taste',
    statement: 'CLI 测试候选一',
    status: 'candidate',
    confidence: 0.6,
  });
  const second = insertUnit(db, {
    type: 'pitfall',
    statement: 'CLI 测试候选二',
    status: 'candidate',
    confidence: 0.5,
  });
  db.prepare(
    `INSERT INTO sessions (session_id, prompt, lifecycle, status, workspace_root, started_at)
     VALUES ('cli_session', '部署 CLI 测试项目', 'completed', 'idle', '/tmp/ws', '2026-10-08T01:00:00Z')`
  ).run();
  db.prepare(
    `INSERT INTO tool_calls (session_id, turn_index, tool_call_id, tool_name, success)
     VALUES ('cli_session', 0, 'cli-call', 'run_commands', 1)`
  ).run();
  db.close();
  return { env, ids: [first, second] };
}

function runCli(args: string[], env: CliEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/memctl.mjs', ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

test('memctl units, profile, paths and hooks commands', async () => {
  const { env, ids } = setup();
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
    writeFileSync(join(env.CLINE_HOOKS_DIR, event), '#!/bin/bash\n');
    chmodSync(join(env.CLINE_HOOKS_DIR, event), 0o755);
  }

  const list = await runCli(['units', 'list', '--status', 'candidate'], env);
  assert.equal(list.code, 0);
  assert.match(list.stdout, /CLI 测试候选一/);

  const approve = await runCli(['units', 'approve', String(ids[0])], env);
  assert.equal(approve.code, 0);
  assert.match(approve.stdout, /profile updated/);

  const edit = await runCli(
    ['units', 'edit', String(ids[1]), '--statement', 'CLI 编辑后的语句'],
    env
  );
  assert.equal(edit.code, 0);

  const pin = await runCli(['units', 'pin', String(ids[0])], env);
  assert.equal(pin.code, 0);

  const profile = await runCli(['profile', 'write'], env);
  assert.equal(profile.code, 0);
  assert.ok(existsSync(join(env.MEM_HOME, 'profiles', 'TASTE.md')));

  const paths = await runCli(['paths', '--rebuild'], env);
  assert.equal(paths.code, 0);
  assert.match(paths.stdout, /path group/);

  const hooks = await runCli(['hooks'], env);
  assert.equal(hooks.code, 0);
  assert.match(hooks.stdout, /hooks ok|hook\(s\) are missing/);

  const validate = await runCli(['hooks', '--validate'], env);
  assert.equal(validate.code, 0);
  assert.match(validate.stdout, /0 violation/);
});

test('memctl tasks, export, import, forget and config commands', async () => {
  const { env, ids } = setup();
  const off = await runCli(['off', 'task_cli'], env);
  assert.equal(off.code, 0);
  const tasks = await runCli(['tasks'], env);
  assert.match(tasks.stdout, /task_cli/);
  const on = await runCli(['on', 'task_cli'], env);
  assert.match(on.stdout, /enabled/);

  const exportDir = join(env.MEM_HOME, 'export');
  const exported = await runCli(['export', '--out', exportDir], env);
  assert.equal(exported.code, 0);
  assert.ok(existsSync(join(exportDir, 'manifest.json')));

  const imported = await runCli(['import', exportDir], env);
  assert.equal(imported.code, 0);
  assert.match(imported.stdout, /imported/);

  const forget = await runCli(['forget', 'unit', String(ids[1]), '--yes'], env);
  assert.equal(forget.code, 0);

  const model = await runCli(['llm', 'model', 'test-model'], env);
  assert.equal(model.code, 0);
  const embedding = await runCli(['embedding', 'preset', 'local'], env);
  assert.equal(embedding.code, 0);

  const metrics = await runCli(['metrics'], env);
  assert.equal(metrics.code, 0);
  const report = await runCli(['report'], env);
  assert.equal(report.code, 0);
  const scan = await runCli(['scan'], env);
  assert.equal(scan.code, 0);
  const sources = await runCli(['sources'], env);
  assert.match(sources.stdout, /cline/);
  const sessions = await runCli(['sessions'], env);
  assert.match(sessions.stdout, /cli_session/);
  const card = await runCli(['card', 'cli_session'], env);
  assert.equal(card.code, 0);
});

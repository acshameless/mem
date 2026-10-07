import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isCaptureEnabled, isMemoryEnabled, setTaskPref } from '../src/core/prefs.ts';
import { ingestSessionDir } from '../src/ingest/sessions.ts';
import { openDb } from '../src/store/db.ts';

function runHook(dbPath: string, home: string, taskId: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/hooks/user_prompt_submit.ts'], {
      env: { ...process.env, MEM_DB: dbPath, MEM_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('close', (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(String(code)))));
    child.stdin.write(
      JSON.stringify({
        taskId,
        workspaceRoots: ['/Users/shameless/Github/mem'],
        userPromptSubmit: { prompt: `<user_input mode="act">${prompt}</user_input>`, attachments: [] },
      })
    );
    child.stdin.end();
  });
}

test('task prefs disable memory or capture', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mem-prefs-'));
  const dbPath = join(home, 'db', 'memory.db');
  const db = openDb(dbPath);
  ingestSessionDir(db, 'tests/fixtures/phase0/session-project');
  assert.equal(isMemoryEnabled(db, 'task_any'), true, 'default must be enabled');
  setTaskPref(db, 'task_off', { memory: false });
  setTaskPref(db, 'task_no_capture', { capture: false });
  assert.equal(isMemoryEnabled(db, 'task_off'), false);
  assert.equal(isCaptureEnabled(db, 'task_no_capture'), false);
  db.close();

  const day = new Date().toISOString().slice(0, 10);
  const rawFile = join(home, 'raw', 'hooks', `${day}.jsonl`);

  const prefOff = await runHook(dbPath, home, 'task_off', 'nonce 相关提问');
  assert.equal(JSON.parse(prefOff).contextModification, '');
  assert.match(readFileSync(rawFile, 'utf8'), /task_off/, 'capture still happens when memory is off');

  const inline = await runHook(dbPath, home, 'task_inline', '@nomem nonce 相关提问');
  assert.equal(JSON.parse(inline).contextModification, '');

  const noCapture = await runHook(dbPath, home, 'task_no_capture', 'nonce 相关提问');
  assert.notEqual(JSON.parse(noCapture).contextModification, '', 'memory still works when capture is off');
  assert.doesNotMatch(readFileSync(rawFile, 'utf8'), /task_no_capture/);
  assert.ok(existsSync(rawFile));
});

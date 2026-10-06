import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('generic capture hook appends events and returns a no-op result', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mem-capture-'));
  const payload = { taskId: 'conv_capture', preToolUse: { toolName: 'run_commands' } };
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['src/hooks/capture.ts', 'PreToolUse'], {
      env: { ...process.env, MEM_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('close', (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(String(code)))));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.cancel, false);
  assert.equal(parsed.contextModification, '');

  const day = new Date().toISOString().slice(0, 10);
  const raw = readFileSync(join(home, 'raw', 'hooks', `${day}.jsonl`), 'utf8');
  assert.match(raw, /"event":"PreToolUse"/);
  assert.match(raw, /conv_capture/);
});

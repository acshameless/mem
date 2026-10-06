import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('precompact hook archives context files and records an index entry', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mem-precompact-'));
  const sourceDir = mkdtempSync(join(tmpdir(), 'mem-context-'));
  const contextJson = join(sourceDir, 'context.json');
  const contextRaw = join(sourceDir, 'context.raw');
  writeFileSync(contextJson, '{"messages":[]}');
  writeFileSync(contextRaw, 'raw context');

  const payload = {
    taskId: 'conv_pre_test',
    preCompact: {
      contextSize: 4096,
      compactionStrategy: 'auto',
      contextJsonPath: contextJson,
      contextRawPath: contextRaw,
      tokensIn: 1200,
      tokensOut: 300,
    },
  };

  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['src/hooks/pre_compact.ts'], {
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

  const sessionDir = join(home, 'archive', 'conv_pre_test');
  const stamps = readdirSync(sessionDir);
  assert.equal(stamps.length, 1);
  const archiveDir = join(sessionDir, stamps[0]);
  assert.ok(existsSync(join(archiveDir, 'context.json')));
  assert.ok(existsSync(join(archiveDir, 'context.raw')));

  const index = readFileSync(join(home, 'archive', 'index.jsonl'), 'utf8');
  assert.match(index, /conv_pre_test/);
  assert.match(index, /context\.json/);
});

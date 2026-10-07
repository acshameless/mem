import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDb } from '../src/store/db.ts';

function runCli(args: string[], env: Record<string, string> = {}): Promise<string> {
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
    child.on('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`${code}: ${stderr || stdout}`))
    );
  });
}

test('memctl bin wrapper runs the CLI without node prefix', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'mem-cli-')), 'memory.db');
  const db = openDb(dbPath);
  db.close();
  const status = await runCli(['status'], { MEM_DB: dbPath });
  assert.match(status, /hook events/);
  const usage = await runCli([], { MEM_DB: dbPath });
  assert.match(usage, /memctl/);
});

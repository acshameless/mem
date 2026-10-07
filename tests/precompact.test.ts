import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { insertUnit, setPinned } from '../src/core/units.ts';
import { openDb } from '../src/store/db.ts';

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
  assert.equal(parsed.contextModification, '', 'PreCompact injection is opt-in');

  const sessionDir = join(home, 'archive', 'conv_pre_test');
  const stamps = readdirSync(sessionDir);
  assert.equal(stamps.length, 1);
  const archiveDir = join(sessionDir, stamps[0]);
  assert.ok(existsSync(join(archiveDir, 'context.json')));
  assert.ok(existsSync(join(archiveDir, 'context.raw')));

  const index = readFileSync(join(home, 'archive', 'index.jsonl'), 'utf8');
  assert.match(index, /conv_pre_test/);
  assert.match(index, /context\.json/);

  // Enable the opt-in continuity card and add one pinned memory.
  const db = openDb(join(home, 'db', 'memory.db'));
  const unitId = insertUnit(db, {
    type: 'taste',
    statement: '压缩后也要保留：先给结论再给细节',
    status: 'active',
    confidence: 0.9,
  });
  setPinned(db, unitId, true);
  db.close();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ injection: { preCompact: true } }));

  const second = await new Promise<string>((resolve, reject) => {
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
  const withCard = JSON.parse(second);
  assert.match(withCard.contextModification, /source="precompact"/);
  assert.match(withCard.contextModification, /先给结论再给细节/);
  assert.match(withCard.contextModification, /pinned="true"/);
});

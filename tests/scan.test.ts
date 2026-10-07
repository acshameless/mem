import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { redactRawStore, scanStore } from '../src/core/scan.ts';
import { openDb } from '../src/store/db.ts';

test('scan detects secrets in raw files and can redact them', () => {
  const home = mkdtempSync(join(tmpdir(), 'mem-scan-'));
  const rawDir = join(home, 'raw', 'hooks');
  mkdirSync(rawDir, { recursive: true });
  const file = join(rawDir, '2026-10-07.jsonl');
  appendFileSync(file, `${JSON.stringify({ event: 'UserPromptSubmit', payload: { prompt: 'key sk-abcdefghijklmnop1234567890' } })}\n`);
  appendFileSync(file, `${JSON.stringify({ event: 'TaskStart', payload: { taskId: 'clean' } })}\n`);

  const db = openDb(join(home, 'db', 'memory.db'));
  const scan = scanStore(db, home);
  assert.equal(scan.filesWithSecrets.length, 1);
  assert.equal(scan.rawMatches, 1);

  const redacted = redactRawStore(home);
  assert.equal(redacted.lines, 1);
  const content = readFileSync(file, 'utf8');
  assert.doesNotMatch(content, /sk-abcdefghijklmnop/);
  assert.match(content, /\[REDACTED\]/);
  assert.match(content, /clean/);
  db.close();
});

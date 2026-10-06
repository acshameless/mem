import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openDb } from '../src/store/db.ts';
import { correlateSessions } from '../src/ingest/correlate.ts';
import { ingestHookFile } from '../src/ingest/hooks.ts';
import { ingestSessionDir } from '../src/ingest/sessions.ts';
import { generateSessionCards } from '../src/ingest/cards.ts';

const FIXTURES = 'tests/fixtures/phase0';

function seedDb(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'mem-hook-')), 'memory.db');
  const db = openDb(path);
  ingestHookFile(db, join(FIXTURES, 'hooks/2026-10-06.jsonl'));
  ingestSessionDir(db, join(FIXTURES, 'session'));
  ingestSessionDir(db, join(FIXTURES, 'session-tools'));
  ingestSessionDir(db, join(FIXTURES, 'session-project'));
  generateSessionCards(db);
  correlateSessions(db);
  db.close();
  return path;
}

function runHook(dbPath: string, payload: unknown, memHome?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/hooks/user_prompt_submit.ts'], {
      env: { ...process.env, MEM_DB: dbPath, ...(memHome ? { MEM_HOME: memHome } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`hook exited with ${code}`));
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

test('user prompt hook injects a fixed memory block on a match', async () => {
  const dbPath = seedDb();
  const output = await runHook(dbPath, {
    taskId: 'conv_new_task',
    workspaceRoots: ['/Users/shameless/Github/mem'],
    userPromptSubmit: { prompt: '<user_input mode="act">nonce</user_input>', attachments: [] },
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.cancel, false);
  assert.match(parsed.contextModification, /<memory version="1"/);
  assert.match(parsed.contextModification, /<cards>/);
  assert.match(parsed.contextModification, /<card /);
  assert.match(parsed.contextModification, /<past>/);
  assert.ok(
    parsed.contextModification.length <= 3400,
    `block must stay near the 3000 char budget, got ${parsed.contextModification.length}`
  );
});

test('user prompt hook returns no block when nothing matches', async () => {
  const dbPath = seedDb();
  const output = await runHook(dbPath, {
    taskId: 'conv_new_task',
    workspaceRoots: ['/Users/shameless/Github/mem'],
    userPromptSubmit: { prompt: 'zzzqqq_no_such_memory_token', attachments: [] },
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.contextModification, '');
});

test('hook recall uses OR semantics across prompt tokens', async () => {
  const dbPath = seedDb();
  const output = await runHook(dbPath, {
    taskId: 'conv_new_task',
    workspaceRoots: ['/Users/shameless/Github/mem'],
    userPromptSubmit: {
      prompt: '<user_input mode="act">nonce 另外的完全无关句子xyz</user_input>',
      attachments: [],
    },
  });
  const parsed = JSON.parse(output);
  assert.match(parsed.contextModification, /<memory version="1"/);
});

test('hook excludes the current session resolved by time window', async () => {
  const dbPath = seedDb();
  const timestamp = 1791296066856;
  const db = new DatabaseSync(dbPath);
  db.prepare(
    `INSERT INTO sessions (session_id, workspace_root, started_at, hook_task_id)
     VALUES (?, ?, ?, NULL)`
  ).run('current_session_test', '/Users/shameless/Github/mem', new Date(timestamp).toISOString());
  db.prepare(
    `INSERT INTO turns (session_id, turn_index, block_index, role, kind, text)
     VALUES (?, 0, 0, 'user', 'text', 'nonce from the current session')`
  ).run('current_session_test');
  db.close();

  const output = await runHook(dbPath, {
    taskId: 'conv_other_task',
    timestamp: String(timestamp),
    workspaceRoots: ['/Users/shameless/Github/mem'],
    userPromptSubmit: { prompt: '<user_input mode="act">nonce</user_input>', attachments: [] },
  });
  const parsed = JSON.parse(output);
  assert.match(parsed.contextModification, /<memory version="1"/);
  assert.doesNotMatch(parsed.contextModification, /current_session_test/);
});

test('hook writes the raw UserPromptSubmit event to the capture file', async () => {
  const dbPath = seedDb();
  const home = mkdtempSync(join(tmpdir(), 'mem-home-'));
  await runHook(
    dbPath,
    {
      taskId: 'conv_capture_task',
      workspaceRoots: ['/Users/shameless/Github/mem'],
      userPromptSubmit: { prompt: '<user_input mode="act">nonce</user_input>', attachments: [] },
    },
    home
  );
  const day = new Date().toISOString().slice(0, 10);
  const capture = join(home, 'raw', 'hooks', `${day}.jsonl`);
  assert.ok(existsSync(capture), `expected capture file ${capture}`);
  assert.match(readFileSync(capture, 'utf8'), /"event":"UserPromptSubmit"/);

  const injectionSpool = join(home, 'raw', 'injections', `${day}.jsonl`);
  assert.ok(existsSync(injectionSpool), 'injection metrics must be recorded');
  assert.match(readFileSync(injectionSpool, 'utf8'), /"sections"/);
});

test('hook deduplicates near-identical content across sessions', async () => {
  const dbPath = seedDb();
  const db = new DatabaseSync(dbPath);
  const text = 'unique_dedupe_marker nonce payload for comparison';
  for (const id of ['dup_session_a', 'dup_session_b']) {
    db.prepare(
      `INSERT INTO sessions (session_id, workspace_root, started_at, hook_task_id)
       VALUES (?, ?, '2026-10-06T12:00:00.000Z', NULL)`
    ).run(id, '/Users/shameless/Github/mem');
    db.prepare(
      `INSERT INTO turns (session_id, turn_index, block_index, role, kind, text, text_seg)
       VALUES (?, 0, 0, 'assistant', 'text', ?, ?)`
    ).run(id, text, text);
  }
  db.close();

  const output = await runHook(dbPath, {
    taskId: 'conv_dedupe_task',
    workspaceRoots: ['/Users/shameless/Github/mem'],
    userPromptSubmit: {
      prompt: '<user_input mode="act">unique_dedupe_marker</user_input>',
      attachments: [],
    },
  });
  const block = JSON.parse(output).contextModification as string;
  const occurrences = block.split('unique_dedupe_marker').length - 1;
  assert.equal(occurrences, 1, 'near-identical content must appear once');
});

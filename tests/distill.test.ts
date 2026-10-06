import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { DistillConfig } from '../src/core/config.ts';
import { loadAutoDistillConfig } from '../src/core/config.ts';
import { findSimilarUnit, insertUnit, setUnitStatus } from '../src/core/units.ts';
import { distillSessions } from '../src/distill/run.ts';
import { correlateSessions } from '../src/ingest/correlate.ts';
import { ingestHookFile } from '../src/ingest/hooks.ts';
import { ingestSessionDir } from '../src/ingest/sessions.ts';
import { openDb } from '../src/store/db.ts';

const FIXTURES = 'tests/fixtures/phase0';
const SESSION_ID = '1791295188490_6mnpx';

function seedDb(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'mem-distill-')), 'memory.db');
  const db = openDb(path);
  ingestHookFile(db, join(FIXTURES, 'hooks/2026-10-06.jsonl'));
  ingestSessionDir(db, join(FIXTURES, 'session'));
  ingestSessionDir(db, join(FIXTURES, 'session-tools'));
  ingestSessionDir(db, join(FIXTURES, 'session-project'));
  correlateSessions(db);
  db.close();
  return path;
}

function runHook(dbPath: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/hooks/user_prompt_submit.ts'], {
      env: { ...process.env, MEM_DB: dbPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('close', (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(String(code)))));
    child.stdin.write(
      JSON.stringify({
        taskId: 'conv_distill_test',
        workspaceRoots: ['/Users/shameless/Github/mem'],
        userPromptSubmit: { prompt: `<user_input mode="act">${prompt}</user_input>`, attachments: [] },
      })
    );
    child.stdin.end();
  });
}

test('distill pipeline extracts candidates, review activates, hook injects taste', async () => {
  const dbPath = seedDb();
  const config: DistillConfig = {
    provider: 'mock',
    baseUrl: 'http://mock.local',
    model: 'mock-model',
    apiKey: 'test-key',
    maxSessionsPerRun: 5,
    maxCharsPerSession: 8000,
    temperature: 0,
  };
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                units: [
                  {
                    type: 'taste',
                    statement: '偏好简洁直接的中文回答',
                    detail: '不喜欢冗长解释',
                    scope: 'person',
                    confidence: 0.9,
                    evidence: [{ quote: '不要解释' }],
                  },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as typeof fetch;

  const db = openDb(dbPath);
  const summary = await distillSessions(db, config, { sessionId: SESSION_ID, fetchImpl });
  assert.equal(summary.sessions, 1);
  assert.equal(summary.units, 1);
  assert.equal(summary.errors, 0);

  const unit = db
    .prepare('SELECT id, status FROM memory_units ORDER BY id DESC LIMIT 1')
    .get() as { id: number; status: string };
  assert.equal(unit.status, 'candidate');

  const state = db
    .prepare('SELECT status FROM distill_state WHERE session_id = ?')
    .get(SESSION_ID) as { status: string };
  assert.equal(state.status, 'done');

  setUnitStatus(db, unit.id, 'active');
  db.close();

  const output = await runHook(dbPath, '请简洁回答');
  const block = JSON.parse(output).contextModification as string;
  assert.match(block, /<taste>/);
  assert.match(block, /偏好简洁直接的中文回答/);

  const again = openDb(dbPath);
  const second = await distillSessions(again, config, { sessionId: SESSION_ID, fetchImpl });
  assert.equal(second.sessions, 0, 'distilled sessions must be skipped');
  again.close();
});

test('near-duplicate statements are detected by containment similarity', () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'mem-units-')), 'memory.db'));
  insertUnit(db, {
    type: 'taste',
    statement: '用户偏好极简、直接的输出，要求只列结果不解释。',
  });
  const duplicate = findSimilarUnit(db, '用户偏好极简、无解释的直接输出，明确要求只列结果不解释。');
  assert.notEqual(duplicate, null, 'near-duplicate statements must collapse');
  db.close();
});

test('auto distill respects the quiet window and re-distills changed sessions', async () => {
  const dbPath = seedDb();
  const config: DistillConfig = {
    provider: 'mock',
    baseUrl: 'http://mock.local',
    model: 'mock-model',
    apiKey: 'test-key',
    maxSessionsPerRun: 5,
    maxCharsPerSession: 8000,
    temperature: 0,
  };
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                units: [
                  {
                    type: 'preference',
                    statement: '自动蒸馏测试偏好',
                    confidence: 0.8,
                    evidence: [{ quote: 'test' }],
                  },
                ],
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as typeof fetch;

  const db = openDb(dbPath);
  const oldIso = new Date(Date.now() - 30 * 60_000).toISOString();
  const recentIso = new Date(Date.now() - 60_000).toISOString();
  db.prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?').run(oldIso, SESSION_ID);

  const first = await distillSessions(db, config, {
    sessionId: SESSION_ID,
    fetchImpl,
    quietMinutes: 15,
    reDistillOnChange: true,
  });
  assert.equal(first.sessions, 1);

  db.prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?').run(recentIso, SESSION_ID);
  const second = await distillSessions(db, config, {
    sessionId: SESSION_ID,
    fetchImpl,
    quietMinutes: 15,
    reDistillOnChange: true,
  });
  assert.equal(second.sessions, 0, 'recent sessions must wait for the quiet window');
  assert.equal(second.skippedQuiet, 1, 'quiet-window skips must be reported');

  db.prepare('UPDATE distill_state SET distilled_at = ? WHERE session_id = ?').run(
    new Date(Date.now() - 60 * 60_000).toISOString(),
    SESSION_ID
  );
  db.prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?').run(oldIso, SESSION_ID);
  const third = await distillSessions(db, config, {
    sessionId: SESSION_ID,
    fetchImpl,
    quietMinutes: 15,
    reDistillOnChange: true,
  });
  assert.equal(third.sessions, 1, 'changed sessions must re-distill');
  assert.ok(third.skippedDuplicates >= 1, 'duplicate candidates must be skipped');

  db.prepare('UPDATE distill_state SET distilled_at = ? WHERE session_id = ?').run(
    new Date(Date.now() - 60 * 60_000).toISOString(),
    SESSION_ID
  );
  const fourth = await distillSessions(db, config, {
    sessionId: SESSION_ID,
    fetchImpl,
    quietMinutes: 15,
    reDistillOnChange: false,
  });
  assert.equal(fourth.sessions, 0, 're-distillation must be optional');
  db.close();
});

test('auto distill config defaults and overrides', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mem-config-')), 'config.json');
  writeFileSync(path, JSON.stringify({ autoDistill: { enabled: true, quietMinutes: 20 } }));
  const previous = process.env.MEM_CONFIG;
  process.env.MEM_CONFIG = path;
  try {
    const config = loadAutoDistillConfig();
    assert.equal(config.enabled, true);
    assert.equal(config.quietMinutes, 20);
    assert.equal(config.scanMinutes, 5);
    assert.equal(config.maxSessionsPerCycle, 3);
    assert.equal(config.reDistillOnChange, true);
  } finally {
    if (previous === undefined) delete process.env.MEM_CONFIG;
    else process.env.MEM_CONFIG = previous;
  }
});

test('distill handles semantic duplicates and supersedes targets', async () => {
  const dbPath = seedDb();
  const db = openDb(dbPath);
  const oldId = insertUnit(db, {
    type: 'taste',
    statement: '旧偏好：回答要简短',
    status: 'active',
    confidence: 0.8,
  });
  const config: DistillConfig = {
    provider: 'mock',
    baseUrl: 'http://mock.local',
    model: 'mock-model',
    apiKey: 'test-key',
    maxSessionsPerRun: 5,
    maxCharsPerSession: 8000,
    temperature: 0,
  };
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                units: [
                  {
                    type: 'taste',
                    statement: '旧偏好：回答要简短',
                    relation: 'duplicate',
                    target_id: oldId,
                    confidence: 0.8,
                    evidence: [],
                  },
                  {
                    type: 'taste',
                    statement: '新偏好：回答要极简且先给结论',
                    relation: 'supersedes',
                    target_id: oldId,
                    confidence: 0.9,
                    evidence: [{ quote: '先给结论' }],
                  },
                ],
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as typeof fetch;

  const summary = await distillSessions(db, config, { sessionId: SESSION_ID, fetchImpl });
  assert.equal(summary.skippedSemanticDuplicates, 1);
  assert.equal(summary.units, 1);

  const candidate = db
    .prepare(`SELECT id, supersedes_id FROM memory_units WHERE status = 'candidate' LIMIT 1`)
    .get() as { id: number; supersedes_id: number | null };
  assert.equal(candidate.supersedes_id, oldId);

  setUnitStatus(db, candidate.id, 'active');
  const old = db
    .prepare('SELECT status, superseded_by FROM memory_units WHERE id = ?')
    .get(oldId) as { status: string; superseded_by: number | null };
  assert.equal(old.status, 'superseded');
  assert.equal(old.superseded_by, candidate.id);
  db.close();
});

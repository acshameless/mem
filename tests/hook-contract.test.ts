import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CONTRACT_EVENTS,
  validateHookPayload,
  validateHookResult,
  validateStoredContracts,
} from '../src/core/hook_contract.ts';
import { openDb } from '../src/store/db.ts';

const FIXTURE = 'tests/fixtures/contract/hook-events.jsonl';

function fixtures(): Array<{ event: string; payload: Record<string, any> }> {
  return readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; payload: Record<string, any> });
}

test('golden fixtures cover all 9 hook events and pass validation', () => {
  const rows = fixtures();
  assert.deepEqual(
    rows.map((row) => row.event).sort(),
    [...CONTRACT_EVENTS].sort(),
    'fixtures must cover every hook event'
  );
  for (const row of rows) {
    const result = validateHookPayload(row.payload);
    assert.equal(result.ok, true, `${row.event}: ${result.errors.join('; ')}`);
  }
});

test('contract detects a missing required field for every event', () => {
  for (const row of fixtures()) {
    const mutated = structuredClone(row.payload);
    switch (row.event) {
      case 'TaskStart':
      case 'TaskResume': {
        const key = row.event === 'TaskStart' ? 'taskStart' : 'taskResume';
        delete mutated[key].taskMetadata.initialTask;
        break;
      }
      case 'TaskCancel':
      case 'TaskComplete': {
        const key = row.event === 'TaskCancel' ? 'taskCancel' : 'taskComplete';
        delete mutated[key];
        break;
      }
      case 'UserPromptSubmit':
        delete mutated.userPromptSubmit.prompt;
        break;
      case 'PreToolUse':
        delete mutated.preToolUse.toolName;
        break;
      case 'PostToolUse':
        delete mutated.postToolUse.success;
        break;
      case 'PreCompact':
        delete mutated.preCompact.compactionStrategy;
        break;
      case 'Notification':
        delete mutated.notification.message;
        break;
      default:
        break;
    }
    assert.equal(validateHookPayload(mutated).ok, false, `${row.event} must fail`);
  }
});

test('hook result contract rejects shouldContinue and bad types', () => {
  assert.equal(validateHookResult({ cancel: false, contextModification: 'x', errorMessage: '' }).ok, true);
  assert.equal(validateHookResult({ shouldContinue: true }).ok, false);
  assert.equal(validateHookResult({ cancel: 'yes' }).ok, false);
  assert.equal(validateHookResult({ cancel: false, contextModification: 42 }).ok, false);
});

test('stored contract scan reports drift and accepts good events', () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'mem-contract-')), 'memory.db'));
  const insert = db.prepare(
    `INSERT INTO hook_events (dedupe_key, event, task_id, payload_json) VALUES (?, ?, ?, ?)`
  );
  for (const [index, row] of fixtures().entries()) {
    insert.run(`good_${index}`, row.event, row.payload.taskId, JSON.stringify(row.payload));
  }
  const drifted = { ...fixtures()[5].payload, preToolUse: { toolName: 42 } };
  insert.run('bad_1', 'PreToolUse', 'conv_contract', JSON.stringify(drifted));

  const report = validateStoredContracts(db);
  assert.equal(report.checked, 10);
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].event, 'PreToolUse');
  db.close();
});

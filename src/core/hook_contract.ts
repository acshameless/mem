import type { DatabaseSync } from 'node:sqlite';
import { HOOK_EVENTS } from './hooks_doctor.ts';

export interface ContractResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

type Payload = Record<string, any>;

function requireString(errors: string[], value: unknown, name: string): void {
  if (typeof value !== 'string' || value.length === 0) errors.push(`${name} must be a non-empty string`);
}

function requireObject(errors: string[], value: unknown, name: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push(`${name} must be an object`);
}

// Validate one hook input payload against the Cline 4.1.22 contract.
// Fixtures in tests/fixtures/contract/hook-events.jsonl hold the golden shape.
export function validateHookPayload(payload: Payload): ContractResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  requireString(errors, payload.hookName, 'hookName');
  requireString(errors, payload.taskId, 'taskId');
  if (typeof payload.timestamp !== 'string' && typeof payload.timestamp !== 'number') {
    errors.push('timestamp must be a string or number');
  }
  if (!Array.isArray(payload.workspaceRoots)) errors.push('workspaceRoots must be an array');
  if (payload.clineVersion === undefined) warnings.push('clineVersion is missing');
  if (payload.model === undefined) warnings.push('model is missing');

  const event = String(payload.hookName ?? '');
  const metadata = (container: Payload | undefined) => container?.taskMetadata;
  switch (event) {
    case 'TaskStart':
    case 'TaskResume':
    case 'TaskComplete': {
      const container = payload[event.charAt(0).toLowerCase() + event.slice(1)] as Payload | undefined;
      requireObject(errors, container, `${event} payload`);
      requireObject(errors, metadata(container), `${event}.taskMetadata`);
      if (metadata(container)) {
        requireString(errors, metadata(container).taskId, `${event}.taskMetadata.taskId`);
        requireString(errors, metadata(container).ulid, `${event}.taskMetadata.ulid`);
        if (event === 'TaskStart' || event === 'TaskResume') {
          requireString(errors, metadata(container).initialTask, `${event}.taskMetadata.initialTask`);
        }
        if (event === 'TaskComplete') {
          requireString(errors, metadata(container).result, `${event}.taskMetadata.result`);
        }
      }
      break;
    }
    case 'TaskCancel':
      requireObject(errors, payload.taskCancel, 'taskCancel payload');
      break;
    case 'UserPromptSubmit': {
      const container = payload.userPromptSubmit as Payload | undefined;
      requireObject(errors, container, 'userPromptSubmit payload');
      if (container) {
        requireString(errors, container.prompt, 'userPromptSubmit.prompt');
        if (container.attachments !== null && container.attachments !== undefined && !Array.isArray(container.attachments)) {
          errors.push('userPromptSubmit.attachments must be an array or null');
        }
      }
      break;
    }
    case 'PreToolUse': {
      const container = payload.preToolUse as Payload | undefined;
      requireObject(errors, container, 'preToolUse payload');
      if (container) {
        requireString(errors, container.toolName, 'preToolUse.toolName');
        requireObject(errors, container.parameters, 'preToolUse.parameters');
      }
      break;
    }
    case 'PostToolUse': {
      const container = payload.postToolUse as Payload | undefined;
      requireObject(errors, container, 'postToolUse payload');
      if (container) {
        requireString(errors, container.toolName, 'postToolUse.toolName');
        requireObject(errors, container.parameters, 'postToolUse.parameters');
        if (typeof container.result !== 'string') errors.push('postToolUse.result must be a string');
        if (typeof container.success !== 'boolean') errors.push('postToolUse.success must be a boolean');
        if (typeof container.executionTimeMs !== 'number') {
          errors.push('postToolUse.executionTimeMs must be a number');
        }
      }
      break;
    }
    case 'PreCompact': {
      const container = payload.preCompact as Payload | undefined;
      requireObject(errors, container, 'preCompact payload');
      if (container) {
        if (typeof container.contextSize !== 'number') errors.push('preCompact.contextSize must be a number');
        requireString(errors, container.compactionStrategy, 'preCompact.compactionStrategy');
        if (typeof container.tokensIn !== 'number') errors.push('preCompact.tokensIn must be a number');
        if (typeof container.tokensOut !== 'number') errors.push('preCompact.tokensOut must be a number');
      }
      break;
    }
    case 'Notification': {
      const container = payload.notification as Payload | undefined;
      requireObject(errors, container, 'notification payload');
      if (container) {
        requireString(errors, container.event, 'notification.event');
        requireString(errors, container.source, 'notification.source');
        requireString(errors, container.message, 'notification.message');
        if (typeof container.waitingForUserInput !== 'boolean') {
          errors.push('notification.waitingForUserInput must be a boolean');
        }
      }
      break;
    }
    default:
      errors.push(`unknown hook event: ${event || '(empty)'}`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

// Validate the hook output. `shouldContinue` was removed and must fail.
export function validateHookResult(result: Payload): ContractResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if ('shouldContinue' in result) errors.push('shouldContinue was removed; use cancel');
  if (result.cancel !== undefined && typeof result.cancel !== 'boolean') {
    errors.push('cancel must be a boolean');
  }
  if (result.contextModification !== undefined && typeof result.contextModification !== 'string') {
    errors.push('contextModification must be a string');
  }
  if (result.errorMessage !== undefined && typeof result.errorMessage !== 'string') {
    errors.push('errorMessage must be a string');
  }
  if (result.cancel === undefined && result.contextModification === undefined) {
    warnings.push('result has no cancel and no contextModification');
  }
  return { ok: errors.length === 0, errors, warnings };
}

export interface StoredContractReport {
  checked: number;
  violations: Array<{ event: string; task_id: string | null; errors: string[] }>;
}

// Scan stored hook events. This detects schema drift after a Cline update.
export function validateStoredContracts(db: DatabaseSync): StoredContractReport {
  const rows = db
    .prepare('SELECT event, task_id, payload_json FROM hook_events')
    .all() as Array<{ event: string; task_id: string | null; payload_json: string }>;
  const report: StoredContractReport = { checked: 0, violations: [] };
  for (const row of rows) {
    report.checked += 1;
    let payload: Payload;
    try {
      payload = JSON.parse(row.payload_json) as Payload;
    } catch {
      report.violations.push({ event: row.event, task_id: row.task_id, errors: ['invalid JSON'] });
      continue;
    }
    const result = validateHookPayload({ hookName: row.event, ...payload });
    if (!result.ok) {
      report.violations.push({ event: row.event, task_id: row.task_id, errors: result.errors });
    }
  }
  return report;
}

export const CONTRACT_EVENTS = HOOK_EVENTS;

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDb } from '../src/store/db.ts';
import { correlateSessions } from '../src/ingest/correlate.ts';
import { ingestHookFile } from '../src/ingest/hooks.ts';
import { ingestSessionDir } from '../src/ingest/sessions.ts';

const FIXTURES = 'tests/fixtures/phase0';

function seedDb(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'mem-mcp-')), 'memory.db');
  const db = openDb(path);
  ingestHookFile(db, join(FIXTURES, 'hooks/2026-10-06.jsonl'));
  ingestSessionDir(db, join(FIXTURES, 'session'));
  ingestSessionDir(db, join(FIXTURES, 'session-tools'));
  ingestSessionDir(db, join(FIXTURES, 'session-project'));
  correlateSessions(db);
  db.close();
  return path;
}

test('mcp server answers initialize, tools/list, and mem_recall', async () => {
  const dbPath = seedDb();
  const child = spawn(process.execPath, ['src/mcp/server.ts'], {
    env: { ...process.env, MEM_DB: dbPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map<number, (message: any) => void>();
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id === 'number' && pending.has(message.id)) {
      pending.get(message.id)!(message);
      pending.delete(message.id);
    }
  });

  const request = (id: number, method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  try {
    const init = await request(1, 'initialize', { protocolVersion: '2025-06-18' });
    assert.equal(init.result.serverInfo.name, 'mem');

    const list = await request(2, 'tools/list');
    const names = list.result.tools.map((tool: any) => tool.name);
    assert.deepEqual(names, ['mem_recall', 'mem_status']);

    const recall = await request(3, 'tools/call', {
      name: 'mem_recall',
      arguments: { query: 'nonce', limit: 3 },
    });
    const text = recall.result.content[0].text as string;
    assert.match(text, /<memory version="1"/);
    assert.match(text, /179129/);

    const status = await request(4, 'tools/call', { name: 'mem_status', arguments: {} });
    assert.match(status.result.content[0].text as string, /"sessions":3/);
  } finally {
    child.kill('SIGTERM');
  }
});

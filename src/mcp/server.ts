#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { memDbPath } from '../core/paths.ts';
import { searchTurns } from '../core/recall.ts';

// Minimal MCP stdio server. One JSON-RPC message per line.

const serverVersion = '0.1.0';

const tools = [
  {
    name: 'mem_recall',
    description:
      'Search captured Cline conversations (past tasks and sessions). Read-only. ' +
      'Use it before asking the user to repeat project context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search words. Can be Chinese or English.' },
        limit: { type: 'number', description: 'Maximum results. Default 5.' },
        workspace: {
          type: 'string',
          description: 'Optional workspace root filter. Default: current workspace.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'mem_status',
    description: 'Show local memory store statistics. Read-only.',
    inputSchema: { type: 'object', properties: {} },
  },
];

type JsonRpc = {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: Record<string, any>;
  result?: unknown;
  error?: { code: number; message: string };
};

function send(message: JsonRpc): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function withDb<T>(fn: (db: DatabaseSync) => T, fallback: T): T {
  const path = memDbPath();
  if (!existsSync(path)) return fallback;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    return fn(db);
  } catch {
    return fallback;
  } finally {
    db?.close();
  }
}

function recall(args: Record<string, any>): string {
  const query = String(args.query ?? '').trim();
  const limit = Math.max(1, Math.min(20, Number(args.limit ?? 5) || 5));
  if (!query) return '<memory version="1" source="recall" count="0"></memory>';

  const rows = withDb<Array<Record<string, any>>>(
    (db) => searchTurns(db, query, { limit }) as unknown as Array<Record<string, any>>,
    []
  );

  const items = rows
    .map((row) => {
      const date = typeof row.started_at === 'string' ? row.started_at.slice(0, 19) : '';
      return (
        `  <turn session="${row.session_id}" index="${row.turn_index}" ` +
        `role="${row.role}"${row.display_role ? ` display-role="${row.display_role}"` : ''} date="${date}">\n` +
        `    ${String(row.snip ?? '').replace(/\s+/g, ' ').trim()}\n` +
        '  </turn>'
      );
    })
    .join('\n');
  return `<memory version="1" source="recall" count="${rows.length}">\n${items}\n</memory>`;
}

function status(): string {
  const data = withDb(
    (db) => {
      const one = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
      return {
        db: memDbPath(),
        hook_events: one('SELECT count(*) c FROM hook_events'),
        sessions: one('SELECT count(*) c FROM sessions'),
        turns: one('SELECT count(*) c FROM turns'),
        tool_calls: one('SELECT count(*) c FROM tool_calls'),
        correlated_sessions: one(
          'SELECT count(*) c FROM sessions WHERE hook_task_id IS NOT NULL'
        ),
      };
    },
    { db: memDbPath(), hook_events: 0, sessions: 0, turns: 0, tool_calls: 0, correlated_sessions: 0 }
  );
  return `<memory_status>${JSON.stringify(data)}</memory_status>`;
}

function handle(message: JsonRpc): void {
  const { id, method, params } = message;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: id ?? null,
      result: {
        protocolVersion: String(params?.protocolVersion ?? '2025-06-18'),
        capabilities: { tools: {} },
        serverInfo: { name: 'mem', version: serverVersion },
      },
    });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id: id ?? null, result: {} });
    return;
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id: id ?? null, result: { tools } });
    return;
  }
  if (method === 'tools/call') {
    const name = String(params?.name ?? '');
    const args = (params?.arguments ?? {}) as Record<string, any>;
    try {
      if (name === 'mem_recall') {
        send({
          jsonrpc: '2.0',
          id: id ?? null,
          result: { content: [{ type: 'text', text: recall(args) }] },
        });
        return;
      }
      if (name === 'mem_status') {
        send({
          jsonrpc: '2.0',
          id: id ?? null,
          result: { content: [{ type: 'text', text: status() }] },
        });
        return;
      }
      send({
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          content: [{ type: 'text', text: `unknown tool: ${name}` }],
          isError: true,
        },
      });
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          content: [{ type: 'text', text: `mem error: ${String(error)}` }],
          isError: true,
        },
      });
    }
    return;
  }
  if (id !== undefined && id !== null) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message: JsonRpc;
  try {
    message = JSON.parse(trimmed) as JsonRpc;
  } catch {
    return;
  }
  handle(message);
});

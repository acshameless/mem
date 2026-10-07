#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { memDbPath } from '../core/paths.ts';
import { searchTurns } from '../core/recall.ts';
import { openDb } from '../store/db.ts';
import { applyFeedback, insertUnit } from '../core/units.ts';
import { forgetSession, forgetUnit } from '../core/forget.ts';
import { buildProfile } from '../profile/build.ts';

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
  {
    name: 'mem_remember',
    description: 'Store a candidate memory unit. Candidates never auto-activate.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        type: {
          type: 'string',
          enum: ['taste', 'preference', 'decision', 'fact', 'procedure', 'pitfall'],
        },
        detail: { type: 'string' },
        scope: { type: 'string' },
      },
      required: ['content'],
    },
  },
  {
    name: 'mem_feedback',
    description: 'Report whether a memory unit was useful or wrong.',
    inputSchema: {
      type: 'object',
      properties: {
        unit_id: { type: 'number' },
        signal: { type: 'string', enum: ['useful', 'wrong'] },
        note: { type: 'string' },
      },
      required: ['unit_id', 'signal'],
    },
  },
  {
    name: 'mem_taste',
    description: 'Return the current active TASTE profile.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mem_search_raw',
    description: 'Search raw conversation turns with pagination.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } },
      required: ['query'],
    },
  },
  {
    name: 'mem_forget',
    description: 'Delete a session or unit. Requires confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        unit_id: { type: 'number' },
        include_active: { type: 'boolean' },
        confirm: { type: 'boolean' },
      },
      required: ['confirm'],
    },
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

function withWriteDb<T>(fn: (db: ReturnType<typeof openDb>) => T, fallback: T): T {
  try {
    const db = openDb(memDbPath());
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } catch {
    return fallback;
  }
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
      if (name === 'mem_remember') {
        const content = String(args.content ?? '').trim();
        if (content.length < 4) throw new Error('content too short');
        const unitId = withWriteDb(
          (db) =>
            insertUnit(db, {
              type: String(args.type ?? 'fact'),
              statement: content,
              detail: args.detail ? String(args.detail) : null,
              scope: args.scope ? String(args.scope) : 'person',
              status: 'candidate',
              evidence: [{ source: 'mcp', note: 'mem_remember' }],
            }),
          0
        );
        send({
          jsonrpc: '2.0',
          id: id ?? null,
          result: { content: [{ type: 'text', text: `<memory_unit id="${unitId}" status="candidate"/>` }] },
        });
        return;
      }
      if (name === 'mem_feedback') {
        const result = withWriteDb(
          (db) =>
            applyFeedback(
              db,
              Number(args.unit_id),
              args.signal === 'wrong' ? 'wrong' : 'useful',
              args.note ? String(args.note) : undefined
            ),
          null
        );
        send({
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            content: [
              {
                type: 'text',
                text: result
                  ? `<feedback unit="${args.unit_id}" confidence="${result.confidence.toFixed(3)}" status="${result.status}"/>`
                  : '<feedback error="unit not found"/>',
              },
            ],
          },
        });
        return;
      }
      if (name === 'mem_taste') {
        const profile = withDb((db) => buildProfile(db).markdown, '(unavailable)');
        send({
          jsonrpc: '2.0',
          id: id ?? null,
          result: { content: [{ type: 'text', text: profile }] },
        });
        return;
      }
      if (name === 'mem_search_raw') {
        const query = String(args.query ?? '').trim();
        const limit = Math.max(1, Math.min(20, Number(args.limit ?? 5) || 5));
        const offset = Math.max(0, Number(args.offset ?? 0) || 0);
        const rows = withDb(
          (db) => searchTurns(db, query, { limit: Math.min(20, limit + offset) }).slice(offset),
          []
        );
        const text = rows
          .map(
            (row) =>
              `[${row.session_id}#${row.turn_index}] ${row.role}: ${String(row.snip).replace(/\s+/g, ' ').slice(0, 200)}`
          )
          .join('\n');
        send({
          jsonrpc: '2.0',
          id: id ?? null,
          result: { content: [{ type: 'text', text: text || 'no matches' }] },
        });
        return;
      }
      if (name === 'mem_forget') {
        if (args.confirm !== true) {
          send({
            jsonrpc: '2.0',
            id: id ?? null,
            result: {
              content: [{ type: 'text', text: 'refused: pass confirm=true after user approval' }],
              isError: true,
            },
          });
          return;
        }
        const result = withWriteDb((db) => {
          if (args.session_id) return `forgotten session ${args.session_id}: ${JSON.stringify(forgetSession(db, String(args.session_id), { includeActive: args.include_active === true }).counts)}`;
          if (args.unit_id) {
            const statement = forgetUnit(db, Number(args.unit_id));
            return statement ? `forgotten unit ${args.unit_id}` : 'unit not found';
          }
          return 'nothing to forget';
        }, 'forget failed');
        send({
          jsonrpc: '2.0',
          id: id ?? null,
          result: { content: [{ type: 'text', text: result }] },
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

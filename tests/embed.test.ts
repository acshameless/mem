import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { EmbeddingConfig } from '../src/core/config.ts';
import { embedPendingTurns, semanticSearch } from '../src/embed/embed.ts';
import { openDb } from '../src/store/db.ts';

test('embedding pipeline stores vectors and ranks semantically', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-embed-'));
  const db = openDb(join(dir, 'memory.db'));
  db.prepare(
    `INSERT INTO sessions (session_id, source, status) VALUES ('s1', 'generic', 'idle')`
  ).run();
  db.prepare(
    `INSERT INTO turns (session_id, turn_index, block_index, role, kind, text)
     VALUES ('s1', 0, 0, 'user', 'text', '缓存层的容量与过期策略')`
  ).run();
  db.prepare(
    `INSERT INTO turns (session_id, turn_index, block_index, role, kind, text)
     VALUES ('s1', 1, 0, 'user', 'text', '排序算法的稳定性比较')`
  ).run();

  const config: EmbeddingConfig = {
    enabled: true,
    baseUrl: 'http://mock.local',
    model: 'mock-embed',
    apiKey: 'test',
  };
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { input: string[] };
    const data = body.input.map((text) => ({
      embedding: text.includes('缓存') ? [1, 0] : [0, 1],
    }));
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const result = await embedPendingTurns(db, config, { fetchImpl });
  assert.equal(result.embedded, 2);

  const hits = await semanticSearch(db, config, '缓存设计', { fetchImpl, limit: 5 });
  assert.ok(hits.length === 2);
  assert.match(hits[0].text, /缓存/);
  assert.ok(hits[0].score > hits[1].score);
  db.close();
});

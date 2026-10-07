import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { EmbeddingConfig } from '../src/core/config.ts';
import { searchTurns } from '../src/core/recall.ts';
import { rerankWithEmbeddings } from '../src/core/rerank.ts';
import { storeEmbedding } from '../src/embed/embed.ts';
import { openDb } from '../src/store/db.ts';

test('embedding rerank reorders FTS candidates', async () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'mem-rerank-')), 'memory.db'));
  db.prepare(`INSERT INTO sessions (session_id, source, status) VALUES ('s1', 'test', 'idle')`).run();
  db.prepare(
    `INSERT INTO turns (session_id, turn_index, block_index, role, kind, text, text_seg)
     VALUES ('s1', 0, 0, 'user', 'text', '缓存 无关内容 A', '缓 存 无 关 内 容 A')`
  ).run();
  db.prepare(
    `INSERT INTO turns (session_id, turn_index, block_index, role, kind, text, text_seg)
     VALUES ('s1', 1, 0, 'user', 'text', '缓存 相关内容 B', '缓 存 相 关 内 容 B')`
  ).run();
  const rows = searchTurns(db, '缓存', { limit: 5 });
  assert.equal(rows.length, 2);

  const inserted = db.prepare('SELECT id FROM turns ORDER BY id').all() as Array<{ id: number }>;
  storeEmbedding(db, inserted[0].id, 's1', [0, 1], 'mock');
  storeEmbedding(db, inserted[1].id, 's1', [1, 0], 'mock');

  const config: EmbeddingConfig = {
    enabled: true,
    provider: 'openai',
    baseUrl: 'http://mock.local',
    model: 'mock',
    apiKey: 'test',
    dimensions: null,
    taskType: null,
    project: null,
    location: null,
  };
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

  const reranked = await rerankWithEmbeddings(db, rows, '缓存', config, fetchImpl);
  assert.match(reranked[0].snip, /相关内容 B/);
  db.close();
});

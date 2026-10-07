import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadEmbeddingConfig, type EmbeddingConfig } from '../src/core/config.ts';
import { embedPendingTurns, semanticSearch } from '../src/embed/embed.ts';
import { openDb } from '../src/store/db.ts';

test('google embedding provider uses batchEmbedContents and task types', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-google-embed-'));
  const db = openDb(join(dir, 'memory.db'));
  db.prepare(`INSERT INTO sessions (session_id, source, status) VALUES ('g1', 'test', 'idle')`).run();
  db.prepare(
    `INSERT INTO turns (session_id, turn_index, block_index, role, kind, text)
     VALUES ('g1', 0, 0, 'user', 'text', '缓存层设计要点')`
  ).run();
  db.prepare(
    `INSERT INTO turns (session_id, turn_index, block_index, role, kind, text)
     VALUES ('g1', 1, 0, 'user', 'text', '排序算法稳定性')`
  ).run();

  const config: EmbeddingConfig = {
    enabled: true,
    provider: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'gemini-embedding-001',
    apiKey: 'google-test-key',
    dimensions: 1536,
    taskType: null,
    project: null,
    location: 'us-central1',
  };
  const seen: Array<{ url: string; taskType: string; key?: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      requests: Array<{ content: { parts: Array<{ text: string }> }; taskType: string }>;
    };
    const headers = init.headers as Record<string, string>;
    seen.push({
      url,
      taskType: body.requests[0].taskType,
      key: headers['x-goog-api-key'],
    });
    const embeddings = body.requests.map((request) => ({
      values: request.content.parts[0].text.includes('缓存') ? [1, 0] : [0, 1],
    }));
    return new Response(JSON.stringify({ embeddings }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const stored = await embedPendingTurns(db, config, { fetchImpl });
  assert.equal(stored.embedded, 2);
  assert.match(seen[0].url, /batchEmbedContents/);
  assert.equal(seen[0].key, 'google-test-key');
  assert.equal(seen[0].taskType, 'RETRIEVAL_DOCUMENT');

  const hits = await semanticSearch(db, config, '缓存设计', { fetchImpl, limit: 5 });
  assert.ok(hits.length === 2);
  assert.match(hits[0].text, /缓存/);
  assert.equal(seen[seen.length - 1].taskType, 'RETRIEVAL_QUERY');
  db.close();
});

test('embedding config infers the google provider from the base URL', () => {
  const configPath = join(mkdtempSync(join(tmpdir(), 'mem-embed-config-')), 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      embedding: {
        enabled: true,
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'gemini-embedding-001',
        apiKey: 'x',
        dimensions: 768,
      },
    })
  );
  const previous = process.env.MEM_CONFIG;
  process.env.MEM_CONFIG = configPath;
  try {
    const config = loadEmbeddingConfig();
    assert.equal(config.provider, 'google');
    assert.equal(config.dimensions, 768);
    assert.equal(config.model, 'gemini-embedding-001');
  } finally {
    if (previous === undefined) delete process.env.MEM_CONFIG;
    else process.env.MEM_CONFIG = previous;
  }
});

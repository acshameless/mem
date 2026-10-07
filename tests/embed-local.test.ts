import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadEmbeddingConfig, type EmbeddingConfig } from '../src/core/config.ts';
import { embedPendingTurns, semanticSearch } from '../src/embed/embed.ts';
import { openDb } from '../src/store/db.ts';

test('local provider defaults to embeddinggemma-2 without auth headers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-local-embed-'));
  const db = openDb(join(dir, 'memory.db'));
  db.prepare(`INSERT INTO sessions (session_id, source, status) VALUES ('l1', 'test', 'idle')`).run();
  db.prepare(
    `INSERT INTO turns (session_id, turn_index, block_index, role, kind, text)
     VALUES ('l1', 0, 0, 'user', 'text', '本地 embedding 测试内容')`
  ).run();

  const config: EmbeddingConfig = {
    enabled: true,
    provider: 'local',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'embeddinggemma-2',
    apiKey: '',
    dimensions: 768,
    taskType: null,
    project: null,
    location: null,
  };
  const seen: Array<{ url: string; auth?: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    seen.push({ url, auth: headers.Authorization ?? headers.authorization });
    return new Response(JSON.stringify({ data: [{ embedding: new Array(768).fill(0.1) }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const stored = await embedPendingTurns(db, config, { fetchImpl });
  assert.equal(stored.embedded, 1);
  assert.match(seen[0].url, /\/embeddings$/);
  assert.equal(seen[0].auth, undefined, 'local endpoints must not require an API key');

  const hits = await semanticSearch(db, config, '本地测试', { fetchImpl, limit: 3 });
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /embedding 测试/);
  db.close();
});

test('embedding config fills local defaults for embeddinggemma-2', () => {
  const configPath = join(mkdtempSync(join(tmpdir(), 'mem-local-config-')), 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({ embedding: { enabled: true, provider: 'local' } })
  );
  const previous = process.env.MEM_CONFIG;
  process.env.MEM_CONFIG = configPath;
  try {
    const config = loadEmbeddingConfig();
    assert.equal(config.provider, 'local');
    assert.equal(config.baseUrl, 'http://127.0.0.1:11434/v1');
    assert.equal(config.model, 'embeddinggemma-2');
  } finally {
    if (previous === undefined) delete process.env.MEM_CONFIG;
    else process.env.MEM_CONFIG = previous;
  }
});

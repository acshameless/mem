import assert from 'node:assert/strict';
import test from 'node:test';
import type { EmbeddingConfig } from '../src/core/config.ts';
import { bootstrapEmbedding, ollamaInstallHint, type Runner } from '../src/embed/bootstrap.ts';

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

test('bootstrap pulls the model when the server is up', async () => {
  const calls: string[][] = [];
  const runner: Runner = async (command, args) => {
    calls.push([command, ...args]);
    return { code: 0, stdout: '' };
  };
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  const result = await bootstrapEmbedding(config, { fetchImpl, runner });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [['ollama', 'pull', 'embeddinggemma-2']]);
});

test('bootstrap reports install guidance when the server is down', async () => {
  const fetchImpl = (async () => {
    throw new Error('down');
  }) as typeof fetch;
  const result = await bootstrapEmbedding(config, { fetchImpl, waitMs: 0, platform: 'win32' });
  assert.equal(result.ok, false);
  assert.match(String(result.guidance), /Ollama/);
  assert.match(ollamaInstallHint('darwin'), /brew|ollama/);
});

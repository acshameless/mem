import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadDistillConfig } from '../src/core/config.ts';
import { chatComplete } from '../src/distill/provider.ts';

test('distill defaults to the local Ollama endpoint without an API key', async () => {
  const configPath = join(mkdtempSync(join(tmpdir(), 'mem-llm-')), 'config.json');
  writeFileSync(configPath, JSON.stringify({}));
  const previous = process.env.MEM_CONFIG;
  process.env.MEM_CONFIG = configPath;
  try {
    const config = loadDistillConfig();
    assert.equal(config.provider, 'local');
    assert.equal(config.baseUrl, 'http://127.0.0.1:11434/v1');
    assert.equal(config.model, 'qwen3:8b');

    const seen: Array<Record<string, string>> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push((init.headers ?? {}) as Record<string, string>);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"units":[]}' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;
    const result = await chatComplete(
      config,
      [
        { role: 'system', content: 'test' },
        { role: 'user', content: 'test' },
      ],
      fetchImpl
    );
    assert.match(result.text, /units/);
    assert.equal(seen[0].Authorization, undefined, 'local endpoints must not send auth');
  } finally {
    if (previous === undefined) delete process.env.MEM_CONFIG;
    else process.env.MEM_CONFIG = previous;
  }
});

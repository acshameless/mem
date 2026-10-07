import assert from 'node:assert/strict';
import test from 'node:test';
import type { DistillConfig } from '../src/core/config.ts';
import { checkLlm } from '../src/distill/check.ts';

const config: DistillConfig = {
  provider: 'local',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen3:8b',
  apiKey: '',
  maxSessionsPerRun: 5,
  maxCharsPerSession: 8000,
  temperature: 0,
};

test('llm check accepts a JSON answer and rejects a text answer', async () => {
  const good = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          { message: { content: '{"ok":true,"units":[{"type":"taste","statement":"x"}]}' } },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as typeof fetch;
  const goodResult = await checkLlm(config, good);
  assert.equal(goodResult.ok, true);
  assert.ok(goodResult.latencyMs >= 0);

  const bad = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: 'I cannot help with that.' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as typeof fetch;
  const badResult = await checkLlm(config, bad);
  assert.equal(badResult.ok, false);
  assert.match(String(badResult.error), /JSON/);
});

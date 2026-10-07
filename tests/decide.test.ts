import assert from 'node:assert/strict';
import test from 'node:test';
import type { DecisionConfig } from '../src/core/config.ts';
import { decide } from '../src/decide/provider.ts';

test('jev decision provider returns a typed label with a probability', async () => {
  const config: DecisionConfig = {
    provider: 'jev',
    baseUrl: 'https://api.typesafe.example/v1',
    model: 'jev',
    apiKey: 'test',
  };
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ label: 'duplicate', probability: 0.93 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const result = await decide(
    config,
    { question: 'is this statement new?', labels: ['new', 'duplicate'] },
    fetchImpl
  );
  assert.equal(result.label, 'duplicate');
  assert.equal(result.probability, 0.93);
  assert.deepEqual(body.labels, ['new', 'duplicate']);
});

test('heuristic decision provider is the default', async () => {
  const result = await decide(
    { provider: 'heuristic', baseUrl: '', model: 'x', apiKey: '' },
    { question: 'q', labels: ['a'] }
  );
  assert.equal(result.label, 'a');
  assert.equal(result.probability, 0.5);
});

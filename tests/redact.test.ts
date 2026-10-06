import assert from 'node:assert/strict';
import test from 'node:test';
import { redactSecrets } from '../src/core/redact.ts';

test('redactSecrets removes common secret shapes', () => {
  const output = redactSecrets(
    'key sk-abcdefghijklmnop1234567890 and password=supersecret12345 and Bearer abc.def.ghi'
  );
  assert.doesNotMatch(output, /sk-abcdefghijklmnop/);
  assert.doesNotMatch(output, /supersecret12345/);
  assert.doesNotMatch(output, /Bearer abc\.def/);
  assert.match(output, /\[REDACTED\]/);
});

#!/usr/bin/env node
// Generic capture hook for events without extra semantics.
// Usage: node src/hooks/capture.ts <EventName>
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hookRawDir } from '../core/paths.ts';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const eventName = process.argv[2] ?? 'Unknown';
const input = await readStdin();

try {
  const payload = JSON.parse(input || '{}') as unknown;
  const dir = hookRawDir();
  mkdirSync(dir, { recursive: true });
  const now = new Date();
  appendFileSync(
    join(dir, `${now.toISOString().slice(0, 10)}.jsonl`),
    `${JSON.stringify({ event: eventName, received_at: now.toISOString(), payload })}\n`
  );
} catch {
  // Capture must never block the host.
}

process.stdout.write(
  `${JSON.stringify({ cancel: false, contextModification: '', errorMessage: '' })}\n`
);

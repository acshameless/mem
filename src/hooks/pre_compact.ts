#!/usr/bin/env node
import { appendFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { memHome } from '../core/paths.ts';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function writeResult(): void {
  process.stdout.write(
    `${JSON.stringify({ cancel: false, contextModification: '', errorMessage: '' })}\n`
  );
}

const input = await readStdin();

try {
  const payload = JSON.parse(input || '{}') as Record<string, any>;
  const home = memHome();
  const rawDir = join(home, 'raw', 'hooks');
  mkdirSync(rawDir, { recursive: true });
  const now = new Date();
  appendFileSync(
    join(rawDir, `${now.toISOString().slice(0, 10)}.jsonl`),
    `${JSON.stringify({ event: 'PreCompact', received_at: now.toISOString(), payload })}\n`
  );

  const sessionId = String(payload.taskId ?? 'unknown');
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const archiveDir = join(home, 'archive', sessionId, stamp);
  mkdirSync(archiveDir, { recursive: true });

  const preCompact = (payload.preCompact ?? {}) as Record<string, any>;
  const sources = [preCompact.contextJsonPath, preCompact.contextRawPath].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  );
  const copied: string[] = [];
  for (const source of sources) {
    try {
      if (!existsSync(source)) continue;
      const dest = join(archiveDir, basename(source));
      copyFileSync(source, dest);
      copied.push(dest);
    } catch {
      // Skip files that cannot be copied.
    }
  }

  mkdirSync(join(home, 'archive'), { recursive: true });
  appendFileSync(
    join(home, 'archive', 'index.jsonl'),
    `${JSON.stringify({
      ts: now.toISOString(),
      session_id: sessionId,
      dir: archiveDir,
      files: copied,
      context_size: preCompact.contextSize ?? null,
      strategy: preCompact.compactionStrategy ?? null,
      tokens_in: preCompact.tokensIn ?? null,
      tokens_out: preCompact.tokensOut ?? null,
    })}\n`
  );
} catch {
  // Archiving must never block compaction.
}

writeResult();

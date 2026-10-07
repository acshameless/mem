import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { memHome } from './paths.ts';

export function blobsDir(): string {
  return join(memHome(), 'blobs');
}

export function storeBlob(
  db: DatabaseSync,
  text: string
): { hash: string; path: string; size: number } {
  const hash = createHash('sha256').update(text).digest('hex');
  const dir = blobsDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${hash}.txt`);
  if (!existsSync(path)) writeFileSync(path, text, { mode: 0o600 });
  db.prepare(
    `INSERT OR IGNORE INTO blobs (hash, size, path, created_at) VALUES (?, ?, ?, ?)`
  ).run(hash, Buffer.byteLength(text), path, new Date().toISOString());
  return { hash, path, size: Buffer.byteLength(text) };
}

export function readBlob(hash: string): string | null {
  const path = join(blobsDir(), `${hash}.txt`);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

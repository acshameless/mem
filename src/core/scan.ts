import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { containsSecret, redactSecrets } from './redact.ts';

export interface ScanResult {
  filesScanned: number;
  filesWithSecrets: string[];
  rawMatches: number;
  turnMatches: number;
}

function jsonlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => join(dir, name));
}

export function scanStore(db: DatabaseSync, home: string): ScanResult {
  const result: ScanResult = { filesScanned: 0, filesWithSecrets: [], rawMatches: 0, turnMatches: 0 };
  for (const dir of [join(home, 'raw', 'hooks'), join(home, 'raw', 'injections')]) {
    for (const file of jsonlFiles(dir)) {
      result.filesScanned += 1;
      let fileMatches = 0;
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line.trim() && containsSecret(line)) fileMatches += 1;
      }
      if (fileMatches > 0) {
        result.filesWithSecrets.push(file);
        result.rawMatches += fileMatches;
      }
    }
  }
  const rows = db
    .prepare('SELECT text FROM turns WHERE text IS NOT NULL')
    .all() as Array<{ text: string }>;
  for (const row of rows) {
    if (containsSecret(row.text)) result.turnMatches += 1;
  }
  return result;
}

export function redactRawStore(home: string): { files: number; lines: number } {
  let files = 0;
  let lines = 0;
  for (const dir of [join(home, 'raw', 'hooks'), join(home, 'raw', 'injections')]) {
    for (const file of jsonlFiles(dir)) {
      const original = readFileSync(file, 'utf8');
      const rewritten = original
        .split('\n')
        .map((line) => {
          if (!line.trim() || !containsSecret(line)) return line;
          lines += 1;
          return redactSecrets(line);
        })
        .join('\n');
      if (rewritten !== original) {
        const tmp = `${file}.tmp.${process.pid}`;
        writeFileSync(tmp, rewritten);
        renameSync(tmp, file);
        files += 1;
      }
    }
  }
  return { files, lines };
}

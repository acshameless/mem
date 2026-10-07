import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { memHome } from './paths.ts';
import { findSimilarUnit, insertUnit, statementHash } from './units.ts';
import { profilesDir } from '../profile/build.ts';
import { segmentForSearch } from './tokenize.ts';

function packageVersion(): string {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function writeJsonl(path: string, rows: unknown[]): string {
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), {
    mode: 0o600,
  });
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export interface ExportResult {
  dir: string;
  units: number;
  cards: number;
  skills: number;
  profiles: number;
  hash: string;
}

export function exportStore(
  db: DatabaseSync,
  outDir: string,
  options: { includeRaw?: boolean } = {}
): ExportResult {
  mkdirSync(outDir, { recursive: true });
  const units = db.prepare('SELECT * FROM memory_units').all() as unknown[];
  const cards = db.prepare('SELECT * FROM session_cards').all() as unknown[];
  const skills = db.prepare('SELECT * FROM skills').all() as unknown[];
  const unitsHash = writeJsonl(join(outDir, 'units.jsonl'), units);
  const cardsHash = writeJsonl(join(outDir, 'cards.jsonl'), cards);
  writeJsonl(join(outDir, 'skills.jsonl'), skills);

  let profiles = 0;
  const sourceProfiles = profilesDir();
  if (existsSync(sourceProfiles)) {
    const target = join(outDir, 'profiles');
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(sourceProfiles)) {
      if (!name.endsWith('.md')) continue;
      copyFileSync(join(sourceProfiles, name), join(target, name));
      profiles += 1;
    }
  }

  if (options.includeRaw) {
    for (const sub of ['hooks', 'injections']) {
      const source = join(memHome(), 'raw', sub);
      if (!existsSync(source)) continue;
      const target = join(outDir, 'raw', sub);
      mkdirSync(target, { recursive: true });
      for (const name of readdirSync(source)) {
        copyFileSync(join(source, name), join(target, name));
      }
    }
  }

  const manifest = {
    format: 'mem-export',
    version: packageVersion(),
    created_at: new Date().toISOString(),
    counts: { units: units.length, cards: cards.length, skills: skills.length, profiles },
    include_raw: options.includeRaw === true,
    hash: createHash('sha256').update(unitsHash + cardsHash).digest('hex'),
    note: 'config.json and API keys are never exported',
  };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return { dir: outDir, units: units.length, cards: cards.length, skills: skills.length, profiles, hash: manifest.hash };
}

function readJsonl(path: string): Array<Record<string, any>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, any>;
      } catch {
        return null;
      }
    })
    .filter((row): row is Record<string, any> => row !== null);
}

export interface ImportResult {
  dir: string;
  units: number;
  skipped: number;
  cards: number;
  skills: number;
  profiles: number;
}

export function importStore(db: DatabaseSync, dir: string): ImportResult {
  if (!existsSync(join(dir, 'manifest.json'))) {
    throw new Error(`not a mem export: ${dir}`);
  }
  let units = 0;
  let skipped = 0;
  for (const row of readJsonl(join(dir, 'units.jsonl'))) {
    const statement = String(row.statement ?? '').trim();
    if (statement.length < 4) continue;
    if (findSimilarUnit(db, statement) !== null) {
      skipped += 1;
      continue;
    }
    insertUnit(db, {
      type: String(row.type ?? 'fact'),
      statement,
      detail: row.detail ?? null,
      scope: String(row.scope ?? 'person'),
      confidence: Number(row.confidence ?? 0.5),
      status: String(row.status ?? 'candidate'),
      evidence: row.evidence_json ? JSON.parse(row.evidence_json) : [],
      sourceSession: row.source_session ?? null,
      supersedesId: row.supersedes_id ?? null,
    });
    units += 1;
  }

  let cards = 0;
  const upsertCard = db.prepare(
    `INSERT INTO session_cards
       (session_id, goal, goal_seg, outcome, outcome_seg, tools_json, files_json, errors_json, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       goal=excluded.goal, outcome=excluded.outcome, tools_json=excluded.tools_json,
       files_json=excluded.files_json, errors_json=excluded.errors_json,
       generated_at=excluded.generated_at`
  );
  for (const row of readJsonl(join(dir, 'cards.jsonl'))) {
    upsertCard.run(
      row.session_id,
      row.goal ?? null,
      row.goal ? segmentForSearch(String(row.goal)) : null,
      row.outcome ?? null,
      row.outcome ? segmentForSearch(String(row.outcome)) : null,
      row.tools_json ?? '[]',
      row.files_json ?? '[]',
      row.errors_json ?? '[]',
      row.generated_at ?? new Date().toISOString()
    );
    cards += 1;
  }

  let skills = 0;
  const upsertSkill = db.prepare(
    `INSERT INTO skills (name, slug, description, body, status, evidence_json, source_units_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET description=excluded.description, body=excluded.body,
       status=excluded.status, updated_at=excluded.updated_at`
  );
  for (const row of readJsonl(join(dir, 'skills.jsonl'))) {
    upsertSkill.run(
      row.name,
      row.slug ?? row.name,
      row.description ?? '',
      row.body ?? '',
      row.status ?? 'draft',
      row.evidence_json ?? null,
      row.source_units_json ?? null,
      row.created_at ?? new Date().toISOString(),
      new Date().toISOString()
    );
    skills += 1;
  }

  let profiles = 0;
  const importedProfiles = join(dir, 'profiles');
  if (existsSync(importedProfiles)) {
    const target = join(profilesDir(), 'imported');
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(importedProfiles)) {
      if (!name.endsWith('.md')) continue;
      copyFileSync(join(importedProfiles, name), join(target, `${Date.now()}-${name}`));
      profiles += 1;
    }
  }

  return { dir, units, skipped, cards, skills, profiles };
}

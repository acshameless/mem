import type { DatabaseSync } from 'node:sqlite';
import type { EmbeddingConfig } from '../core/config.ts';

export type FetchLike = typeof fetch;
export type EmbedPurpose = 'document' | 'query';

async function embedOpenAi(
  config: EmbeddingConfig,
  texts: string[],
  fetchImpl: FetchLike
): Promise<number[][]> {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/embeddings`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      input: texts,
      ...(config.dimensions ? { dimensions: config.dimensions } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`embedding ${response.status}: ${detail.slice(0, 200)}`);
  }
  const json = (await response.json()) as { data?: Array<{ embedding: number[] }> };
  return (json.data ?? []).map((row) => row.embedding);
}

async function embedGoogle(
  config: EmbeddingConfig,
  texts: string[],
  fetchImpl: FetchLike,
  purpose: EmbedPurpose
): Promise<number[][]> {
  const base = config.baseUrl.replace(/\/+$/, '');
  const url = `${base}/v1beta/models/${encodeURIComponent(config.model)}:batchEmbedContents`;
  const taskType = config.taskType ?? (purpose === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT');
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { 'x-goog-api-key': config.apiKey } : {}),
    },
    body: JSON.stringify({
      requests: texts.map((text) => ({
        model: `models/${config.model}`,
        content: { parts: [{ text }] },
        taskType,
        ...(config.dimensions ? { outputDimensionality: config.dimensions } : {}),
      })),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`google embedding ${response.status}: ${detail.slice(0, 200)}`);
  }
  const json = (await response.json()) as { embeddings?: Array<{ values: number[] }> };
  return (json.embeddings ?? []).map((row) => row.values);
}

async function embedVertex(
  config: EmbeddingConfig,
  texts: string[],
  fetchImpl: FetchLike,
  purpose: EmbedPurpose
): Promise<number[][]> {
  if (!config.project) throw new Error('vertex embedding requires embedding.project');
  const base = config.baseUrl.replace(/\/+$/, '');
  const url =
    `${base}/v1/projects/${config.project}/locations/${config.location}` +
    `/publishers/google/models/${encodeURIComponent(config.model)}:predict`;
  const taskType = config.taskType ?? (purpose === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT');
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      instances: texts.map((text) => ({ content: text, task_type: taskType })),
      parameters: {
        ...(config.dimensions ? { outputDimensionality: config.dimensions } : {}),
      },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`vertex embedding ${response.status}: ${detail.slice(0, 200)}`);
  }
  const json = (await response.json()) as {
    predictions?: Array<{ embeddings?: { values: number[] } }>;
  };
  return (json.predictions ?? []).map((row) => row.embeddings?.values ?? []);
}

export async function embedTexts(
  config: EmbeddingConfig,
  texts: string[],
  fetchImpl: FetchLike = fetch,
  purpose: EmbedPurpose = 'document'
): Promise<number[][]> {
  if (config.provider === 'local') return embedOpenAi(config, texts, fetchImpl);
  if (config.provider === 'google') return embedGoogle(config, texts, fetchImpl, purpose);
  if (config.provider === 'vertex') return embedVertex(config, texts, fetchImpl, purpose);
  return embedOpenAi(config, texts, fetchImpl);
}

export function storeEmbedding(
  db: DatabaseSync,
  turnId: number,
  sessionId: string | null,
  vector: number[],
  model: string
): void {
  const f32 = new Float32Array(vector);
  db.prepare(
    `INSERT INTO embeddings (turn_id, session_id, vector, dims, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(turn_id) DO UPDATE SET
       vector=excluded.vector, dims=excluded.dims, model=excluded.model, created_at=excluded.created_at`
  ).run(turnId, sessionId, Buffer.from(f32.buffer), f32.length, model, new Date().toISOString());
}

export async function embedPendingTurns(
  db: DatabaseSync,
  config: EmbeddingConfig,
  options: { limit?: number; fetchImpl?: FetchLike } = {}
): Promise<{ candidates: number; embedded: number }> {
  const rows = db
    .prepare(
      `SELECT t.id, t.session_id, t.text FROM turns t
       LEFT JOIN embeddings e ON e.turn_id = t.id
       WHERE e.turn_id IS NULL AND t.text IS NOT NULL AND length(t.text) >= 6
       ORDER BY t.id LIMIT ?`
    )
    .all(Math.max(1, options.limit ?? 200)) as Array<{
    id: number;
    session_id: string;
    text: string;
  }>;
  let embedded = 0;
  for (let index = 0; index < rows.length; index += 16) {
    const batch = rows.slice(index, index + 16);
    const vectors = await embedTexts(
      config,
      batch.map((row) => row.text.slice(0, 2000)),
      options.fetchImpl,
      'document'
    );
    batch.forEach((row, batchIndex) => {
      const vector = vectors[batchIndex];
      if (vector && vector.length > 0) {
        storeEmbedding(db, row.id, row.session_id, vector, config.model);
        embedded += 1;
      }
    });
  }
  return { candidates: rows.length, embedded };
}

function cosine(a: number[], b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

export interface SemanticHit {
  turn_id: number;
  session_id: string | null;
  text: string;
  role: string | null;
  started_at: string | null;
  score: number;
}

export async function semanticSearch(
  db: DatabaseSync,
  config: EmbeddingConfig,
  query: string,
  options: { limit?: number; fetchImpl?: FetchLike } = {}
): Promise<SemanticHit[]> {
  const [queryVector] = await embedTexts(config, [query], options.fetchImpl, 'query');
  if (!queryVector) return [];
  const rows = db
    .prepare(
      `SELECT e.turn_id, e.session_id, e.vector, t.text, t.role, s.started_at
       FROM embeddings e
       JOIN turns t ON t.id = e.turn_id
       LEFT JOIN sessions s ON s.session_id = e.session_id`
    )
    .all() as Array<Record<string, any>>;
  const hits: SemanticHit[] = [];
  for (const row of rows) {
    const vector = new Float32Array(new Uint8Array(row.vector as Uint8Array).buffer);
    hits.push({
      turn_id: row.turn_id,
      session_id: row.session_id,
      text: row.text,
      role: row.role,
      started_at: row.started_at,
      score: cosine(queryVector, vector),
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, options.limit ?? 10);
}

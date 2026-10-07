import type { DatabaseSync } from 'node:sqlite';
import type { EmbeddingConfig } from './config.ts';
import type { RecallRow } from './recall.ts';
import { embedTexts, type FetchLike } from '../embed/embed.ts';

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

export async function rerankWithEmbeddings(
  db: DatabaseSync,
  rows: RecallRow[],
  query: string,
  config: EmbeddingConfig,
  fetchImpl?: FetchLike
): Promise<RecallRow[]> {
  if (rows.length < 2 || !config.enabled || !config.baseUrl || !config.model) return rows;
  try {
    const [queryVector] = await embedTexts(config, [query], fetchImpl ?? fetch);
    if (!queryVector) return rows;
    const getVector = db.prepare('SELECT vector FROM embeddings WHERE turn_id = ?');
    const scored: Array<{ row: RecallRow; score: number }> = [];
    rows.forEach((row, index) => {
      const stored = getVector.get(row.id) as { vector: Uint8Array } | undefined;
      const base = rows.length - index;
      if (!stored) {
        scored.push({ row, score: base });
        return;
      }
      const vector = new Float32Array(new Uint8Array(stored.vector).buffer);
      scored.push({ row, score: base + cosine(queryVector, vector) * 2 });
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.map((item) => item.row);
  } catch {
    return rows;
  }
}

import type { DecisionConfig } from '../core/config.ts';
import type { FetchLike } from '../distill/provider.ts';

export interface Decision {
  label: string;
  probability: number;
}

export interface DecisionInput {
  question: string;
  labels: string[];
  context?: string;
}

// JEV is a non-generative model. It returns typed decisions with calibrated
// probabilities. The exact TypeSafe HTTP schema is not known yet, so the
// request shape lives in one place and can be adjusted without touching
// callers.
export async function decide(
  config: DecisionConfig,
  input: DecisionInput,
  fetchImpl: FetchLike = fetch
): Promise<Decision> {
  if (config.provider !== 'jev' || !config.baseUrl) {
    return { label: input.labels[0] ?? 'unknown', probability: 0.5 };
  }
  const response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}/decide`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      input: input.question,
      labels: input.labels,
      context: input.context,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`jev ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const json = (await response.json()) as { label?: string; probability?: number };
  return {
    label: String(json.label ?? input.labels[0] ?? 'unknown'),
    probability: Number.isFinite(Number(json.probability))
      ? Math.max(0, Math.min(1, Number(json.probability)))
      : 0.5,
  };
}

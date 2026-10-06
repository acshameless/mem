import type { DistillConfig } from '../core/config.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  text: string;
  usage: Record<string, unknown> | null;
}

export type FetchLike = typeof fetch;

export async function chatComplete(
  config: DistillConfig,
  messages: ChatMessage[],
  fetchImpl: FetchLike = fetch
): Promise<ChatResult> {
  if (!config.apiKey) throw new Error('missing API key in config.json');
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: config.temperature,
    response_format: { type: 'json_object' },
  };
  const call = () =>
    fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });

  let response = await call();
  if (response.status === 400) {
    delete body.response_format;
    response = await call();
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`provider ${response.status}: ${detail.slice(0, 300)}`);
  }
  const json = (await response.json()) as Record<string, any>;
  return {
    text: String(json?.choices?.[0]?.message?.content ?? ''),
    usage: (json?.usage as Record<string, unknown> | undefined) ?? null,
  };
}

import type { DistillConfig } from '../core/config.ts';
import { chatComplete, type FetchLike } from './provider.ts';

export interface LlmCheckResult {
  ok: boolean;
  latencyMs: number;
  model: string;
  sample: string;
  error?: string;
}

// Send a small strict-JSON task. mem needs reliable JSON output.
export async function checkLlm(
  config: DistillConfig,
  fetchImpl?: FetchLike
): Promise<LlmCheckResult> {
  const started = performance.now();
  try {
    const result = await chatComplete(
      config,
      [
        {
          role: 'system',
          content:
            'Only output JSON. Format: {"ok":true,"units":[{"type":"taste","statement":"..."}]}',
        },
        { role: 'user', content: 'Example user preference: "answer in short form". Extract one unit.' },
      ],
      fetchImpl ?? fetch
    );
    const start = result.text.indexOf('{');
    const end = result.text.lastIndexOf('}');
    if (start < 0 || end <= start) {
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - started),
        model: config.model,
        sample: result.text.slice(0, 200),
        error: 'no JSON object in the answer',
      };
    }
    const parsed = JSON.parse(result.text.slice(start, end + 1)) as { units?: unknown[] };
    return {
      ok: Array.isArray(parsed.units),
      latencyMs: Math.round(performance.now() - started),
      model: config.model,
      sample: result.text.slice(0, 200),
      error: Array.isArray(parsed.units) ? undefined : 'missing units array',
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      model: config.model,
      sample: '',
      error: String(error).slice(0, 200),
    };
  }
}

import type { EmbeddingConfig } from '../core/config.ts';
import type { FetchLike } from './embed.ts';

export interface Runner {
  (
    command: string,
    args: string[],
    options?: { detach?: boolean }
  ): Promise<{ code: number; stdout: string }>;
}

export interface BootstrapResult {
  ok: boolean;
  steps: string[];
  guidance?: string;
}

export function ollamaInstallHint(platform = process.platform): string {
  if (platform === 'win32') return 'winget install Ollama.Ollama  (or https://ollama.com/download)';
  if (platform === 'darwin') return 'brew install ollama  (or https://ollama.com/download)';
  return 'curl -fsSL https://ollama.com/install.sh | sh';
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Make EmbeddingGemma 2 ready on all platforms:
// 1. find the local Ollama server
// 2. start it when possible
// 3. pull the model when it is missing
export async function bootstrapEmbedding(
  config: EmbeddingConfig,
  options: {
    fetchImpl?: FetchLike;
    runner?: Runner;
    platform?: string;
    waitMs?: number;
  } = {}
): Promise<BootstrapResult> {
  const steps: string[] = [];
  const fetchImpl = options.fetchImpl ?? fetch;
  const platform = options.platform ?? process.platform;
  const apiBase = config.baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  const tagsUrl = `${apiBase}/api/tags`;

  const serverUp = async (): Promise<boolean> => {
    try {
      return (await fetchImpl(tagsUrl)).ok;
    } catch {
      return false;
    }
  };

  let up = await serverUp();
  if (!up && options.runner) {
    try {
      await options.runner('ollama', ['serve'], { detach: true });
      steps.push('started: ollama serve');
    } catch {
      // The binary may be missing. The guidance below covers that case.
    }
    const deadline = Date.now() + (options.waitMs ?? 5000);
    while (!up && Date.now() < deadline) {
      await sleep(500);
      up = await serverUp();
    }
  }
  if (!up) {
    return { ok: false, steps, guidance: `Ollama is not reachable. Install it: ${ollamaInstallHint(platform)}` };
  }
  steps.push(`server ok: ${apiBase}`);

  let models: string[] = [];
  try {
    const data = (await (await fetchImpl(tagsUrl)).json()) as {
      models?: Array<{ name?: string }>;
    };
    models = (data.models ?? []).map((row) => String(row.name ?? ''));
  } catch {
    models = [];
  }
  const present = models.some(
    (name) => name === config.model || name.startsWith(`${config.model}:`)
  );
  if (present) {
    steps.push(`model present: ${config.model}`);
    return { ok: true, steps };
  }
  if (!options.runner) {
    return { ok: false, steps, guidance: `Run: ollama pull ${config.model}` };
  }
  try {
    await options.runner('ollama', ['pull', config.model]);
    steps.push(`pulled: ${config.model}`);
    return { ok: true, steps };
  } catch {
    return { ok: false, steps, guidance: `Run manually: ollama pull ${config.model}` };
  }
}

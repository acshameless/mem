import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { memHome } from './paths.ts';

export interface DistillConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  maxSessionsPerRun: number;
  maxCharsPerSession: number;
  temperature: number;
}

export interface MemConfig {
  distill?: Partial<DistillConfig>;
  autoDistill?: Partial<AutoDistillConfig>;
  sources?: { genericJsonl?: { dir?: string } };
  embedding?: Partial<EmbeddingConfig>;
  injection?: Partial<InjectionConfig>;
}

export interface InjectionConfig {
  budgetChars: number;
  useEmbeddings: boolean;
}

export interface EmbeddingConfig {
  enabled: boolean;
  provider: 'local' | 'openai' | 'google' | 'vertex' | 'custom';
  baseUrl: string;
  model: string;
  apiKey: string;
  dimensions: number | null;
  taskType: string | null;
  project: string | null;
  location: string | null;
}

export interface AutoDistillConfig {
  enabled: boolean;
  quietMinutes: number;
  scanMinutes: number;
  maxSessionsPerCycle: number;
  reDistillOnChange: boolean;
}

export function configPath(): string {
  return process.env.MEM_CONFIG ?? join(memHome(), 'config.json');
}

export function loadConfig(): MemConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as MemConfig;
  } catch {
    return {};
  }
}

export function loadDistillConfig(): DistillConfig {
  const config = loadConfig();
  const distill = config.distill ?? {};
  return {
    provider: distill.provider ?? 'deepseek',
    baseUrl: distill.baseUrl ?? 'https://api.deepseek.com',
    model: distill.model ?? 'deepseek-chat',
    apiKey: distill.apiKey ?? '',
    maxSessionsPerRun: Math.max(1, Number(distill.maxSessionsPerRun ?? 20) || 20),
    maxCharsPerSession: Math.max(1000, Number(distill.maxCharsPerSession ?? 8000) || 8000),
    temperature: Number.isFinite(Number(distill.temperature)) ? Number(distill.temperature) : 0.2,
  };
}

export function loadAutoDistillConfig(): AutoDistillConfig {
  const config = loadConfig();
  const auto = config.autoDistill ?? {};
  return {
    enabled: auto.enabled === true,
    quietMinutes: Math.max(1, Number(auto.quietMinutes ?? 15) || 15),
    scanMinutes: Math.max(1, Number(auto.scanMinutes ?? 5) || 5),
    maxSessionsPerCycle: Math.max(1, Number(auto.maxSessionsPerCycle ?? 3) || 3),
    reDistillOnChange: auto.reDistillOnChange !== false,
  };
}

export function saveConfig(config: MemConfig): void {
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function loadGenericDir(): string | null {
  const fromEnv = process.env.MEM_GENERIC_DIR?.trim();
  if (fromEnv) return fromEnv;
  const dir = loadConfig().sources?.genericJsonl?.dir;
  return typeof dir === 'string' && dir.length > 0 ? dir : null;
}

export function loadEmbeddingConfig(): EmbeddingConfig {
  const embedding = loadConfig().embedding ?? {};
  const baseUrl = typeof embedding.baseUrl === 'string' ? embedding.baseUrl : '';
  const inferred: EmbeddingConfig['provider'] = baseUrl.includes('googleapis.com')
    ? 'google'
    : /127\.0\.0\.1|localhost/.test(baseUrl)
      ? 'local'
      : 'openai';
  const provider =
    embedding.provider === 'google' ||
    embedding.provider === 'vertex' ||
    embedding.provider === 'local' ||
    embedding.provider === 'custom' ||
    embedding.provider === 'openai'
      ? embedding.provider
      : inferred;
  const dimensions = Number(embedding.dimensions);
  return {
    enabled: embedding.enabled === true,
    provider,
    baseUrl:
      baseUrl || (provider === 'local' ? 'http://127.0.0.1:11434/v1' : ''),
    model:
      typeof embedding.model === 'string' && embedding.model
        ? embedding.model
        : provider === 'local'
          ? 'embeddinggemma-2'
          : '',
    apiKey: typeof embedding.apiKey === 'string' ? embedding.apiKey : '',
    dimensions: Number.isFinite(dimensions) && dimensions > 0 ? dimensions : null,
    taskType: typeof embedding.taskType === 'string' && embedding.taskType ? embedding.taskType : null,
    project: typeof embedding.project === 'string' && embedding.project ? embedding.project : null,
    location:
      typeof embedding.location === 'string' && embedding.location ? embedding.location : 'us-central1',
  };
}

export function loadInjectionConfig(): InjectionConfig {
  const injection = loadConfig().injection ?? {};
  const envBudget = Number(process.env.MEM_BLOCK_CHARS);
  return {
    budgetChars: Math.max(
      500,
      Math.min(
        6000,
        Number.isFinite(envBudget) && envBudget > 0
          ? envBudget
          : Number(injection.budgetChars ?? 3000)
      )
    ),
    useEmbeddings: injection.useEmbeddings === true,
  };
}

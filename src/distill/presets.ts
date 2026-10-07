import type { DistillConfig } from '../core/config.ts';

export const LLM_PRESETS: Record<string, Partial<DistillConfig>> = {
  local: {
    provider: 'local',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen3:8b',
    apiKey: '',
    maxSessionsPerRun: 20,
    maxCharsPerSession: 8000,
    temperature: 0.2,
  },
  deepseek: {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    maxSessionsPerRun: 20,
    maxCharsPerSession: 8000,
    temperature: 0.2,
  },
  openai: {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    maxSessionsPerRun: 20,
    maxCharsPerSession: 8000,
    temperature: 0.2,
  },
};

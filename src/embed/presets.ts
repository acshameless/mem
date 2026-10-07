import type { EmbeddingConfig } from '../core/config.ts';

export const EMBEDDING_PRESETS: Record<string, Partial<EmbeddingConfig>> = {
  local: {
    enabled: true,
    provider: 'local',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'embeddinggemma-2',
    dimensions: 768,
    taskType: null,
  },
  lmstudio: {
    enabled: true,
    provider: 'local',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'embeddinggemma-2',
    dimensions: 768,
    taskType: null,
  },
  google: {
    enabled: true,
    provider: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'gemini-embedding-001',
    dimensions: 1536,
    taskType: null,
  },
  vertex: {
    enabled: true,
    provider: 'vertex',
    baseUrl: 'https://us-central1-aiplatform.googleapis.com',
    model: 'gemini-embedding-001',
    dimensions: 1536,
    taskType: null,
    location: 'us-central1',
  },
  openai: {
    enabled: true,
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'text-embedding-3-small',
    dimensions: 1536,
    taskType: null,
  },
};

import { homedir } from 'node:os';
import { join } from 'node:path';

export function memHome(): string {
  return process.env.MEM_HOME ?? join(homedir(), '.llm-memory');
}

export function memDbPath(): string {
  return process.env.MEM_DB ?? join(memHome(), 'db', 'memory.db');
}

export function clineDataDir(): string {
  return process.env.CLINE_DATA_DIR ?? join(homedir(), '.cline', 'data');
}

export function hookRawDir(): string {
  return process.env.MEM_HOOK_RAW ?? join(memHome(), 'raw', 'hooks');
}

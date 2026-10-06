import { join } from 'node:path';
import { clineDataDir } from '../core/paths.ts';
import { loadGenericDir } from '../core/config.ts';

export interface SourceAdapter {
  id: string;
  name: string;
  sessionsRoot: string;
}

export function listAdapters(): SourceAdapter[] {
  const adapters: SourceAdapter[] = [
    {
      id: 'cline',
      name: 'Cline (VS Code)',
      sessionsRoot: join(clineDataDir(), 'sessions'),
    },
  ];
  const genericDir = loadGenericDir();
  if (genericDir) {
    adapters.push({ id: 'generic-jsonl', name: 'Generic JSONL', sessionsRoot: genericDir });
  }
  return adapters;
}

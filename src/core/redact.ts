const PATTERNS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9]{16,}/g, '[REDACTED]'],
  [/ghp_[A-Za-z0-9]{20,}/g, '[REDACTED]'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED]'],
  [/AKIA[0-9A-Z]{16}/g, '[REDACTED]'],
  [/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]'],
  [
    /(api[_-]?key|apikey|access[_-]?token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9\-._~+/]{12,}["']?/gi,
    '$1=[REDACTED]',
  ],
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

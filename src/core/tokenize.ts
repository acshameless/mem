const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const ASCII_TOKEN = /^[\x00-\x7F]+$/;

// Insert spaces between CJK characters so FTS5 can index them as single tokens.
export function segmentForSearch(text: string): string {
  return text.replace(CJK_PATTERN, ' $& ').replace(/\s+/g, ' ').trim();
}

// Build OR terms for the segmented index: ASCII words plus CJK character bigrams.
export function segmentedQueryTerms(query: string): string[] {
  const terms: string[] = [];
  for (const match of query.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const token = match[0];
    if (ASCII_TOKEN.test(token) && token.length >= 2) terms.push(`"${token}"`);
  }
  const runs = query.match(CJK_RUN) ?? [];
  for (const run of runs) {
    if (run.length === 1) {
      terms.push(`"${run}"`);
      continue;
    }
    for (let index = 0; index + 1 < run.length; index += 1) {
      terms.push(`"${run[index]} ${run[index + 1]}"`);
    }
  }
  return [...new Set(terms)].slice(0, 12);
}

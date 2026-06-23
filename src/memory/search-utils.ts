export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function occurrences(haystack: string, term: string): number {
  let count = 0;
  let index = haystack.indexOf(term);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(term, index + term.length);
  }
  return count;
}

export type TermScoreMode = "presence" | "occurrences";

function scoreTerms(haystack: string, terms: string[], mode: TermScoreMode = "presence"): number {
  return terms.reduce(
    (sum, term) => sum + (mode === "occurrences" ? occurrences(haystack, term) : haystack.includes(term) ? 1 : 0),
    0
  );
}

function snippetFor(content: string, terms: string[], maxLength = 240): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  const lower = normalized.toLowerCase();
  const index = terms.map((term) => lower.indexOf(term)).find((candidate) => candidate >= 0) ?? 0;
  const start = Math.max(0, index - 80);
  return normalized.slice(start, start + maxLength);
}

export function rankSearchResults<T>(
  items: T[],
  terms: string[],
  options: {
    getHaystack: (item: T) => string;
    getSnippetSource: (item: T) => string;
    mode?: TermScoreMode;
    snippetLength?: number;
    sortKey?: (a: T, b: T) => number;
  }
): Array<T & { score: number; snippet: string }> {
  const mode = options.mode ?? "presence";
  const snippetLength = options.snippetLength ?? 240;
  return items
    .map((item) => {
      const haystack = options.getHaystack(item).toLowerCase();
      const score = scoreTerms(haystack, terms, mode);
      return {
        ...item,
        score,
        snippet: snippetFor(options.getSnippetSource(item), terms, snippetLength)
      };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => {
      const byScore = b.score - a.score;
      if (byScore !== 0) return byScore;
      return options.sortKey ? options.sortKey(a, b) : 0;
    });
}
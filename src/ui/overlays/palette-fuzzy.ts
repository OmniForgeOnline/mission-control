export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().trim();
  const t = text.toLowerCase();
  if (!q) return 0;
  if (!t) return -1;

  const exactIndex = t.indexOf(q);
  if (exactIndex >= 0) {
    return 1000 + (200 - exactIndex) + (t.startsWith(q) ? 50 : 0);
  }

  let qi = 0;
  let score = 0;
  let lastMatch = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    const gap = lastMatch >= 0 ? ti - lastMatch - 1 : ti;
    score += 12 - Math.min(gap, 11);
    if (ti === 0 || t[ti - 1] === " " || t[ti - 1] === "/" || t[ti - 1] === "-") {
      score += 6;
    }
    lastMatch = ti;
    qi++;
  }
  if (qi !== q.length) return -1;
  return score;
}

export function bestFuzzyScore(query: string, parts: Array<string | undefined>): number {
  let best = -1;
  for (const part of parts) {
    if (!part) continue;
    const score = fuzzyScore(query, part);
    if (score > best) best = score;
  }
  return best;
}
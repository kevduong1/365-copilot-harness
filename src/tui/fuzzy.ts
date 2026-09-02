export interface FuzzyHit {
  text: string;
  score: number;
  positions: number[];
}

export function fuzzyMatch(query: string, text: string): FuzzyHit | undefined {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return { text, score: 0, positions: [] };
  const hay = text.toLowerCase();
  const positions: number[] = [];
  let from = 0;
  for (const ch of q) {
    const found = hay.indexOf(ch, from);
    if (found === -1) return undefined;
    positions.push(found);
    from = found + 1;
  }
  const span = positions.at(-1)! - positions[0]! + 1;
  const consecutive = positions.reduce((sum, pos, index) => {
    return index > 0 && pos === positions[index - 1]! + 1 ? sum + 1 : sum;
  }, 0);
  const prefix = positions[0] === 0 ? 20 : 0;
  const score = prefix + consecutive * 8 - span + Math.max(0, 40 - text.length);
  return { text, score, positions };
}

export function fuzzyFilter(query: string, items: readonly string[]): FuzzyHit[] {
  const hits: FuzzyHit[] = [];
  for (const item of items) {
    const hit = fuzzyMatch(query, item);
    if (hit !== undefined) hits.push(hit);
  }
  hits.sort((a, b) => b.score - a.score || a.text.localeCompare(b.text));
  return hits;
}

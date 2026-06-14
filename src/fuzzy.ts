// Deterministic near-miss recall, no model and no trigram table.
//
// The failure this fixes: a user types an identifier-like token whose exact
// form misses the corpus's neighbor — `search("wwdc27")` finds nothing because
// the sessions say "WWDC26". The shared alpha stem ("wwdc") is the real signal,
// and FTS5 already supports prefix queries over the existing index, so we emit
// a prefix term on the stem (`wwdc27` -> `wwdc*`) and let the family be
// recalled. No schema change, no reindex.
//
// Targeted on purpose: only ALPHA+DIGIT identifier tokens qualify (wwdc27,
// oauth2, ipv6, http2), and callers fire this ONLY for single-rare-token
// queries — the exact case that needs it and the only one with no precision to
// lose. Ordinary words ("serval") and multi-word queries are never broadened.
const ID_LIKE = /^(?=.*[a-z])(?=.*\d)[a-z0-9.]+$/i; // has at least one letter AND one digit

export function fuzzyPrefixTerms(tokens: string[]): string[] {
  const out = new Set<string>();
  for (const t of tokens) {
    if (!ID_LIKE.test(t)) continue;
    const stem = t.match(/^[a-z]+/i)?.[0] ?? "";
    // A 1-2 char stem ("v1") is too broad to be a useful prefix; require >=3.
    if (stem.length >= 3) out.add(`${stem.toLowerCase()}*`);
  }
  return [...out];
}

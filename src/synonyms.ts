// Curated, bidirectional synonym groups for deterministic query expansion —
// no model, no network. Each group is a set of equivalent terms (single words
// or multi-word phrases). If any member appears in the raw query, the OTHER
// members are offered as OR alternatives at query-build time, so e.g. a query
// for "vulnerability reward program" also matches sessions that only ever say
// "bug bounty".
//
// Keep this SMALL and high-confidence. A wrong synonym pollutes recall worse
// than a missing one (it pulls unrelated sessions into every matching query),
// so only add pairs that are genuinely interchangeable in this user's domain.
// This is the deterministic stand-in for semantic recall: it closes the
// specific synonym gaps we hit without an embedding model in the hot path.
const GROUPS: string[][] = [
  ["bounty", "bug bounty", "vrp", "vulnerability reward program"],
  ["llm", "language model", "large language model"],
  ["prompt injection", "indirect prompt injection"],
  ["recon", "reconnaissance"],
  ["authz", "authorization"],
  ["authn", "authentication"],
];

// Lowercased, deduped member lookup built once at module load.
const NORMALIZED: { members: string[] }[] = GROUPS.map((g) => ({
  members: [...new Set(g.map((m) => m.toLowerCase()))],
}));

// FTS5-quote a term: double quotes make a single token a literal and a
// multi-word string a phrase match. Mirrors ftsEscape in queries.ts.
function ftsQuote(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

// For a raw query, return FTS-ready alias terms triggered by synonym groups.
// A group fires when any of its members appears as a substring of the query;
// the group's OTHER members (not already present literally) become aliases.
// Returns deduped, FTS-quoted strings ready to OR into a query. Empty when no
// group matches — callers then build their query exactly as before.
export function aliasTerms(rawQuery: string): string[] {
  const q = rawQuery.toLowerCase();
  const out = new Set<string>();
  for (const { members } of NORMALIZED) {
    const present = members.filter((m) => q.includes(m));
    if (present.length === 0) continue;
    for (const m of members) {
      if (present.includes(m)) continue; // already in the query literally
      out.add(ftsQuote(m));
    }
  }
  return [...out];
}

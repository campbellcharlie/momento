import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Reader for ISE `ledger.jsonl` files (append-only task-closure rows). momento stays the recall +
// aggregation layer; ISE is the writer and owns the schema (see ~/src/ISE/core/ledger/schema.md).
// Fully additive and read-only: if no ledger.jsonl files exist under the roots, aggregateLedger
// returns an empty result and nothing else in momento is affected.

export interface LedgerRow {
  id?: string;
  schema?: string;
  module?: string;
  outcome?: string;
  stack?: string;
  persona?: string;
  vuln_class?: string;
  class?: string;
  supersedes?: string;
  [k: string]: unknown;
}

// Taxonomy mirrors ISE core/ledger. Only idea-quality outcomes move effectiveness priors;
// harness-failures are neutral (they measure tooling, not the idea).
const IDEA_POSITIVE = new Set(["cracked", "shipped", "hardened", "resolved"]);
const IDEA_NEGATIVE = new Set(["misfit"]);
const HARNESS = new Set(["blocked-tooling", "blocked-refusal"]);
const COMPENSATING = new Set(["retracted", "superseded"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", ".worktrees"]);

// Roots to scan for ledgers. Mirrors momento's MOMENTO_SRC_ROOTS convention (defaults to ~/src).
export function ledgerRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.MOMENTO_SRC_ROOTS;
  if (raw) return raw.split(/[:,]/).map((s) => s.trim()).filter(Boolean);
  return [join(homedir(), "src")];
}

// Bounded recursive walk for files literally named `ledger.jsonl`.
export function findLedgerFiles(roots: string[], maxDepth = 4): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        walk(join(dir, e.name), depth + 1);
      } else if (e.isFile() && e.name === "ledger.jsonl") {
        found.push(join(dir, e.name));
      }
    }
  };
  for (const r of roots) {
    try {
      if (statSync(r).isDirectory()) walk(r, 0);
    } catch {
      /* missing root — skip */
    }
  }
  return found;
}

// Parse one ledger, applying compensating events (retracted/superseded). Bad lines skipped.
export function readLedgerRows(path: string): LedgerRow[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const byId = new Map<string, LedgerRow>();
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let row: LedgerRow;
    try {
      row = JSON.parse(t) as LedgerRow;
    } catch {
      continue;
    }
    if (!row || !row.id) continue;
    if (row.outcome && COMPENSATING.has(row.outcome)) {
      if (row.supersedes) byId.delete(row.supersedes);
      continue;
    }
    byId.set(row.id, row);
  }
  return [...byId.values()];
}

export interface IdeaQualityGroup {
  key: string;
  persona: string;
  stack: string;
  class: string;
  positive: number;
  negative: number;
  n: number;
  rate: number;
  confident: boolean;
}

export interface HarnessHealth {
  "blocked-tooling": number;
  "blocked-refusal": number;
  total_blocked: number;
  total_idea: number;
  harness_loss_rate: number;
}

export interface LedgerAggregation {
  total_rows: number;
  sources: number;
  idea_quality: IdeaQualityGroup[];
  harness_health: HarnessHealth;
}

export interface AggregateOptions {
  module?: string;
  stack?: string;
  minN?: number;
}

// The structured aggregation FTS can't do: numeric rollups over closure rows.
export function aggregateLedger(
  opts: AggregateOptions = {},
  roots: string[] = ledgerRoots(),
): LedgerAggregation {
  const files = findLedgerFiles(roots);
  const rows: LedgerRow[] = [];
  for (const f of files) rows.push(...readLedgerRows(f));
  const filtered = rows.filter(
    (r) => (!opts.module || r.module === opts.module) && (!opts.stack || r.stack === opts.stack),
  );

  const minN = opts.minN ?? 3;
  const groups = new Map<string, IdeaQualityGroup>();
  const hh: HarnessHealth = {
    "blocked-tooling": 0,
    "blocked-refusal": 0,
    total_blocked: 0,
    total_idea: 0,
    harness_loss_rate: 0,
  };

  for (const r of filtered) {
    const o = (r.outcome ?? "").toLowerCase();
    if (o === "blocked-tooling" || o === "blocked-refusal") {
      hh[o]++;
      hh.total_blocked++;
      continue;
    }
    if (!IDEA_POSITIVE.has(o) && !IDEA_NEGATIVE.has(o)) continue;
    hh.total_idea++;
    const persona = String(r.persona ?? "-");
    const stack = String(r.stack ?? "-");
    const cls = String(r.vuln_class ?? r.class ?? "-");
    const key = `${persona} × ${stack} × ${cls}`;
    const g =
      groups.get(key) ??
      { key, persona, stack, class: cls, positive: 0, negative: 0, n: 0, rate: 0, confident: false };
    g.n++;
    if (IDEA_POSITIVE.has(o)) g.positive++;
    else g.negative++;
    groups.set(key, g);
  }

  const denom = hh.total_idea + hh.total_blocked;
  hh.harness_loss_rate = denom ? hh.total_blocked / denom : 0;

  const idea_quality = [...groups.values()]
    .map((g) => ({ ...g, rate: g.n ? g.positive / g.n : 0, confident: g.n >= minN }))
    .sort((a, b) => b.positive - a.positive || b.rate - a.rate);

  return { total_rows: filtered.length, sources: files.length, idea_quality, harness_health: hh };
}

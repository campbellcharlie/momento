import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { aggregateLedger, ledgerRoots } from "./ledger.js";
import { indexExternalFast } from "./external.js";

// Memory consolidation — the "sleep pass". momento's other tables are RAW EPISODIC records (every
// session, tool call, ledger row, audit line kept verbatim). This derives a small set of SEMANTIC FACTS
// from them: many episodes → one durable, searchable claim. Two design rules, both load-bearing:
//   • RAW STAYS RAW (MemMachine): facts live in their own table; consolidation never rewrites source rows,
//     so the ground truth is always recoverable and a bad pass can be re-run.
//   • INVALIDATE, DON'T DELETE (Zep bi-temporal): when a fact's claim changes, the old row is closed
//     (valid_to set) and a new current row inserted — so "what did I believe, and when" stays answerable.
// v1 is deterministic (no LLM): tool-reliability from the marshal audit, outcome-patterns from the ISE
// ledger aggregation. Model-derived facts (episode summaries) can slot in later as another fact `kind`.

const FTS_SAFE = /[^\p{L}\p{N}_.-]+/gu;
function orQuery(q: string): string {
  return q.replace(FTS_SAFE, " ").trim().split(/\s+/).filter(Boolean).map((t) => `"${t}"`).join(" OR ");
}
const support = (n: number, k = 5): number => Math.round((n / (n + k)) * 100) / 100; // belief grows with data
const pct = (x: number): number => Math.round(x * 100);

interface DerivedFact {
  id: string; kind: string; subject: string; statement: string; confidence: number; n: number; provenance: string;
}

// Bi-temporal upsert of one derived fact keyed by its logical `id`.
function upsertFact(db: DatabaseSync, f: DerivedFact, now: string): "new" | "same" | "changed" {
  const cur = db.prepare("SELECT fact_id, statement FROM facts WHERE id = ? AND valid_to IS NULL").get(f.id) as
    | { fact_id: number; statement: string }
    | undefined;
  const insert = () =>
    db.prepare(
      "INSERT INTO facts(id,kind,subject,statement,confidence,n,provenance,valid_from,valid_to,updated) VALUES (?,?,?,?,?,?,?,?,NULL,?)",
    ).run(f.id, f.kind, f.subject, f.statement, f.confidence, f.n, f.provenance, now, now);
  if (!cur) { insert(); return "new"; }
  if (cur.statement === f.statement) {                       // same claim → just refresh support/timestamp
    db.prepare("UPDATE facts SET confidence=?, n=?, provenance=?, updated=? WHERE fact_id=?").run(f.confidence, f.n, f.provenance, now, cur.fact_id);
    return "same";
  }
  db.prepare("UPDATE facts SET valid_to=? WHERE fact_id=?").run(now, cur.fact_id); // claim changed → close old…
  insert();                                                  // …and open a new current row
  return "changed";
}

export interface ConsolidateResult { tool_reliability: number; ledger_pattern: number; changed: number; total_current: number; }
export interface ConsolidateOpts { now?: string; minN?: number; ledgerRoots?: string[] }

// Run one consolidation pass. Idempotent: re-running with unchanged inputs only bumps timestamps.
export function consolidateInto(db: DatabaseSync, opts: ConsolidateOpts = {}): ConsolidateResult {
  const now = opts.now ?? new Date().toISOString();
  const minN = opts.minN ?? 3;
  let toolFacts = 0, ledgerFacts = 0, changed = 0;
  db.exec("BEGIN");
  try {
    // 1) TOOL RELIABILITY — from marshal's audit trail (already ingested into audit_fts). One fact per
    //    backend.tool: how often it succeeded, over how many calls. This is memory's read of #4's trust.
    const trows = db.prepare(
      `SELECT backend, tool,
         SUM(CASE WHEN ok = 'true' THEN 1 ELSE 0 END) AS oks,
         COUNT(*) AS n, MAX(ts) AS last_ts
       FROM audit_fts
       WHERE event = 'call' AND backend NOT IN ('', 'marshal') AND tool NOT IN ('', 'recent')
       GROUP BY backend, tool HAVING n >= ?`,
    ).all(minN) as { backend: string; tool: string; oks: number; n: number; last_ts: string }[];
    for (const r of trows) {
      const rate = r.n ? r.oks / r.n : 0;
      if (upsertFact(db, {
        id: `tool:${r.backend}.${r.tool}`, kind: "tool_reliability", subject: `${r.backend}.${r.tool}`,
        statement: `${r.backend}.${r.tool}: ${r.oks}/${r.n} calls succeeded (${pct(rate)}% reliable)`,
        confidence: support(r.n), n: r.n,
        provenance: JSON.stringify({ oks: r.oks, n: r.n, rate: Math.round(rate * 100) / 100, last_ts: r.last_ts }),
      }, now) === "changed") changed++;
      toolFacts++;
    }
    // 1b) NATIVE + MCP TOOL RELIABILITY — from momento's own tool_calls, whose is_error is joined from the
    //     transcript's tool_result. This is the "made anywhere" signal marshal's MCP-only audit can't see
    //     (Bash/Edit/Read/… plus MCP tools as Claude invokes them). Keyed `tool:<name>` — no backend prefix,
    //     so it never collides with the `tool:<backend>.<tool>` facts above. NULL is_error (unknown outcome,
    //     e.g. codex/gemini) is excluded so it can't dilute the rate.
    const nrows = db.prepare(
      `SELECT tool_name AS tool,
         SUM(CASE WHEN is_error = 0 THEN 1 ELSE 0 END) AS oks,
         COUNT(*) AS n, MAX(timestamp) AS last_ts
       FROM tool_calls
       WHERE is_error IS NOT NULL AND tool_name <> ''
       GROUP BY tool_name HAVING n >= ?`,
    ).all(minN) as { tool: string; oks: number; n: number; last_ts: string }[];
    for (const r of nrows) {
      const rate = r.n ? r.oks / r.n : 0;
      if (upsertFact(db, {
        id: `tool:${r.tool}`, kind: "tool_reliability", subject: r.tool,
        statement: `${r.tool}: ${r.oks}/${r.n} calls succeeded (${pct(rate)}% reliable)`,
        confidence: support(r.n), n: r.n,
        provenance: JSON.stringify({ oks: r.oks, n: r.n, rate: Math.round(rate * 100) / 100, last_ts: r.last_ts, source: "tool_calls" }),
      }, now) === "changed") changed++;
      toolFacts++;
    }
    // 2) OUTCOME PATTERNS — reuse the ledger's numeric aggregation (persona × stack × class). Persists the
    //    "which approaches tend to work" prior as durable, searchable facts.
    const agg = aggregateLedger({ minN }, opts.ledgerRoots ?? ledgerRoots());
    for (const g of agg.idea_quality) {
      if (g.n < minN) continue;
      if (upsertFact(db, {
        id: `ledger:${g.key}`, kind: "ledger_pattern", subject: g.key,
        statement: `${g.key}: ${g.positive}/${g.n} positive outcomes (${pct(g.rate)}% success)`,
        confidence: support(g.n, 3), n: g.n,
        provenance: JSON.stringify({ positive: g.positive, negative: g.negative, rate: Math.round(g.rate * 100) / 100 }),
      }, now) === "changed") changed++;
      ledgerFacts++;
    }
    // Rebuild the FTS mirror over CURRENT facts only (small table → full rebuild is simplest + correct).
    db.exec("DELETE FROM facts_fts");
    const ins = db.prepare("INSERT INTO facts_fts(fact_id, kind, subject, statement) VALUES (?,?,?,?)");
    for (const c of db.prepare("SELECT fact_id, kind, subject, statement FROM facts WHERE valid_to IS NULL").all() as
      { fact_id: number; kind: string; subject: string; statement: string }[]) ins.run(c.fact_id, c.kind, c.subject, c.statement);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  const total = (db.prepare("SELECT COUNT(*) AS n FROM facts WHERE valid_to IS NULL").get() as { n: number }).n;
  return { tool_reliability: toolFacts, ledger_pattern: ledgerFacts, changed, total_current: total };
}

// Canonical ISE ledger only (~/.ise / $ISE_HOME) — never the MOMENTO_SRC_ROOTS/~/src walk. That walk is
// slow cold and, on a RAID/external volume, stalls under a headless (cron) context; the FTS hot path avoids
// it for the same reason.
export function canonicalLedgerRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return [env.ISE_HOME || join(homedir(), ".ise")];
}

// Refresh the external sources then re-derive facts, in one cheap (~0.1s) call. This is what makes a
// scheduler unnecessary: recall_facts calls it right before reading, so facts always reflect the latest
// marshal audit + ISE ledger (mirrors how search_ledger/search_audit refresh via indexExternalFast).
export function refreshAndConsolidate(db: DatabaseSync, env: NodeJS.ProcessEnv = process.env): ConsolidateResult {
  indexExternalFast(db, env);                                // audit_fts + canonical ledger_fts fresh (mtime-gated)
  return consolidateInto(db, { ledgerRoots: canonicalLedgerRoots(env) });
}

export interface FactHit {
  id: string; kind: string; subject: string; statement: string; confidence: number; n: number; provenance: string; valid_from: string; updated: string;
}
// Search CURRENT (believed) facts. With a query → FTS/BM25 over statement+subject; without → list by
// confidence. Optional kind/subject filters. Invalidated (valid_to set) facts are never returned.
export function searchFacts(db: DatabaseSync, opts: { query?: string; kind?: string; subject?: string; limit?: number } = {}): FactHit[] {
  const cols = "f.id, f.kind, f.subject, f.statement, f.confidence, f.n, f.provenance, f.valid_from, f.updated";
  const params: (string | number)[] = [];
  let sql: string, order: string;
  const fts = opts.query ? orQuery(opts.query) : "";
  if (fts) {
    sql = `SELECT ${cols}, bm25(facts_fts) AS score FROM facts_fts JOIN facts f ON f.fact_id = facts_fts.fact_id WHERE facts_fts MATCH ? AND f.valid_to IS NULL`;
    params.push(fts); order = " ORDER BY score ASC";
  } else {
    sql = `SELECT ${cols} FROM facts f WHERE f.valid_to IS NULL`;
    order = " ORDER BY f.confidence DESC, f.updated DESC";
  }
  if (opts.kind) { sql += " AND f.kind = ?"; params.push(opts.kind); }
  if (opts.subject) { sql += " AND f.subject = ?"; params.push(opts.subject); }
  sql += order + " LIMIT ?"; params.push(opts.limit ?? 20);
  return db.prepare(sql).all(...params) as unknown as FactHit[];
}

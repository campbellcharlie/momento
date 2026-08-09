import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { findLedgerFiles, ledgerRoots, readLedgerRows, type LedgerRow } from "./ledger.js";

// External append-only JSONL sources indexed for full-text search — strictly ADDITIVE and OPTIONAL:
// if ISE's ledger (~/.ise/ledger.jsonl …) or marshal's audit trail (~/.marshal/audit.jsonl …) aren't
// present, nothing is indexed and the rest of momento is unaffected. Each file is re-ingested only when
// its mtime changes (tracked in external_sources), so repeated searches stay cheap.

const FTS_SAFE = /[^\p{L}\p{N}_-]+/gu;
function orQuery(q: string): string {
  const toks = q.replace(FTS_SAFE, " ").trim().split(/\s+/).filter(Boolean);
  return toks.map((t) => `"${t}"`).join(" OR ");
}
function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

// ── marshal audit-trail discovery: active log + rotated segments; $MARSHAL_AUDIT overrides the path ──
export function auditFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const base = env.MARSHAL_AUDIT || join(homedir(), ".marshal", "audit.jsonl");
  const dir = dirname(base);
  const name = basename(base);
  const out: string[] = [];
  try {
    for (const f of readdirSync(dir)) if (f === name || f.startsWith(name + ".")) out.push(join(dir, f));
  } catch {
    /* no ~/.marshal — nothing to index */
  }
  return out;
}

// ── bg-job timeline discovery: ~/.claude/jobs/<id>/timeline.jsonl (append-only outcome ledgers) ──
export function timelineFiles(home: string = homedir()): string[] {
  const root = join(home, ".claude", "jobs");
  const out: string[] = [];
  try {
    for (const id of readdirSync(root)) {
      const f = join(root, id, "timeline.jsonl");
      try {
        if (statSync(f).isFile()) out.push(f);
      } catch {
        /* no timeline.jsonl in this job dir */
      }
    }
  } catch {
    /* no ~/.claude/jobs — nothing to index */
  }
  return out;
}

function fileMtime(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

// Searchable blob for a ledger closure: every string/number leaf value in the row.
function ledgerContent(row: LedgerRow): string {
  const parts: string[] = [];
  for (const v of Object.values(row)) {
    if (typeof v === "string" || typeof v === "number") parts.push(String(v));
    else if (Array.isArray(v))
      parts.push(v.filter((x) => typeof x === "string" || typeof x === "number").map(String).join(" "));
  }
  return parts.join(" ");
}

// Parse a marshal audit JSONL (one JSON object per line). Bad lines skipped.
function readAuditRows(path: string): Array<Record<string, unknown>> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as Record<string, unknown>);
    } catch {
      /* skip */
    }
  }
  return out;
}

// Parse a bg-job timeline.jsonl (one {at,state,detail,text} per line). Rows whose detail AND text are
// both blank carry no searchable headline and are skipped — indexing them would only pollute recall.
interface TimelineRow {
  state: string;
  ts: string;
  content: string;
}
function readTimelineRows(path: string): TimelineRow[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: TimelineRow[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    const content = [str(r.detail), str(r.text)].filter(Boolean).join(" ").trim();
    if (!content) continue; // blank row — no headline to index
    out.push({ state: str(r.state), ts: str(r.at) || str(r.ts), content });
  }
  return out;
}

// Generic mtime-gated re-ingest of one JSONL source file into its *_fts table.
function ingest(db: DatabaseSync, path: string, kind: "ledger" | "audit" | "timeline"): void {
  const mtime = fileMtime(path);
  if (mtime === null) return;
  const prev = db.prepare("SELECT mtime FROM external_sources WHERE path = ?").get(path) as
    | { mtime?: string }
    | undefined;
  if (prev?.mtime === mtime) return; // unchanged since last index
  db.exec("BEGIN");
  try {
    db.prepare(`DELETE FROM ${kind}_fts WHERE source_path = ?`).run(path);
    if (kind === "ledger") {
      const ins = db.prepare(
        `INSERT INTO ledger_fts(source_path, entry_id, outcome, module, stack, klass, ts, content) VALUES (?,?,?,?,?,?,?,?)`,
      );
      for (const r of readLedgerRows(path)) {
        ins.run(path, str(r.id), str(r.outcome), str(r.module), str(r.stack), str(r.vuln_class ?? r.class), str(r.ts ?? r.timestamp ?? r.closed_at), ledgerContent(r));
      }
    } else if (kind === "audit") {
      const ins = db.prepare(
        `INSERT INTO audit_fts(source_path, backend, tool, event, ok, ms, ts, content) VALUES (?,?,?,?,?,?,?,?)`,
      );
      for (const r of readAuditRows(path)) {
        const backend = str(r.backend), tool = str(r.tool), event = str(r.event);
        const argKeys = Array.isArray(r.arg_keys) ? (r.arg_keys as unknown[]).map(String) : [];
        const content = [backend && tool ? `${backend}.${tool}` : backend || tool, event, ...argKeys].filter(Boolean).join(" ");
        ins.run(path, backend, tool, event, str(r.ok), str(r.ms), str(r.ts), content);
      }
    } else {
      // timeline: one row per non-empty {at,state,detail,text} line of a bg-job's timeline.jsonl.
      const ins = db.prepare(
        `INSERT INTO timeline_fts(source_path, job_id, state, ts, content) VALUES (?,?,?,?,?)`,
      );
      const jobId = basename(dirname(path)); // ~/.claude/jobs/<id>/timeline.jsonl → <id>
      for (const r of readTimelineRows(path)) ins.run(path, jobId, r.state, r.ts, r.content);
    }
    db.prepare(
      `INSERT INTO external_sources(path, kind, mtime) VALUES (?,?,?) ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, mtime = excluded.mtime`,
    ).run(path, kind, mtime);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ── indexing entry points (called from Indexer) ─────────────────────────────────────────────────
// FULL scan — walks MOMENTO_SRC_ROOTS for per-project ledgers. On a slow/large tree this walk costs
// seconds, so it belongs to rebuild/startup, NOT the search hot path.
export function indexLedgerInto(db: DatabaseSync, roots: string[] = ledgerRoots()): void {
  for (const f of findLedgerFiles(roots)) ingest(db, f, "ledger");
}
export function indexAuditInto(db: DatabaseSync, files: string[] = auditFiles()): void {
  for (const f of files) ingest(db, f, "audit");
}
// Background-job outcome ledgers — walks ~/.claude/jobs/*/timeline.jsonl. Per-file mtime-gated; empty
// rows are dropped (see readTimelineRows). Additive & optional: no jobs dir → no-op.
export function indexTimelineInto(db: DatabaseSync, files: string[] = timelineFiles()): void {
  for (const f of files) ingest(db, f, "timeline");
}
// FAST refresh — only the canonical fixed paths (ISE_HOME/ledger.jsonl + marshal audit); no ~/src walk,
// mtime-gated. Cheap enough to call before every external search. Per-project ledgers still refresh on
// the next full rebuild.
export function indexExternalFast(db: DatabaseSync, env: NodeJS.ProcessEnv = process.env): void {
  const iseLedger = join(env.ISE_HOME || join(homedir(), ".ise"), "ledger.jsonl");
  try {
    if (statSync(iseLedger).isFile()) ingest(db, iseLedger, "ledger");
  } catch {
    /* no ISE ledger — nothing to refresh */
  }
  indexAuditInto(db, auditFiles(env));
}

// ── search entry points (called from the MCP tools) ─────────────────────────────────────────────
export interface LedgerHit {
  entry_id: string; outcome: string; module: string; stack: string; klass: string; ts: string; snippet: string; source_path: string; score: number;
  verified?: boolean;         // write-time probe status from the live-resolved row (undefined = not stamped: pre-gate or self-falsifying bypass)
  downgrade_reason?: string;  // why a positive closure was downgraded to conjecture (undefined if not downgraded)
}
export function searchLedger(db: DatabaseSync, q: string, opts: { outcome?: string; klass?: string; limit?: number } = {}): LedgerHit[] {
  const fts = orQuery(q);
  if (!fts) return [];
  let sql = `SELECT entry_id, outcome, module, stack, klass, ts, snippet(ledger_fts, 7, '[', ']', '…', 12) AS snippet, source_path, bm25(ledger_fts) AS score FROM ledger_fts WHERE ledger_fts MATCH ?`;
  const params: (string | number)[] = [fts];
  if (opts.outcome) { sql += " AND outcome = ?"; params.push(opts.outcome); }
  if (opts.klass) { sql += " AND klass = ?"; params.push(opts.klass); }
  sql += " ORDER BY score ASC LIMIT ?"; params.push(opts.limit ?? 20);
  const hits = db.prepare(sql).all(...params) as unknown as LedgerHit[];
  return annotateTrust(hits);
}

// Attach write-time trust status (verified / downgrade_reason) by resolving each hit back to its
// CURRENT ledger row. Keeps recall honest: an unverified-but-shipped row or a downgraded conjecture
// no longer reads identically to a probe-verified closure. Live-resolved from the source file, so it
// reflects the latest write (incl. gate downgrades) with no FTS schema change or reindex. Cost: one
// small file read per distinct source_path in the result set.
function annotateTrust(hits: LedgerHit[]): LedgerHit[] {
  if (!hits.length) return hits;
  const byPath = new Map<string, Map<string, LedgerRow>>();
  const rowsFor = (p: string): Map<string, LedgerRow> => {
    let m = byPath.get(p);
    if (!m) { m = new Map(readLedgerRows(p).map((r) => [String(r.id), r])); byPath.set(p, m); }
    return m;
  };
  for (const h of hits) {
    const row = rowsFor(h.source_path).get(h.entry_id);
    if (!row) continue;
    if (typeof row.verified === "boolean") h.verified = row.verified;
    if (typeof row.downgrade_reason === "string") h.downgrade_reason = row.downgrade_reason;
  }
  return hits;
}

export interface AuditHit {
  backend: string; tool: string; event: string; ok: string; ms: string; ts: string; snippet: string; source_path: string; score: number;
}
export function searchAudit(db: DatabaseSync, q: string, opts: { backend?: string; tool?: string; ok?: boolean; since?: string; limit?: number } = {}): AuditHit[] {
  const fts = orQuery(q);
  if (!fts) return [];
  let sql = `SELECT backend, tool, event, ok, ms, ts, snippet(audit_fts, 7, '[', ']', '…', 12) AS snippet, source_path, bm25(audit_fts) AS score FROM audit_fts WHERE audit_fts MATCH ?`;
  const params: (string | number)[] = [fts];
  if (opts.backend) { sql += " AND backend = ?"; params.push(opts.backend); }
  if (opts.tool) { sql += " AND tool = ?"; params.push(opts.tool); }
  if (typeof opts.ok === "boolean") { sql += " AND ok = ?"; params.push(opts.ok ? "true" : "false"); }
  if (opts.since) { sql += " AND ts >= ?"; params.push(opts.since); }
  sql += " ORDER BY ts DESC LIMIT ?"; params.push(opts.limit ?? 20); // log-like: most recent match first
  return db.prepare(sql).all(...params) as unknown as AuditHit[];
}

export interface TimelineHit {
  job_id: string; state: string; ts: string; snippet: string; source_path: string; score: number;
}
export function searchTimeline(db: DatabaseSync, q: string, opts: { state?: string; since?: string; limit?: number } = {}): TimelineHit[] {
  const fts = orQuery(q);
  if (!fts) return [];
  let sql = `SELECT job_id, state, ts, snippet(timeline_fts, 4, '[', ']', '…', 12) AS snippet, source_path, bm25(timeline_fts) AS score FROM timeline_fts WHERE timeline_fts MATCH ?`;
  const params: (string | number)[] = [fts];
  if (opts.state) { sql += " AND state = ?"; params.push(opts.state); }
  if (opts.since) { sql += " AND ts >= ?"; params.push(opts.since); }
  sql += " ORDER BY ts DESC LIMIT ?"; params.push(opts.limit ?? 20); // ledger-like: most recent match first
  return db.prepare(sql).all(...params) as unknown as TimelineHit[];
}

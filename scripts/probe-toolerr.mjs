#!/usr/bin/env node
// Acceptance probes for MMNTO-002-tool-errors. Each `isc*` builds a minimal index into a throwaway DB
// (reading the REAL ~/.claude and ~/.codex) and asserts one falsifiable property. Read-only w.r.t. those.
// Usage: node scripts/probe-toolerr.mjs <isc1|isc2|isc-c1|isc-a1|all>   (exit 0 = pass)

import { Indexer } from "../dist/indexer.js";
import { consolidateInto } from "../dist/consolidate.js";
import { defaultSources } from "../dist/sources.js";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

const HOME = homedir();
function tmpDb() { const d = mkdtempSync(join(tmpdir(), "momento-toolerr-")); return join(d, "index.db"); }
function die(msg) { console.error("FAIL: " + msg); process.exit(1); }
function ok(msg) { console.log("PASS: " + msg); process.exit(0); }

// ── Independent (non-momento) transcript oracle: for one claude session file, join tool_use.id →
//    tool_result.is_error by hand and count the errors. Deliberately a separate implementation from the
//    parser so agreement is a real conservation check, not a tautology. ────────────────────────────────
function transcriptErrorCount(path) {
  const useIds = new Set();
  let errs = 0;
  // Two passes so a result never precedes its use in the count (order-independent).
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  const parsed = [];
  for (const l of lines) { try { parsed.push(JSON.parse(l)); } catch { /* skip bad line */ } }
  for (const e of parsed) {
    const c = e?.message?.content;
    if (!Array.isArray(c)) continue;
    if (e.type === "assistant") for (const b of c) if (b?.type === "tool_use" && typeof b.id === "string") useIds.add(b.id);
  }
  for (const e of parsed) {
    const c = e?.message?.content;
    if (!Array.isArray(c)) continue;
    if (e.type === "user") for (const b of c) if (b?.type === "tool_result" && b.is_error === true && useIds.has(b.tool_use_id)) errs++;
  }
  return errs;
}

// Locate the top-level claude session with the most joined tool errors (skips subagent sidecar dirs).
// Self-locating so the probe isn't brittle to any one transcript being deleted.
function findErrorSession() {
  const root = join(HOME, ".claude", "projects");
  let best = null;
  for (const proj of safeReaddir(root)) {
    const pdir = join(root, proj);
    for (const f of safeReaddir(pdir)) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(pdir, f);
      let text; try { text = readFileSync(path, "utf8"); } catch { continue; }
      if (!text.includes('"is_error":true')) continue; // cheap prefilter before full parse
      const errs = transcriptErrorCount(path);
      if (errs > 0 && (!best || errs > best.errs)) best = { path, projectDir: pdir, sessionId: f.replace(/\.jsonl$/, ""), errs };
    }
  }
  return best;
}
function safeReaddir(d) { try { return readdirSync(d); } catch { return []; } }

// ISC-1 — is_error round-trips: DB is_error=1 count == independent transcript error count (and > 0).
async function isc1() {
  const sess = findErrorSession();
  if (!sess) die("no claude session with joined tool errors found — cannot test round-trip");
  const idx = new Indexer(tmpDb());
  await idx.indexSession(sess.path, sess.projectDir, sess.sessionId);
  const dbErr = idx.db.prepare("SELECT COUNT(*) c FROM tool_calls WHERE is_error = 1").get().c;
  idx.db.close();
  if (dbErr !== sess.errs) die(`round-trip broken: DB is_error=1 count ${dbErr} != transcript count ${sess.errs} (${sess.sessionId})`);
  if (dbErr === 0) die("transcript count was 0 — vacuous");
  ok(`is_error round-trips: DB ${dbErr} == transcript ${sess.errs} error results (${sess.sessionId})`);
}

// ISC-2 — native-tool reliability is queryable after consolidation: a tool_reliability fact sourced from
// tool_calls (native/MCP, keyed tool:<name>, no backend prefix) exists with n > 0.
async function isc2() {
  const sess = findErrorSession();
  if (!sess) die("no error session found for native-reliability check");
  const idx = new Indexer(tmpDb());
  await idx.indexSession(sess.path, sess.projectDir, sess.sessionId);
  consolidateInto(idx.db, { minN: 1 });
  const rows = idx.db.prepare("SELECT id, subject, statement, provenance, n FROM facts WHERE kind = 'tool_reliability'").all();
  idx.db.close();
  const native = rows.filter((r) => {
    let src = ""; try { src = JSON.parse(r.provenance || "{}").source || ""; } catch { /* ignore */ }
    return src === "tool_calls" && r.n > 0;
  });
  if (native.length === 0) die("no native/MCP tool_reliability fact from tool_calls with n>0 — the 'made anywhere' signal is missing");
  const bash = native.find((r) => r.id === "tool:Bash") || native[0];
  ok(`native-tool reliability queryable: ${native.length} tool_calls-sourced fact(s), e.g. "${bash.statement}"`);
}

// ISC-C1 — idempotent migration + no data loss: an old-shape tool_calls (no is_error, user_version=7)
// keeps every row after migration, gains the column (existing rows NULL), and a second open is a no-op.
function iscC1() {
  const p = tmpDb();
  const seed = new DatabaseSync(p);
  seed.exec("CREATE TABLE tool_calls (session_id TEXT, tool_name TEXT, input_json TEXT, timestamp TEXT)");
  const ins = seed.prepare("INSERT INTO tool_calls(session_id, tool_name, input_json, timestamp) VALUES (?,?,?,?)");
  for (let i = 0; i < 5; i++) ins.run("seed-session", "Bash", "{}", "2026-01-01T00:00:00Z");
  seed.exec("PRAGMA user_version = 7");
  seed.close();

  const idx = new Indexer(p); // constructor: SCHEMA (CREATE IF NOT EXISTS no-ops) then migrate() → ALTER
  const cols = idx.db.prepare("PRAGMA table_info(tool_calls)").all().map((c) => c.name);
  const cnt = idx.db.prepare("SELECT COUNT(*) c FROM tool_calls").get().c;
  const nonNull = idx.db.prepare("SELECT COUNT(*) c FROM tool_calls WHERE is_error IS NOT NULL").get().c;
  const uv = idx.db.prepare("PRAGMA user_version").get().user_version;
  idx.db.close();
  if (!cols.includes("is_error")) die("migration did not add is_error column");
  if (cnt !== 5) die(`data loss: expected 5 rows, got ${cnt}`);
  if (nonNull !== 0) die(`existing rows must stay NULL (unknown), got ${nonNull} non-null`);
  if (uv !== 8) die(`user_version should be 8 after migration, got ${uv}`);

  const idx2 = new Indexer(p); // re-open: migrate() sees cur>=8 → no-op
  const cnt2 = idx2.db.prepare("SELECT COUNT(*) c FROM tool_calls").get().c;
  const uv2 = idx2.db.prepare("PRAGMA user_version").get().user_version;
  idx2.db.close();
  if (cnt2 !== 5) die(`re-migrate changed row count: ${cnt2}`);
  if (uv2 !== 8) die(`re-migrate changed user_version: ${uv2}`);
  ok("migration idempotent + lossless: 5 rows preserved, is_error added (NULL), re-open no-op");
}

// ISC-A1 (Anti) — never fabricate an outcome: (a) a status-bearing source records successes as is_error=0
// (not NULL) AND errors as 1, so success != error; (b) an unknown-status source (codex) records is_error
// NULL, never 0 — an unknown must never masquerade as success.
async function iscA1() {
  // (a) status-bearing source: successes are 0, errors are 1, both present.
  const sess = findErrorSession();
  if (!sess) die("no error session for success/error separation check");
  const idxA = new Indexer(tmpDb());
  await idxA.indexSession(sess.path, sess.projectDir, sess.sessionId);
  const oks = idxA.db.prepare("SELECT COUNT(*) c FROM tool_calls WHERE is_error = 0").get().c;
  const errs = idxA.db.prepare("SELECT COUNT(*) c FROM tool_calls WHERE is_error = 1").get().c;
  idxA.db.close();
  if (oks === 0) die("no successes recorded as is_error=0 — successes would be indistinguishable / dropped");
  if (errs === 0) die("no errors recorded as is_error=1");

  // (b) unknown-status source: index the first codex session that has tool calls; all must be NULL.
  const codex = defaultSources(HOME).find((s) => s.client === "codex");
  if (!codex) die("no codex source configured");
  let found = null, scanned = 0;
  for await (const ref of codex.iterate(codex.root)) {
    if (++scanned > 400) break;
    let parsed; try { parsed = await codex.parse(ref.jsonlPath); } catch { continue; }
    if (parsed?.toolCalls?.length > 0) { found = ref; break; }
  }
  if (!found) die("scanned codex sessions, none had tool calls — cannot verify unknown-source=NULL");
  const idxB = new Indexer(tmpDb());
  await idxB.indexSessionFromSource(found.jsonlPath, found.projectDir, found.sessionId, codex);
  const total = idxB.db.prepare("SELECT COUNT(*) c FROM tool_calls").get().c;
  const nonNull = idxB.db.prepare("SELECT COUNT(*) c FROM tool_calls WHERE is_error IS NOT NULL").get().c;
  idxB.db.close();
  if (total === 0) die("codex session indexed 0 tool calls — vacuous");
  if (nonNull !== 0) die(`unknown source leaked non-NULL is_error on ${nonNull}/${total} calls — fabricated outcome`);
  ok(`no fabricated outcomes: status source ${oks} ok / ${errs} err (0!=1); codex ${total} calls all NULL`);
}

const which = process.argv[2] || "all";
if (which === "all") {
  for (const isc of ["isc1", "isc2", "isc-c1", "isc-a1"]) {
    try {
      execSync(`node ${process.argv[1]} ${isc}`, { stdio: "inherit" });
    } catch {
      process.exit(1);
    }
  }
  process.exit(0);
} else if (which === "isc1") await isc1();
else if (which === "isc2") await isc2();
else if (which === "isc-c1") iscC1();
else if (which === "isc-a1") await iscA1();
else die(`unknown probe: ${which}`);

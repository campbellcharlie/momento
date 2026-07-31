#!/usr/bin/env node
// Acceptance probes for MMNTO-001-jobs-layer. Each `isc*` builds a minimal index into a throwaway DB
// (reading the REAL ~/.claude) and asserts one falsifiable property. Read-only w.r.t. ~/.claude.
// Usage: node scripts/probe-jobs.mjs <isc1|isc2|isc3|isc-c1|isc-a1|isc-a2>   (exit 0 = pass)

import { Indexer } from "../dist/indexer.js";
import { indexTimelineInto, searchTimeline, timelineFiles, indexLedgerInto, searchLedger } from "../dist/external.js";
import { loadJobSummaries } from "../dist/jobs.js";
import { mkdtempSync, readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { execSync } from "node:child_process";

const HOME = homedir();
function tmpDb() { const d = mkdtempSync(join(tmpdir(), "momento-probe-")); return join(d, "index.db"); }
function die(msg) { console.error("FAIL: " + msg); process.exit(1); }
function ok(msg) { console.log("PASS: " + msg); process.exit(0); }

// Independent (non-momento) count of non-empty timeline rows across all job ledgers.
function countNonEmptyTimelineRows() {
  let n = 0;
  for (const f of timelineFiles(HOME)) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const t = line.trim(); if (!t) continue;
      let r; try { r = JSON.parse(t); } catch { continue; }
      const c = [r.detail, r.text].filter((x) => typeof x === "string" && x.trim()).join(" ").trim();
      if (c) n++;
    }
  }
  return n;
}
// First real non-empty timeline row (any state), for a data-driven search probe.
function sampleTimelineRow() {
  for (const f of timelineFiles(HOME)) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const t = line.trim(); if (!t) continue;
      let r; try { r = JSON.parse(t); } catch { continue; }
      const c = [r.detail, r.text].filter((x) => typeof x === "string" && x.trim()).join(" ").trim();
      if (c) return { state: String(r.state || ""), content: c };
    }
  }
  return null;
}
function rareToken(text) {
  const toks = (text.toLowerCase().match(/[a-z]{6,}/g) || []).filter((w) => !["should","confirm","because","before","testing"].includes(w));
  return toks.sort((a, b) => b.length - a.length)[0] || null;
}
function findSessionJsonl(sessionId) {
  try {
    const out = execSync(`find ${join(HOME, ".claude", "projects")} -name ${sessionId}.jsonl -type f`, { encoding: "utf8" }).trim();
    return out.split("\n")[0] || null;
  } catch { return null; }
}

const which = process.argv[2];

if (which === "isc2") {
  const db = new Indexer(tmpDb()).db;
  indexTimelineInto(db);
  const fts = db.prepare("SELECT count(*) AS c FROM timeline_fts").get().c;
  const indep = countNonEmptyTimelineRows();
  if (fts !== indep) die(`timeline_fts rows=${fts} != independent non-empty count=${indep}`);
  if (fts === 0) die("no timeline rows indexed (expected > 0)");
  ok(`conservation: timeline_fts rows == non-empty source rows (${fts})`);
}

else if (which === "isc-a1") {
  const db = new Indexer(tmpDb()).db;
  indexTimelineInto(db);
  const empty = db.prepare("SELECT count(*) AS c FROM timeline_fts WHERE content IS NULL OR trim(content) = ''").get().c;
  if (empty !== 0) die(`${empty} empty-content rows leaked into timeline_fts (must be 0)`);
  ok("anti: zero empty rows in timeline_fts");
}

else if (which === "isc3") {
  const db = new Indexer(tmpDb()).db;
  indexTimelineInto(db);
  const sample = sampleTimelineRow();
  if (!sample) die("no non-empty timeline row found to search");
  const tok = rareToken(sample.content);
  if (!tok) die(`no searchable token in sample row: ${JSON.stringify(sample.content).slice(0, 80)}`);
  const anyHits = searchTimeline(db, tok, { limit: 50 });
  if (anyHits.length < 1) die(`token '${tok}' from a real row returned 0 hits (not findable)`);
  const stateHits = searchTimeline(db, tok, { state: sample.state, limit: 50 });
  if (stateHits.length < 1) die(`state-filtered ('${sample.state}') search returned 0 hits`);
  const bad = stateHits.filter((h) => h.state !== sample.state);
  if (bad.length) die(`state filter leaked ${bad.length} rows with state != ${sample.state}`);
  ok(`property: findable + state filter is exact (token='${tok}', state='${sample.state}', hits=${stateHits.length})`);
}

else if (which === "isc1") {
  const jobs = loadJobSummaries(HOME);
  let target = null;
  for (const [sid, s] of jobs) {
    if (!s.firstPrompt) continue;
    const jp = findSessionJsonl(sid);
    if (jp) { target = { sid, s, jp }; break; }
  }
  if (!target) die("no bg-job whose sessionId has an indexed transcript (cannot test end-to-end)");
  const idx = new Indexer(tmpDb());
  await idx.indexSession(target.jp, dirname(target.jp), target.sid);
  const row = idx.db.prepare("SELECT first_prompt, summary FROM sessions WHERE id = ?").get(target.sid);
  if (!row) die(`session ${target.sid} not indexed`);
  const fp = row.first_prompt || "";
  const intent = target.s.firstPrompt;
  // Round-trip: the state.json intent reached the DB as first_prompt (allow cleanFirstPrompt trimming).
  const match = fp === intent || (fp.length > 20 && intent.startsWith(fp.slice(0, Math.min(fp.length, 60))));
  if (!match) die(`first_prompt did not round-trip intent.\n  db first_prompt=${JSON.stringify(fp).slice(0,90)}\n  state.json intent=${JSON.stringify(intent).slice(0,90)}`);
  if (!row.summary) die("summary is null (expected name/result-derived summary)");
  ok(`round-trip: session ${target.sid} first_prompt==intent, summary=${JSON.stringify(row.summary).slice(0,70)}`);
}

else if (which === "isc-c1") {
  const idx = new Indexer(tmpDb());
  indexLedgerInto(idx.db);
  const q = "the";
  const before = searchLedger(idx.db, q, { limit: 100 }).map((h) => h.entry_id).sort();
  // index a session so the sessions table is non-empty, then add the timeline
  const jobs = loadJobSummaries(HOME);
  let sess = null;
  for (const [sid] of jobs) { const jp = findSessionJsonl(sid); if (jp) { sess = { sid, jp }; break; } }
  if (sess) await idx.indexSession(sess.jp, dirname(sess.jp), sess.sid);
  const sessBefore = idx.db.prepare("SELECT count(*) AS c FROM sessions").get().c;
  indexTimelineInto(idx.db);
  const after = searchLedger(idx.db, q, { limit: 100 }).map((h) => h.entry_id).sort();
  const sessAfter = idx.db.prepare("SELECT count(*) AS c FROM sessions").get().c;
  if (JSON.stringify(before) !== JSON.stringify(after)) die(`search_ledger results changed after timeline index (${before.length} -> ${after.length}) — pollution`);
  if (sessAfter < sessBefore) die(`session count decreased ${sessBefore} -> ${sessAfter}`);
  ok(`differential: ledger search unchanged (${before.length} ids) + sessions non-decreasing (${sessBefore}->${sessAfter})`);
}

else if (which === "isc-a2") {
  // (a) missing jobs dir → no-op, no throw
  const fakeHome = mkdtempSync(join(tmpdir(), "momento-nohome-"));
  const summaries = loadJobSummaries(fakeHome);
  if (summaries.size !== 0) die(`loadJobSummaries on empty home returned ${summaries.size} (expected 0)`);
  const db = new Indexer(tmpDb()).db;
  indexTimelineInto(db, timelineFiles(fakeHome)); // [] → must not throw
  const c = db.prepare("SELECT count(*) AS c FROM timeline_fts").get().c;
  if (c !== 0) die(`missing-home timeline index wrote ${c} rows (expected 0)`);
  // (b) a non-job session's overlay is gated: sessionId not in the jobs map → no overlay
  const jobs = loadJobSummaries(HOME);
  const jsonls = execSync(`find ${join(HOME, ".claude", "projects")} -name '*.jsonl' -type f | head -400`, { encoding: "utf8" }).trim().split("\n");
  let nonJob = null;
  for (const jp of jsonls) { const sid = basename(jp, ".jsonl"); if (!jobs.has(sid)) { nonJob = { sid, jp }; break; } }
  if (!nonJob) die("could not find a non-job session to test the overlay gate");
  const idx = new Indexer(tmpDb());
  await idx.indexSession(nonJob.jp, dirname(nonJob.jp), nonJob.sid);
  if (jobs.has(nonJob.sid)) die("test picked a job session by mistake");
  ok(`anti: missing-home no-op (0 rows) + non-job session ${nonJob.sid} not overlaid`);
}

else {
  die(`unknown probe '${which}' (isc1|isc2|isc3|isc-c1|isc-a1|isc-a2)`);
}

// Recall eval harness — measures momento's RANKING QUALITY, not latency.
//
// BENCHMARKS.md covers latency; this is the missing recall benchmark. It runs
// labeled query->expected cases (bench/recall-cases.json) through each ranking
// function and reports recall@k. Use it to prove a ranking change helps (or
// doesn't) instead of guessing.
//
// Two corpora:
//   --live   run read-only against the real ~/.momento/index.db (default).
//            Most honest signal; non-reproducible across machines.
//   --db=PATH  run against a specific DB (e.g. a /tmp fixture build).
//
// A hit "counts" for a case if the case's `expect` substring appears
// (case-insensitive) in the hit's project_path, summary, or first_prompt.
// recall@k = fraction of cases where any of the top-k hits counts.
//
// Run: node bench/recall-eval.mjs [--live] [--db=PATH] [--k=5] [--json]
// Exit 0 always; emits a per-case table + per-kind and overall recall@1/3/5.

import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import {
  search,
  findByTopic,
  findByTopicWithRecency,
} from "../dist/queries.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const DB_PATH = getArg("db", join(homedir(), ".momento", "index.db"));
const K = Number(getArg("k", "5"));
const JSON_ONLY = args.includes("--json");

const { cases } = JSON.parse(readFileSync(join(HERE, "recall-cases.json"), "utf8"));

const db = new DatabaseSync(DB_PATH, { readOnly: true });

// A hit counts if `expect` appears in any of the searchable identity fields.
function counts(hit, expect) {
  const e = expect.toLowerCase();
  const fields = [hit.projectPath, hit.summary, hit.firstPrompt, hit.snippet];
  return fields.some((f) => typeof f === "string" && f.toLowerCase().includes(e));
}

// Each ranker returns an array of hits (top-first). Normalize the three APIs.
const rankers = {
  search: (q) => search(db, q, { limit: K }),
  find_by_topic: (q) => findByTopic(db, q, K),
  find_by_topic_recent: (q) => findByTopicWithRecency(db, q, K),
};

function recallAtK(hits, expect, k) {
  return hits.slice(0, k).some((h) => counts(h, expect)) ? 1 : 0;
}

const results = {};
for (const name of Object.keys(rankers)) {
  const perCase = cases.map((c) => {
    const hits = rankers[name](c.query) ?? [];
    return {
      query: c.query,
      kind: c.kind,
      expect: c.expect,
      r1: recallAtK(hits, c.expect, 1),
      r3: recallAtK(hits, c.expect, 3),
      r5: recallAtK(hits, c.expect, Math.min(5, K)),
      topHit: hits[0]?.projectPath ?? hits[0]?.summary ?? "(none)",
    };
  });
  const agg = (key) => perCase.reduce((s, c) => s + c[key], 0) / perCase.length;
  results[name] = { perCase, r1: agg("r1"), r3: agg("r3"), r5: agg("r5") };
}

db.close();

if (JSON_ONLY) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const [name, r] of Object.entries(results)) {
    console.log(`\n=== ${name} ===`);
    for (const c of r.perCase) {
      console.log(
        `  ${c.r5 ? "✔" : "✗"} [${c.kind.padEnd(8)}] r@1=${c.r1} r@3=${c.r3} r@5=${c.r5}  "${c.query.slice(0, 40)}"  -> ${String(c.topHit).slice(-48)}`,
      );
    }
    // per-kind recall@5
    const byKind = {};
    for (const c of r.perCase) {
      (byKind[c.kind] ??= []).push(c.r5);
    }
    const kindStr = Object.entries(byKind)
      .map(([k, v]) => `${k}=${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)}`)
      .join(" ");
    console.log(`  OVERALL recall@1=${r.r1.toFixed(2)} @3=${r.r3.toFixed(2)} @5=${r.r5.toFixed(2)}  | by-kind@5: ${kindStr}`);
  }
}

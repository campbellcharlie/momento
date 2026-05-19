// Benchmark harness — measures momento's three latency contracts:
//   1. Index ingestion (one session JSONL -> SQLite)
//   2. Query latency (search, find_by_topic, find_by_topic_recent)
//   3. Hook decision latency (cli.js end-to-end via stdin)
//
// Uses the existing test fixtures as a small synthetic corpus. Multiplies
// them up to N sessions so timings have statistical body without requiring
// the operator to have a real ~/.momento DB populated.
//
// Methodology (so numbers can be reproduced or disputed):
//   - Each measurement is N iterations after a 3-iter warmup. Reports
//     p50/p95/p99/max and the iteration count.
//   - Hook decision benchmark spawns the real cli.js binary against the
//     ephemeral DB so it measures process startup + JSON parse + SQLite
//     open + query + decision — the same path Claude Code drives.
//   - Bench writes only to /tmp (mkdtemp) and never touches ~/.momento.
//
// Run: node bench/run.mjs [--sessions=N] [--queries=N] [--hooks=N]
//
// Exit 0 always. Numbers go to stdout as a JSON array under {results: [...]}
// plus a human-readable table. Set BENCH_JSON=1 to suppress the table and
// emit only the JSON (for CI/checked-in comparisons).

import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

import { Indexer } from "../dist/indexer.js";
import { loadConfig } from "../dist/config.js";
import {
  search,
  findByTopic,
  findByTopicWithRecency,
  findByCategory,
} from "../dist/queries.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "..", "test", "fixtures");

// --- arg parse --------------------------------------------------------------

function arg(name, def) {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!m) return def;
  const v = Number(m.split("=")[1]);
  return Number.isFinite(v) ? v : def;
}

const N_SESSIONS = arg("sessions", 200);
const N_QUERIES = arg("queries", 100);
const N_HOOKS = arg("hooks", 40);
const WARMUP = 3;
const JSON_ONLY = process.env.BENCH_JSON === "1";

// --- helpers ----------------------------------------------------------------

function percentile(sortedNums, p) {
  if (sortedNums.length === 0) return 0;
  const idx = Math.min(
    sortedNums.length - 1,
    Math.floor((p / 100) * sortedNums.length),
  );
  return sortedNums[idx];
}

function summarize(label, samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    label,
    n: samplesMs.length,
    p50_ms: round(percentile(sorted, 50)),
    p95_ms: round(percentile(sorted, 95)),
    p99_ms: round(percentile(sorted, 99)),
    max_ms: round(sorted[sorted.length - 1] ?? 0),
  };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

function timeIt(fn) {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

// --- corpus setup -----------------------------------------------------------

// Build N_SESSIONS sessions by replicating the basic fixture into distinct
// project dirs with distinct session IDs. Real-world DBs will be larger and
// the per-session content is small, but this is enough to expose query plan
// shape and the cost of N JOINed rows.
function makeCorpus() {
  const work = mkdtempSync(join(tmpdir(), "momento-bench-"));
  const projects = join(work, "projects");
  mkdirSync(projects, { recursive: true });
  const fixture = readFileSync(join(FIX, "basic-session.jsonl"), "utf8");
  for (let i = 0; i < N_SESSIONS; i++) {
    // Distribute across a handful of project dirs so the index sees more
    // than one project_path (mirrors realistic usage).
    const proj = join(projects, `-tmp-bench-repo-${i % 7}`);
    mkdirSync(proj, { recursive: true });
    const sessionId = `bench-${i.toString().padStart(5, "0")}`;
    // Rewrite the fixture's sessionId so each copy is unique to the indexer.
    const rewritten = fixture.replace(/"sessionId":"[^"]+"/g, `"sessionId":"${sessionId}"`);
    writeFileSync(join(proj, `${sessionId}.jsonl`), rewritten);
  }
  return { work, projects };
}

// --- benchmarks -------------------------------------------------------------

async function benchIngest({ projects, work }) {
  const dbPath = join(work, "index-ingest.db");
  const cfg = loadConfig({ env: {}, ignoreFile: "/nonexistent" });
  const indexer = new Indexer(dbPath, cfg);
  const t = performance.now();
  await indexer.buildAll(projects);
  const elapsedMs = performance.now() - t;
  indexer.close();
  const perSessionMs = elapsedMs / N_SESSIONS;
  return {
    label: "ingest_total",
    sessions: N_SESSIONS,
    total_ms: round(elapsedMs),
    per_session_ms: round(perSessionMs),
  };
}

async function benchQueries({ projects, work }) {
  const dbPath = join(work, "index-query.db");
  const cfg = loadConfig({ env: {}, ignoreFile: "/nonexistent" });
  const indexer = new Indexer(dbPath, cfg);
  await indexer.buildAll(projects);

  // Mix of query shapes: rare term, common term, multi-term, and a category.
  const queries = [
    "rate-limit api client backoff",
    "exponential",
    "api",
    "client",
    "rate",
  ];

  function run(name, fn) {
    // Warmup
    for (let i = 0; i < WARMUP; i++) fn();
    const samples = [];
    for (let i = 0; i < N_QUERIES; i++) {
      const q = queries[i % queries.length];
      samples.push(timeIt(() => fn(q)));
    }
    return summarize(name, samples);
  }

  const results = [
    run("search", (q = queries[0]) => search(indexer.db, q, { limit: 20 })),
    run("find_by_topic", (q = queries[0]) => findByTopic(indexer.db, q, 10)),
    run("find_by_topic_recent", (q = queries[0]) =>
      findByTopicWithRecency(indexer.db, q, 10),
    ),
    run("find_by_category_coding", () =>
      findByCategory(indexer.db, "coding", { limit: 20 }),
    ),
  ];
  indexer.close();
  return results;
}

function benchHookDecision({ projects, work }) {
  const dbPath = join(work, "index-hook.db");
  // The hook reads from a fixed DB path (~/.momento/index.db) by default;
  // build the bench DB there is too invasive. Instead, override MOMENTO_DB
  // via the env. cli.ts checks env override... actually it doesn't yet. So
  // we'll point HOME at a temp dir and put the DB at <home>/.momento/index.db.
  const fakeHome = join(work, "fakehome");
  const fakeMomento = join(fakeHome, ".momento");
  mkdirSync(fakeMomento, { recursive: true });
  // Build the DB at the path cli.ts expects.
  const cfg = loadConfig({ env: {}, ignoreFile: "/nonexistent" });
  const indexer = new Indexer(join(fakeMomento, "index.db"), cfg);
  // Synchronous wait — buildAll returns a Promise. We block via spawnSync below.
  // Easier: use spawnSync's deasync — actually just await above the call site.
  return indexer
    .buildAll(projects)
    .then(() => {
      indexer.close();
      const cliJs = join(HERE, "..", "dist", "cli.js");
      // Realistic prompts that hit the hook path (long enough, not mechanical).
      const prompts = [
        '{"prompt":"how did I configure the rate-limit api client backoff"}',
        '{"prompt":"explore exponential backoff implementations"}',
        '{"prompt":"what was that api flag we set last week"}',
      ];
      // Warmup
      for (let i = 0; i < WARMUP; i++) {
        spawnSync("node", [cliJs], {
          input: prompts[i % prompts.length],
          env: { ...process.env, HOME: fakeHome, MOMENTO_INJECT_DEBUG: "0" },
          stdio: ["pipe", "pipe", "ignore"],
        });
      }
      const samples = [];
      for (let i = 0; i < N_HOOKS; i++) {
        const t = performance.now();
        spawnSync("node", [cliJs], {
          input: prompts[i % prompts.length],
          env: { ...process.env, HOME: fakeHome, MOMENTO_INJECT_DEBUG: "0" },
          stdio: ["pipe", "pipe", "ignore"],
        });
        samples.push(performance.now() - t);
      }
      return summarize("hook_decision_e2e", samples);
    });
}

// --- main -------------------------------------------------------------------

const corpus = makeCorpus();
const ingest = await benchIngest(corpus);
const queries = await benchQueries(corpus);
const hook = await benchHookDecision(corpus);
rmSync(corpus.work, { recursive: true, force: true });

const out = {
  meta: {
    sessions: N_SESSIONS,
    queries_per_op: N_QUERIES,
    hook_iterations: N_HOOKS,
    warmup: WARMUP,
    node_version: process.version,
    platform: `${process.platform}/${process.arch}`,
    when: new Date().toISOString(),
  },
  ingest,
  queries,
  hook,
};

if (JSON_ONLY) {
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
} else {
  process.stdout.write(`momento bench — ${out.meta.sessions} sessions, ${out.meta.platform}, ${out.meta.node_version}\n`);
  process.stdout.write(`\n[ingest]\n`);
  process.stdout.write(`  total:        ${ingest.total_ms} ms\n`);
  process.stdout.write(`  per session:  ${ingest.per_session_ms} ms\n`);
  process.stdout.write(`\n[queries] (p50/p95/p99/max ms, n=${out.meta.queries_per_op})\n`);
  for (const q of queries) {
    process.stdout.write(
      `  ${q.label.padEnd(28)} ${String(q.p50_ms).padStart(7)} / ${String(q.p95_ms).padStart(7)} / ${String(q.p99_ms).padStart(7)} / ${String(q.max_ms).padStart(7)}\n`,
    );
  }
  process.stdout.write(`\n[hook] (p50/p95/p99/max ms, n=${out.meta.hook_iterations})\n`);
  process.stdout.write(
    `  ${hook.label.padEnd(28)} ${String(hook.p50_ms).padStart(7)} / ${String(hook.p95_ms).padStart(7)} / ${String(hook.p99_ms).padStart(7)} / ${String(hook.max_ms).padStart(7)}\n`,
  );
  process.stdout.write(`\nJSON: BENCH_JSON=1 node bench/run.mjs\n`);
}

# Benchmarks

`node bench/run.mjs` measures momento's three latency contracts on a
synthetic corpus built from the bundled test fixtures.

## What is measured

| Bench | What it does |
|---|---|
| `ingest_total` | One-shot `Indexer.buildAll` over N synthetic JSONL files. Reports total and per-session ms. |
| `search` | `search(db, query, {limit:20})` — pure FTS5 with the existing `OR` token expansion. |
| `find_by_topic` | `findByTopic` — the AND-then-OR ranked variant currently driving `find_by_topic` and the hook. |
| `find_by_topic_recent` | `findByTopicWithRecency` — RRF fusion of BM25 + recency lane. |
| `find_by_category_coding` | `findByCategory("coding")` — joins `turn_categories` + `sessions`. |
| `hook_decision_e2e` | `node dist/cli.js` spawned with a JSON prompt on stdin, against an isolated `$HOME/.momento/index.db`. Measures process startup + JSON parse + SQLite open + query + decision — the full path Claude Code drives. |

## Methodology

- Each query bench runs `WARMUP=3` iterations then `N_QUERIES` measured iterations cycling through 5 query shapes (rare term, common term, multi-term, etc.).
- Hook bench spawns the real `dist/cli.js` binary; no in-process shortcut.
- Each bench builds its own ephemeral DB under `/tmp/momento-bench-*`. **Bench never touches `~/.momento`.**
- Numbers are reported as p50 / p95 / p99 / max in milliseconds.

## Caveats

- The bench corpus replicates one small fixture N times. Real-world sessions are larger and more varied — expect ingest per-session and query p99 to be larger on real DBs (a real DB with thousands of multi-MB transcripts will see ingest in the 10s of ms per session, not sub-ms).
- The bench does **not** measure recall accuracy. It measures latency only. A recall benchmark requires labeled queries against a labeled corpus — see the "future" section.
- `hook_decision_e2e` includes Node startup (~50–80 ms). The in-process query work alone is sub-millisecond per the `find_by_topic` row.

## Run it

```sh
npm run bench                                       # defaults: 200 sessions, 100 queries, 40 hooks
node bench/run.mjs --sessions=500 --queries=200     # larger corpus
BENCH_JSON=1 node bench/run.mjs                     # JSON only (for CI / diffing)
```

## Sample results

Captured on `darwin/arm64`, Node v25, MacBook Air M2, 100 sessions / 50 queries / 10 hooks:

```
[ingest]
  total:        91.66 ms
  per session:  0.917 ms

[queries] (p50/p95/p99/max ms, n=50)
  search                         0.245 /   0.652 /   0.669 /   0.669
  find_by_topic                  0.453 /   0.923 /   0.943 /   0.943
  find_by_topic_recent           0.864 /   1.512 /   1.585 /   1.585
  find_by_category_coding        0.043 /   0.048 /   0.055 /   0.055

[hook] (p50/p95/p99/max ms, n=10)
  hook_decision_e2e             80.572 /  84.857 /  84.857 /  84.857
```

The hook's p99 of ~85 ms is well under the 200 ms hard cap in `cli.ts`. The
RRF recency lane (`find_by_topic_recent`) costs roughly 2× `find_by_topic`
because it joins three lanes via `ROW_NUMBER() OVER (...)`; still
sub-2-ms at this scale.

## Future

Latency-only benchmarks confirm that momento doesn't blow its budgets. They
don't validate that it surfaces *the right* sessions. A recall@k harness
against a labeled query corpus is the next step — same format as this
script, different inner loop. Track:

- recall@10 for each query class (rare-term, common-term, multi-term)
- false-injection rate (hook decides `inject` when no relevant session exists)
- false-skip rate (hook decides `no_hits` / `low_confidence` when one does)

The fixture corpus is too small to do this meaningfully today; building a
labeled query corpus is a separate piece of work.

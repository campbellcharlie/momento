<div align="center">

# ⟲ momento

**Searchable memory for coding-agent CLIs — recall what prior sessions actually discussed and edited, across every tool.**

![mission](https://img.shields.io/badge/mission-recall_past_agent_sessions-7d3cff)
![license](https://img.shields.io/badge/license-MIT-green)
![runtime](https://img.shields.io/badge/runtime-Node_24+-black)
![indexes](https://img.shields.io/badge/indexes-Claude_Code·Codex·Gemini-blue)
![exposes](https://img.shields.io/badge/exposes-MCP_server-orange)

[What & Why](#what--why) · [Philosophy](#philosophy) · [Measurement](#measurement) · [Quickstart](#quickstart) · [Tools](#tools) · [Privacy](#privacy) · [Layout](#layout)

</div>

---

## What & Why

Coding-agent CLIs keep useful local history — but it's siloed by client, machine, launch directory, and hashed project IDs. Simple questions get hard:

- Which session actually edited *this* repo?
- What did I call that workaround last week?
- Did that happen in Claude Code, Codex, or Gemini?

**momento** unifies it. It indexes local transcripts from **Claude Code, Codex, and Gemini** into one searchable SQLite index, records the files each session actually *touched*, and lets the next session query all of it on demand.

```text
> the user asks: "what was that flag for the API rate-limit hack?"
< momento surfaces 3 prior sessions that edited /src/api/, with snippets.
< the agent continues with full context — no scrolling, no re-explaining.
```

Two pieces:

1. **MCP server** — `search`, `find_by_topic`, `get_recent_by_edited_path`, and more (see [Tools](#tools)). Any MCP client queries the shared index on demand.
2. **`momento-inject` CLI** — a one-line `UserPromptSubmit` hook that auto-injects relevant past sessions into every new prompt. Hard-capped at 200 ms, conservative by design.

Coverage is whatever each client retained on disk — clear `~/.claude/projects/`, `~/.codex/sessions/`, or `~/.gemini/tmp` and those sessions aren't recoverable there. Two prod deps (`chokidar`, `zod`), no native bindings, Node 24+ built-in `node:sqlite`.

## Philosophy

> **Past context should be one query away — not re-explained every session.**

An agent that can't recall what it already learned pays the cost twice. momento's job is to make prior work *retrievable at decision time*, across every CLI, without anyone scrolling old transcripts.

> Be honest about the retrieval; be conservative about the injection.

Two disciplines follow. Search is **keyword (BM25), not semantic** — synonyms won't match, so the tools *say so* instead of pretending. And the auto-inject hook **skips** short, mechanical, or low-confidence prompts rather than pad context with noise. A recall tool that cries wolf gets ignored.

## Measurement

The **mechanism is verified**: indexing, the query tools, exclusions, and the admin surface are covered by Node's built-in test runner (`npm test` → `tsc` + `node --test` over fixtures).

Whether recall **improves agent outcomes** is the open question — and momento ships the harness to answer it rather than assert it: a recall-eval benchmark (`bench/`, [`BENCHMARKS.md`](BENCHMARKS.md)) scores retrieval against labeled cases, and the inject hook logs its own decisions (`MOMENTO_INJECT_DEBUG=1` → `~/.momento/inject.log`: parsed prompt, top-hit scores, inject/skip reason). Treat any "it helps" claim as a hypothesis until the benchmark cites a number.

## Quickstart

Requires **Node 24+** (built-in `node:sqlite`, stable in 24, flag-gated in 22).

```sh
git clone https://github.com/campbellcharlie/momento.git ~/src/momento
cd ~/src/momento
npm install && npm run build
npm link                 # optional: exposes `momento` + `momento-inject` globally

./bin/momento-install    # idempotently merge the MCP server + auto-inject hook into ~/.claude/settings.json
```

`momento-install` dedupes by command-string, preserves your existing `mcpServers`/`hooks`, writes a `.bak`, and records install metadata under `~/.claude/state/`. Flags: `--no-hook` (MCP only), `--no-mcp` (hook only), `--dry-run` (print the planned settings without writing).

<details>
<summary><strong>Manual config (any MCP client)</strong></summary>

The MCP server is client-agnostic — point your client at `dist/server.js`. For Claude Code, merge by hand into `~/.claude/settings.json` (preserve existing entries):

```json
{
  "mcpServers": {
    "momento": { "command": "node", "args": ["/abs/path/to/momento/dist/server.js"] }
  },
  "hooks": {
    "UserPromptSubmit": [
      { "command": "node /abs/path/to/momento/dist/cli.js" }
    ]
  }
}
```
</details>

## Tools

All tools return JSON. Sessions from `get_recent`, `get_project`, and `get_recent_by_edited_path` include `topEditedPaths` — the top 5 repo dirs the session wrote/edited through **native** write/edit tools, bucketed under `MOMENTO_SRC_ROOTS` (colon-separated, defaults to `~/src`).

| Tool | Inputs | Returns |
|---|---|---|
| `search` | `query: string`, `limit?=20`, `project_path?` | `[{ sessionId, projectPath, summary, snippet, role, score }]` |
| `get_project` | `project_path: string` | `Session[]` |
| `find_by_topic` | `description: string`, `limit?=10` | `Session[]` ranked by BM25 keyword overlap. **Not semantic** — synonyms won't match. |
| `find_similar` | *(deprecated alias for `find_by_topic`)* | same as above |
| `get_recent` | `n?=20`, `project_path?` | `Session[]` (modified desc) |
| `files_touched` | `pattern: string` (SQL `LIKE`) | `[{ sessionId, filePath, operation, source, projectPath, summary }]` |
| `get_recent_by_edited_path` | `path: string` (prefix), `n?=20` | `Session[]` whose **native** write/edit touches start with `path` |
| `aggregate_ledger` | `module?`, `stack?` (filters) | Rollup **numbers** (not transcripts) over [ISE](https://github.com/campbellcharlie/ISE) task-closure ledgers: `idea_quality` (outcomes by persona × stack × class) + `harness_health`. |

<details>
<summary><strong>A <code>Session</code> row</strong></summary>

```json
{
  "id": "240abb0b-...",
  "projectPath": "/Users/you/.claude/projects/-Users-you-src-myrepo",
  "summary": null,
  "firstPrompt": "fix the indexer bug",
  "created": "2026-05-08T00:23:11.692Z",
  "modified": "2026-05-08T07:28:13.268Z",
  "messageCount": 223,
  "jsonlPath": "/Users/you/.claude/projects/.../240abb0b-....jsonl",
  "topEditedPaths": ["/Users/you/src/myrepo", "/Users/you/src/momento"]
}
```
</details>

<details>
<summary><strong><code>momento-inject</code> CLI (the hook)</strong></summary>

Reads a prompt from stdin (or argv) and prints the top 3 prior sessions whose summary/first-prompt resembles it, formatted for a prompt hook:

```
<!-- momento: relevant past sessions -->
- [myrepo] fix the indexer bug (2026-05-08) - 240abb0b-...
```

Hard-capped at 200 ms; opens the DB read-only; silent on error; skips short/mechanical/low-confidence prompts. `MOMENTO_INJECT_DEBUG=1` appends JSONL traces to `~/.momento/inject.log`.
</details>

## Privacy

These transcripts can contain everything you and the model wrote — prompts, file contents, tool inputs, sometimes internal reasoning. momento indexes that into a local SQLite DB at `~/.momento/index.db`. **Nothing leaves your machine**, but the index is a centralized, full-text-searchable copy of your agent history — treat it accordingly.

Defaults err toward less indexing:

- **Assistant `thinking` blocks are not indexed by default** (opt in with `MOMENTO_INDEX_THINKING=1`).
- **Project / path exclusions** keep sensitive repos out of the index entirely — via env (`MOMENTO_EXCLUDE_PROJECTS`, `MOMENTO_EXCLUDE_PATHS`) or a `~/.momentoignore` file.

momento does **not** redact secrets from message text — substring scrubbers miss custom formats and create false confidence. If a repo might contain secrets, exclude it.

<details>
<summary><strong>Exclusion pattern syntax + admin commands</strong></summary>

`~/.momentoignore` — one pattern per line; a `project:` prefix filters project dirs, others filter file paths; `#` starts a comment; a leading `!` re-includes.

```text
**/secrets/**          # any path containing a secrets/ segment
/Users/me/private/*    # absolute prefix; only files directly under it
*.env                  # any path component named *.env
client-*               # any component starting with client-
!**/secrets/public/**  # negation: re-include this subtree
```

Globs: `**` (any segments), `*` (no `/`), `?` (one non-`/` char), `[abc]` (class). Patterns with no glob metacharacters fall back to substring match (older configs keep working). **Exclusions apply at index time** — after editing env vars or `~/.momentoignore`, run `momento --rebuild`.

```sh
momento --status                        # session count, db size, exclusions in effect
momento --doctor                        # validate node version, roots, db (exit 1 warn / 2 fail)
momento --rebuild                       # wipe index.db + re-index from the configured client roots
momento --explain-exclusions [<path>]   # list active rules, or trace which match a path (exit 1 if excluded)
```
</details>

<details>
<summary><strong>Troubleshooting</strong></summary>

- **Stale / out-of-sync results:** `momento --rebuild` (or `rm ~/.momento/index.db` + restart the MCP server).
- **Edits stored under non-canonical paths:** the indexer canonicalizes via `realpath` going forward; `momento --rebuild` fixes pre-existing rows.
- **`topEditedPaths` is empty:** the session only edited files outside `MOMENTO_SRC_ROOTS` — add the relevant root, restart, and re-index.
</details>

## Layout

```
momento/
  src/
    server.ts       ← MCP server (the query tools)
    cli.ts          ← momento-inject (UserPromptSubmit hook)
    admin.ts        ← momento CLI: --status / --doctor / --rebuild / --explain-exclusions
    indexer.ts      ← builds the SQLite index from the client sources
    sources.ts      ← per-client transcript roots (claude_code / codex / gemini)
    parser.ts codex.ts gemini.ts   ← per-client transcript parsers
    queries.ts      ← search / recency / edited-path queries (FTS5 + bucketing)
    ledger.ts       ← aggregate_ledger over ISE ledgers (~/.ise)
    config.ts classifier.ts fuzzy.ts synonyms.ts   ← exclusions + inject scoring
    web/            ← local web UI (events / routes / watcher)
  bin/momento-install   ← idempotent settings.json merge
  bench/                ← recall-eval harness (recall-cases.json + run.mjs)
  test/                 ← node --test suites over test/fixtures/
```

The index and state live in `~/.momento` (`index.db`) — never in the repo.

## License

[MIT](LICENSE) © 2026 Charlie Campbell

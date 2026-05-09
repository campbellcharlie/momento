# momento

**Searchable memory for Claude Code.** Indexes the transcripts Claude Code keeps
under `~/.claude/projects/` and lets you query them by what each session
actually edited — from inside the next conversation.

```text
> the user asks: "what was that flag for the API rate-limit hack?"
< momento surfaces 3 prior sessions that edited /src/api/, with snippets.
< claude continues with full context — no scrolling, no re-explaining.
```

Two pieces:
- **MCP server** — `search`, `find_by_topic`, `get_recent_by_edited_path`, etc.
- **`momento-inject` CLI** — one-line `UserPromptSubmit` hook that auto-injects
  relevant past sessions into every new prompt. Hard-capped at 200 ms.

Coverage is whatever Claude Code has retained on disk. If you've cleared
`~/.claude/projects/` or never ran Claude Code from a given machine, those
sessions aren't recoverable.

## The problem

Claude Code stores transcripts under a per-project directory keyed by the **launch
directory**. Launch in repo A, edit files across A, B, and C — only repo A's history
remembers. Cross-repo work disappears. So does anything you did 30 days ago.

## What momento does

- Indexes every transcript under `~/.claude/projects/` into SQLite with FTS5.
- Records the actual file touches inside each session — find sessions by what
  they *edited*, not where Claude was launched.
- Exposes 6 MCP tools so Claude can query its own past on demand.
- Optional `UserPromptSubmit` hook that surfaces the 3 most-relevant past sessions
  before each prompt — Claude walks in pre-loaded.

Two prod deps (`chokidar`, `zod`). No native bindings. Node 24+ with built-in
`node:sqlite`.

## Install

```sh
npm install
npm run build
npm link  # optional, exposes `momento` and `momento-inject` globally
```

> **Node 24+** is required — uses built-in `node:sqlite` (stable in 24, flag-gated in 22).

## Configure Claude Code

Merge into `~/.claude/settings.json` (don't overwrite — preserve any existing
`mcpServers` / `hooks` entries):

```json
{
  "mcpServers": {
    "momento": { "command": "node", "args": ["/abs/path/to/momento/dist/server.js"] }
  }
}
```

## Optional: auto-injection

Merge a `UserPromptSubmit` hook into the same `settings.json` to surface
relevant past sessions:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "command": "node /abs/path/to/momento/dist/cli.js" }
    ]
  }
}
```

## Tools

All tools return JSON. Sessions returned by `get_recent`, `get_project`, and
`get_recent_by_edited_path` include `topEditedPaths`: the top 5 repo directories
the session actually wrote/edited, bucketed under `MOMENTO_SRC_ROOTS`
(colon-separated; defaults to `~/src`). Set this env var if your repos live
elsewhere.

| Tool | Inputs | Returns |
|---|---|---|
| `search` | `query: string`, `limit?: number=20`, `project_path?: string` | `[{ sessionId, projectPath, summary, snippet, role, score }]` |
| `get_project` | `project_path: string` | `Session[]` |
| `find_by_topic` | `description: string`, `limit?: number=10` | `Session[]` ranked by BM25 keyword overlap. **Not semantic** — synonyms won't match. |
| `find_similar` | (deprecated alias for `find_by_topic`) | same as above |
| `get_recent` | `n?: number=20`, `project_path?: string` | `Session[]` (modified desc) |
| `files_touched` | `pattern: string` (SQL `LIKE`) | `[{ sessionId, filePath, operation, ts }]` |
| `get_recent_by_edited_path` | `path: string` (prefix), `n?: number=20` | `Session[]` whose write/edit touches start with `path` |

A `Session` row looks like:

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

## CLI: `momento-inject`

Reads a prompt from stdin (or argv) and prints the top 3 prior sessions whose
summary/first_prompt resembles it, formatted for a `UserPromptSubmit` hook:

```
<!-- momento: relevant past sessions -->
- [myrepo] fix the indexer bug (2026-05-08) - 240abb0b-...
```

Hard-capped at 200 ms; opens the DB read-only; silent on error. Safe to wire
into hooks without blocking the prompt.

## Privacy

Claude Code transcripts contain everything you (and the model) wrote: prompts,
file contents, tool inputs, internal reasoning. momento indexes that into a
local SQLite DB at `~/.momento/index.db`. Nothing leaves your machine, but the
index is by definition a centralized, full-text-searchable copy of your
conversation history. Treat it accordingly.

Defaults err toward less indexing:

- **Assistant `thinking` blocks are not indexed by default.** Internal model
  deliberation often references things the user never saw and can leak details
  that aren't in the final reply. Set `MOMENTO_INDEX_THINKING=1` to opt in.
- **Project / path exclusions** keep sensitive repos and paths out of the index
  entirely. Two ways to configure:
  - Env: `MOMENTO_EXCLUDE_PROJECTS=client-foo:internal-bar`,
    `MOMENTO_EXCLUDE_PATHS=/Users/you/src/secrets`. Both take colon- or
    comma-separated patterns.
  - File: `~/.momentoignore`. One pattern per line. Lines beginning with
    `project:` filter project directories, others filter file paths. Lines
    beginning with `#` are comments. A leading `!` re-includes a previously
    excluded path.

  Pattern syntax (gitignore-ish, with absolute-path semantics):

  ```text
  **/secrets/**          # any path containing a `secrets/` segment
  /Users/me/private/*    # absolute prefix; only files directly under it
  *.env                  # any single path component named *.env
  client-*               # any path component starting with `client-`
  !**/secrets/public/**  # negation: re-include this subtree
  ```

  Glob characters: `**` (any number of path segments), `*` (no `/`), `?`
  (single non-`/` char), `[abc]` (character class). Patterns with no glob
  metacharacters fall back to plain substring match for backward
  compatibility, so configs from earlier momento versions keep working.

  **Exclusions only apply at index time.** They filter what gets written into
  `~/.momento/index.db`. After editing your env vars or `~/.momentoignore`,
  run `momento --rebuild` so already-indexed sessions are reprocessed under
  the new rules.

momento does **not** redact secrets out of message text. Substring-based
scrubbers miss anything custom and create a false sense of safety; if a repo or
project might contain secrets you don't want indexed, exclude it.

## Admin commands

```sh
momento --status                          # session count, db size, exclusions in effect
momento --doctor                          # validate node version, projects root, db readability
momento --rebuild                         # wipe index.db and re-index from ~/.claude/projects/
momento --explain-exclusions              # list active exclusion rules + their source
momento --explain-exclusions <path>       # trace which rule(s) match a given path
momento --help
```

- `--doctor` exits non-zero on warnings (1) or failures (2) for use in scripts.
- `--explain-exclusions <path>` exits 1 if the path would be excluded, 0 otherwise.
  Useful for sanity-checking a `.momentoignore` change before running `--rebuild`:

  ```sh
  momento --explain-exclusions /Users/me/src/secrets/keys.env
  # ...
  # against path rules:
  #   /Users/me/personal     (no match)
  #   **/secrets/**          EXCLUDE     [/Users/me/.momentoignore]
  #   !**/secrets/public/**  (no match)
  #   → EXCLUDED by rule 2
  # verdict: EXCLUDED
  ```

## Troubleshooting

- **Stale results / out-of-sync DB:** `momento --rebuild` (or `rm ~/.momento/index.db`
  and restart the MCP server).
- **Edits stored under non-canonical paths** (e.g. `/Users/you/src/...` when the
  canonical path is `/Volumes/.../src/...`): the indexer canonicalizes via
  `realpath` going forward, but pre-existing rows aren't rewritten. A
  `momento --rebuild` fixes them.
- **`topEditedPaths` is empty:** the session only edited files outside
  `MOMENTO_SRC_ROOTS`. Add the relevant root, restart, and re-index.

## Index location

`~/.momento/index.db` — SQLite. Delete (or `momento --rebuild`) to force a full
rebuild.

## Tests

```sh
npm test
```

Runs `tsc` then `node --test` against fixtures under `test/fixtures/`. No extra
dependencies — uses Node's built-in test runner.

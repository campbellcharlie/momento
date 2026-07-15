# momento

**Searchable memory for coding-agent CLIs.** Indexes local transcripts from
Claude Code, Codex, and Gemini, then lets the next session query what prior
sessions actually discussed and edited.

```text
> the user asks: "what was that flag for the API rate-limit hack?"
< momento surfaces 3 prior sessions that edited /src/api/, with snippets.
< the agent continues with full context — no scrolling, no re-explaining.
```

Two pieces:
- **MCP server** — `search`, `find_by_topic`, `get_recent_by_edited_path`, etc.
- **`momento-inject` CLI** — one-line `UserPromptSubmit` hook that auto-injects
  relevant past sessions into every new prompt. Hard-capped at 200 ms.

Coverage is whatever each client has retained on disk. If you've cleared
`~/.claude/projects/`, `~/.codex/sessions/`, or `~/.gemini/tmp` on a given
machine, those sessions aren't recoverable there.

## The problem

Coding-agent CLIs keep useful local history, but it is siloed by client,
machine, launch directory, or hashed project IDs. That makes it hard to answer
simple questions like:

- Which session actually edited this repo?
- What did I call that workaround last week?
- Did this happen in Claude Code, Codex, or Gemini?

## What momento does

- Indexes transcripts from:
  - Claude Code: `~/.claude/projects/`
  - Codex: `~/.codex/sessions/`
  - Gemini: `~/.gemini/tmp/`
- Records file touches inside each session so you can query by what a session
  actually edited, not only where the client was launched.
- Exposes 6 MCP tools so any client can query the shared index on demand.
- Ships an optional `momento-inject` hook that can pre-load relevant history
  before a prompt. It is intentionally conservative and will skip low-signal or
  mechanical prompts.

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

One-shot installer that idempotently merges both the MCP server and the
auto-injection hook into `~/.claude/settings.json`. Re-runs are safe (entries
deduped by command-string match) and existing unrelated `mcpServers` /
`hooks` entries are preserved.

```sh
./bin/momento-install              # install both
./bin/momento-install --no-hook    # MCP server only
./bin/momento-install --no-mcp     # auto-inject hook only
./bin/momento-install --dry-run    # print planned settings.json without writing
```

A `.bak` of the prior settings is written next to the file before each save,
and install metadata is recorded at `~/.claude/state/momento-installed`.

### Manual config (other clients)

The MCP server is client-agnostic: point your client at `dist/server.js`.
For Claude Code, merge by hand into `~/.claude/settings.json` — preserve
any existing `mcpServers` / `hooks` entries:

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

## Tools

All tools return JSON. Sessions returned by `get_recent`, `get_project`, and
`get_recent_by_edited_path` include `topEditedPaths`: the top 5 repo directories
the session actually wrote/edited through **native write/edit tools**, bucketed under `MOMENTO_SRC_ROOTS`
(colon-separated; defaults to `~/src`). Set this env var if your repos live
elsewhere.

| Tool | Inputs | Returns |
|---|---|---|
| `search` | `query: string`, `limit?: number=20`, `project_path?: string` | `[{ sessionId, projectPath, summary, snippet, role, score }]` |
| `get_project` | `project_path: string` | `Session[]` |
| `find_by_topic` | `description: string`, `limit?: number=10` | `Session[]` ranked by BM25 keyword overlap. **Not semantic** — synonyms won't match. |
| `find_similar` | (deprecated alias for `find_by_topic`) | same as above |
| `get_recent` | `n?: number=20`, `project_path?: string` | `Session[]` (modified desc) |
| `files_touched` | `pattern: string` (SQL `LIKE`) | `[{ sessionId, filePath, operation, source, projectPath, summary }]` |
| `get_recent_by_edited_path` | `path: string` (prefix), `n?: number=20` | `Session[]` whose **native** write/edit touches start with `path` |

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
summary/first_prompt resembles it, formatted for a prompt hook:

```
<!-- momento: relevant past sessions -->
- [myrepo] fix the indexer bug (2026-05-08) - 240abb0b-...
```

Hard-capped at 200 ms; opens the DB read-only; silent on error. It skips short,
mechanical, and low-confidence prompts rather than injecting noisy context.

Set `MOMENTO_INJECT_DEBUG=1` to append JSONL debug traces to
`~/.momento/inject.log`. This records the parsed prompt, token count, top hit
scores, and inject/skip reason.

## Privacy

These transcripts can contain everything you and the model wrote: prompts, file
contents, tool inputs, and sometimes internal reasoning. momento indexes that
into a local SQLite DB at `~/.momento/index.db`. Nothing leaves your machine,
but the index is still a centralized, full-text-searchable copy of your local
agent history. Treat it accordingly.

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
momento --rebuild                         # wipe index.db and re-index from the configured client roots
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
  canonical path is `/abs/path/src/...`): the indexer canonicalizes via
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

# momento

MCP server that indexes Claude Code conversation history (`~/.claude/projects/`) into
SQLite and lets Claude query it. Plus an opt-in CLI that auto-injects relevant past
context into new sessions.

## Why

Claude Code stores transcripts under a per-project directory keyed by the **launch
directory**. If you launch in repo A but edit files in repos A, B, and C, only repo A
sees the session. momento closes that gap: it indexes the actual file touches inside
each transcript, so "find sessions that edited repo B" works regardless of where
Claude was launched.

## Install

```sh
npm install
npm run build
npm link  # optional, to use `momento` and `momento-inject` globally
```

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
| `find_similar` | `description: string`, `limit?: number=10` | `Session[]` (best matches by summary/first_prompt) |
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

## Troubleshooting

- **Stale results / out-of-sync DB:** `rm ~/.momento/index.db` and restart the MCP
  server. It rebuilds from `~/.claude/projects/` on first run.
- **Edits stored under non-canonical paths** (e.g. `/Users/you/src/...` when the
  canonical path is `/Volumes/.../src/...`): the indexer canonicalizes via
  `realpath` going forward, but pre-existing rows aren't rewritten. A wipe-and-
  rebuild fixes them, or run a one-shot SQL `UPDATE` on `file_touches.file_path`.
- **`topEditedPaths` is empty:** the session only edited files outside
  `MOMENTO_SRC_ROOTS`. Add the relevant root, restart, and re-index.

## Index location

`~/.momento/index.db` — SQLite. Delete to force full rebuild.

#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { Indexer, defaultSources } from "./indexer.js";
import { search, getProject, findByTopic, getRecent, filesTouched, getRecentByEditedPath, findByCategory, sessionCategoryBreakdown, findByTopicWithRecency } from "./queries.js";
import { aggregateLedger } from "./ledger.js";
import { searchLedger, searchAudit, indexExternalFast } from "./external.js";
import { ALL_CATEGORIES } from "./classifier.js";
import { runRebuild, runStatus, runDoctor, runExplainExclusions, defaultPaths } from "./admin.js";
import { startWebServer } from "./web/server.js";
import { formatToolResult } from "./format.js";

const HOME = homedir();
const DB_DIR = join(HOME, ".momento");
const DB_PATH = join(DB_DIR, "index.db");

mkdirSync(DB_DIR, { recursive: true });

// Admin subcommands run-and-exit; the MCP server loop never starts.
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(
    [
      "Usage: momento [--rebuild | --status | --doctor | --explain-exclusions [PATH] | --web [--port N]]",
      "",
      "  No flags                     Run the MCP server over stdio (default).",
      "  --rebuild                    Wipe and re-index all sessions from the configured client roots.",
      "  --status                     Print index stats (sessions, db size, exclusions in effect).",
      "  --doctor                     Diagnose installation; non-zero exit on warnings/failures.",
      "  --explain-exclusions [PATH]  List active exclusion rules. Pass a path to trace which",
      "                               rule(s) match it; exits 1 if the path would be excluded.",
      "  --web [--port N]             Serve the local read-only web UI on 127.0.0.1:N (default 8765).",
      "",
      "Env: MOMENTO_INDEX_THINKING=1 to index assistant thinking blocks (off by default).",
      "     MOMENTO_EXCLUDE_PROJECTS, MOMENTO_EXCLUDE_PATHS — colon/comma-separated patterns.",
      "     ~/.momentoignore — one gitignore-style glob per line; prefix with `project:` to filter projects.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}
if (argv.includes("--version")) {
  process.stdout.write("momento 0.1.0\n");
  process.exit(0);
}
if (argv.includes("--rebuild")) {
  await runRebuild(defaultPaths()).catch((err: Error) => {
    process.stderr.write(`momento: rebuild failed: ${err.message}\n`);
    process.exit(2);
  });
  process.exit(0);
}
if (argv.includes("--status")) {
  runStatus(defaultPaths());
  process.exit(0);
}
if (argv.includes("--doctor")) {
  process.exit(runDoctor(defaultPaths()));
}
{
  // Allow `--explain-exclusions` with or without a path argument. The path,
  // if present, is the next non-flag token after the flag itself.
  const idx = argv.indexOf("--explain-exclusions");
  if (idx >= 0) {
    const target = argv.slice(idx + 1).find((a) => !a.startsWith("-"));
    process.exit(runExplainExclusions(defaultPaths(), target));
  }
}
if (argv.includes("--web")) {
  // Parse --port N (defaults to 8765) and --host (defaults to 127.0.0.1; the
  // server itself refuses any non-loopback host).
  const portIdx = argv.indexOf("--port");
  const port = portIdx >= 0 && argv[portIdx + 1] ? Number(argv[portIdx + 1]) : 8765;
  const hostIdx = argv.indexOf("--host");
  const host = hostIdx >= 0 && argv[hostIdx + 1] ? argv[hostIdx + 1] : "127.0.0.1";
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    process.stderr.write(`momento: invalid --port: ${argv[portIdx + 1]}\n`);
    process.exit(2);
  }
  startWebServer({ dbPath: DB_PATH, host, port })
    .then((handle) => {
      process.stdout.write(
        `momento web: listening on http://${handle.host}:${handle.port} (read-only, loopback only)\n`,
      );
      const stop = (): void => {
        handle.close().finally(() => process.exit(0));
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    })
    .catch((err: Error) => {
      process.stderr.write(`momento web: ${err.message}\n`);
      process.exit(2);
    });
  // The web server keeps the event loop alive; don't fall through to MCP.
} else {

const indexer = new Indexer(DB_PATH);
const SOURCES = defaultSources(HOME);

const sessionCount = (indexer.db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number }).n;
if (sessionCount === 0) {
  indexer.buildAllSources(SOURCES).catch((err) =>
    process.stderr.write(`momento: background build failed: ${err.message}\n`),
  );
}
indexer.watchSources(SOURCES);

const TOOLS = [
  {
    name: "search",
    description: "BM25 full-text search across all indexed message content. Returns ranked snippets. KEYWORD-ONLY — synonyms and paraphrases will not match. Prefer rare/unique terms (codenames, hostnames, library names) over broad ones; if a query misses, retry with different vocabulary before concluding the data is absent. Each hit carries a `why`/`whyText` provenance block (matched terms, field, project match, bm25 score).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (FTS5 syntax tolerated)" },
        limit: { type: "number", description: "Max hits to return", default: 20 },
        project_path: { type: "string", description: "Optional: restrict to one project path" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_project",
    description: "List all sessions for a project path with summaries and counts.",
    inputSchema: {
      type: "object",
      properties: { project_path: { type: "string" } },
      required: ["project_path"],
    },
  },
  {
    name: "find_by_topic",
    description:
      "Keyword/BM25 ranking over session summaries and message contents. Returns past sessions whose text overlaps the given description. NOT semantic similarity — synonyms won't match. If a topic search misses, retry `search` with rarer/domain-specific terms (codenames, hostnames, error strings) rather than concluding the topic isn't indexed. Each result carries a `why`/`whyText` provenance block (matchType and/or, matched terms, field, score).",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string" },
        limit: { type: "number", default: 10 },
      },
      required: ["description"],
    },
  },
  {
    // Kept for back-compat with hooks/configs that still call `find_similar`.
    // Prefer `find_by_topic` — same behavior, more accurate name.
    name: "find_similar",
    description: "Deprecated alias for `find_by_topic`.",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string" },
        limit: { type: "number", default: 10 },
      },
      required: ["description"],
    },
  },
  {
    name: "find_by_topic_recent",
    description:
      "Same keyword search as find_by_topic but fuses a recency lane via Reciprocal Rank Fusion. Recent sessions among relevant matches rank higher; irrelevant fresh sessions are not surfaced (recency only re-ranks within BM25 candidates). Use when there are likely several near-equally-relevant past sessions and the most recent is more useful (e.g. 'how did I configure X' where the answer evolved).",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string" },
        limit: { type: "number", default: 10 },
      },
      required: ["description"],
    },
  },
  {
    name: "get_recent",
    description: "Most recently modified sessions, optionally scoped to a project.",
    inputSchema: {
      type: "object",
      properties: {
        n: { type: "number", default: 20 },
        project_path: { type: "string" },
      },
    },
  },
  {
    name: "files_touched",
    description: "Sessions that read, wrote, or edited a file path matching the given pattern (LIKE). Results include `source` so callers can distinguish native file tools from inferred touches.",
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
  },
  {
    name: "get_recent_by_edited_path",
    description:
      "Most recently modified sessions whose native write/edit touches fall under the given path prefix. Use this to find sessions that actually edited a repo, regardless of where the client was launched.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path prefix to match against edited file paths" },
        n: { type: "number", default: 20 },
      },
      required: ["path"],
    },
  },
  {
    name: "find_by_category",
    description:
      "Sessions that contain at least one turn classified as the given category. Deterministic classification — no LLM calls. Categories: coding, debugging, feature, refactoring, testing, exploration, planning, delegation, git, build/deploy, conversation, brainstorming, general. Use this to find prior sessions of a specific type (e.g. 'all debugging sessions touching the auth code'). Sessions indexed before the categorization feature was added return empty until reindexed via `momento --rebuild`.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: [...ALL_CATEGORIES],
          description: "Turn category to filter on",
        },
        limit: { type: "number", default: 20 },
        project_path: { type: "string", description: "Optional: restrict to one project path" },
        min_turns: {
          type: "number",
          default: 1,
          description: "Require at least this many matching turns per session (default 1)",
        },
      },
      required: ["category"],
    },
  },
  {
    name: "session_category_breakdown",
    description:
      "Per-session count of turns by category. Returns [{category, turns}, ...] sorted by turn count desc. Use to understand a session's 'shape' — was it mostly debugging, mostly exploration, etc.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "aggregate_ledger",
    description:
      "Structured aggregation over ISE `ledger.jsonl` files (append-only task-closure rows) found under MOMENTO_SRC_ROOTS. Unlike keyword search, this returns NUMBERS: idea_quality (positive/negative outcomes grouped by persona × stack × class — the 'what worked' assignment signal) and harness_health (share of tasks that died to tooling/refusal, which nobody else tracks). Read-only over on-disk ledgers; returns an empty result if no ledger.jsonl files exist. Optionally filter by module or stack.",
    inputSchema: {
      type: "object",
      properties: {
        module: { type: "string", description: "Optional: restrict to one module (e.g. pentest, dev, research)" },
        stack: { type: "string", description: "Optional: restrict to one stack fingerprint" },
      },
    },
  },
  {
    name: "search_ledger",
    description:
      "Keyword search (FTS5/BM25) over ISE `ledger.jsonl` task-closure rows — the narrative fields (conjecture/refuted/learned/criterion, ids, outcomes). Use to recall 'the ISA/closure where I dealt with X'. Complements aggregate_ledger (which returns numbers, not text). OPTIONAL & additive: returns [] if no ledger exists. Optionally filter by outcome or class.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords (rare/unique terms rank best; keyword-only, no synonyms)" },
        outcome: { type: "string", description: "Optional: restrict to one outcome (cracked, shipped, misfit, …)" },
        klass: { type: "string", description: "Optional: restrict to one class/vuln_class" },
        limit: { type: "number", description: "Max hits (default 20)" },
      },
      required: ["query"],
    },
  },
  {
    name: "search_audit",
    description:
      "Keyword search (FTS5/BM25) over marshal's `audit.jsonl` tool-call trail — which backend tool ran, when, ok/latency, redacted arg keys. Use to recall 'when did I call serval.navigate' or 'what momento tools ran'. Results are newest-first. OPTIONAL & additive: returns [] if no marshal audit exists. Optionally filter by backend, tool, ok, or since (ISO ts).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords over backend.tool / event / arg keys (keyword-only)" },
        backend: { type: "string", description: "Optional: restrict to one backend (momento, serval, …)" },
        tool: { type: "string", description: "Optional: restrict to one backend tool name" },
        ok: { type: "boolean", description: "Optional: only successful (true) or failed (false) calls" },
        since: { type: "string", description: "Optional: only calls at/after this ISO timestamp" },
        limit: { type: "number", description: "Max hits (default 20)" },
      },
      required: ["query"],
    },
  },
];

const INSTRUCTIONS = [
  "momento indexes conversation history across THREE coding-agent CLIs: Claude Code (~/.claude/projects/), Codex (~/.codex/sessions/), and Gemini (~/.gemini/tmp/). Every session row carries a `client` field naming its source.",
  "",
  "SEARCH STRATEGY (read this — it changes how you should query):",
  "- search and find_by_topic are KEYWORD-ONLY (FTS5 + BM25). They do NOT understand synonyms or paraphrases. A query for 'bug bounty' will not match a session that says 'VRP submission' even though they mean the same thing.",
  "- Prefer UNIQUE, RARE vocabulary (project codenames like G-HUNT-AUTO-26-UNAUTH, target hostnames, error strings, library names) over broad terms ('testing', 'bug', 'review'). Rare terms rank higher and surface the right session faster.",
  "- If first search misses, drop project_path filters and retry with rarer terms. Try the user's own words AND domain-specific words (e.g., search 'stitch' AND 'vrp' AND 'unauthenticated', not just 'google bug bounty').",
  "- When the user references a topic in vague terms, run 2-3 searches with different keyword angles before concluding the data isn't there.",
  "",
  "PROJECT/PATH SEMANTICS:",
  "- For Claude Code: project_path = launch dir (encoded), not necessarily the edit target. Use files_touched or get_recent_by_edited_path to find sessions that edited a specific repo.",
  "- For Codex: project_path = the cwd from session_meta (real filesystem path).",
  "- For Gemini: project_path = the registered project path (resolved from projectHash via ~/.gemini/projects.json), or the raw hash if unregistered. Gemini file activity (write_file/replace/read_file → native; run_shell_command redirects → inferred) is now extracted from each message's toolCalls array; pre-fix sessions need `momento --rebuild` to backfill.",
  "- Sessions returned by get_recent and get_project include topEditedPaths: the top 5 repo directories under MOMENTO_SRC_ROOTS (defaults to ~/src) where the session actually wrote/edited files.",
  "",
  "KNOWN GAPS (so you don't over-trust negative results):",
  "- file_touches can include both native and inferred touches. `get_recent_by_edited_path` and `topEditedPaths` only trust native write/edit touches. Edits performed via Bash redirects, MCP tool calls (lorg, stitch-mcp, etc.), or shell scripts are still invisible to those path-based views even when the conversation about them is indexed in messages_fts. Always confirm a 'no edits' answer with a content search.",
  "- Codex sessions have synthetic `<environment_context>` first prompts that bury the real topic; first_prompt is unreliable for Codex. Trust the message body via search instead.",
].join("\n");

// MCP protocol versions this server implements. We echo back the client's
// requested version when we recognize it; otherwise fall back to the most
// recent version we've validated against.
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);
const FALLBACK_PROTOCOL_VERSION = "2025-06-18";

// Tool dispatch — preserves the prior switch behavior.
function callTool(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "search":
      return search(indexer.db, String(args.query ?? ""), {
        limit: typeof args.limit === "number" ? args.limit : undefined,
        projectPath: typeof args.project_path === "string" ? args.project_path : undefined,
      });
    case "get_project":
      return getProject(indexer.db, String(args.project_path ?? ""));
    case "find_by_topic":
    case "find_similar": // deprecated alias — same dispatch
      return findByTopic(
        indexer.db,
        String(args.description ?? ""),
        typeof args.limit === "number" ? args.limit : 10,
      );
    case "find_by_topic_recent":
      return findByTopicWithRecency(
        indexer.db,
        String(args.description ?? ""),
        typeof args.limit === "number" ? args.limit : 10,
      );
    case "get_recent":
      return getRecent(
        indexer.db,
        typeof args.n === "number" ? args.n : 20,
        typeof args.project_path === "string" ? args.project_path : undefined,
      );
    case "files_touched":
      return filesTouched(indexer.db, String(args.pattern ?? ""));
    case "get_recent_by_edited_path":
      return getRecentByEditedPath(
        indexer.db,
        String(args.path ?? ""),
        typeof args.n === "number" ? args.n : 20,
      );
    case "find_by_category": {
      const category = String(args.category ?? "");
      if (!ALL_CATEGORIES.includes(category as (typeof ALL_CATEGORIES)[number])) {
        throw new Error(
          `unknown category: ${category}. Known: ${ALL_CATEGORIES.join(", ")}`,
        );
      }
      return findByCategory(indexer.db, category, {
        limit: typeof args.limit === "number" ? args.limit : undefined,
        projectPath: typeof args.project_path === "string" ? args.project_path : undefined,
        minTurns: typeof args.min_turns === "number" ? args.min_turns : undefined,
      });
    }
    case "session_category_breakdown":
      return sessionCategoryBreakdown(indexer.db, String(args.session_id ?? ""));
    case "aggregate_ledger":
      return aggregateLedger({
        module: typeof args.module === "string" ? args.module : undefined,
        stack: typeof args.stack === "string" ? args.stack : undefined,
      });
    case "search_ledger":
      indexExternalFast(indexer.db); // refresh canonical sources (no ~/src walk, mtime-gated → cheap)
      return searchLedger(indexer.db, String(args.query ?? ""), {
        outcome: typeof args.outcome === "string" ? args.outcome : undefined,
        klass: typeof args.klass === "string" ? args.klass : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
    case "search_audit":
      indexExternalFast(indexer.db);
      return searchAudit(indexer.db, String(args.query ?? ""), {
        backend: typeof args.backend === "string" ? args.backend : undefined,
        tool: typeof args.tool === "string" ? args.tool : undefined,
        ok: typeof args.ok === "boolean" ? args.ok : undefined,
        since: typeof args.since === "string" ? args.since : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// JSON-RPC 2.0 over MCP stdio: newline-delimited JSON, one message per line.
// stdout MUST stay clean of anything that isn't a framed response — any stray
// log breaks the protocol. Use process.stderr.write for diagnostics.
type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResult(id: JsonRpcId, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id: JsonRpcId, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handleMessage(req: JsonRpcRequest): void {
  // Notifications have no id and require no response.
  const isNotification = req.id === undefined || req.id === null;
  const id: JsonRpcId = isNotification ? null : (req.id as JsonRpcId);
  const params = req.params ?? {};

  switch (req.method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested)
        ? requested
        : FALLBACK_PROTOCOL_VERSION;
      sendResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "momento", version: "0.1.0" },
        instructions: INSTRUCTIONS,
      });
      return;
    }
    case "notifications/initialized":
      // Notification, no reply.
      return;
    case "tools/list":
      sendResult(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = callTool(name, args);
        sendResult(id, {
          content: [{ type: "text", text: formatToolResult(name, result) }],
        });
      } catch (err) {
        // Tool failures are reported in-band, not as JSON-RPC errors.
        sendResult(id, {
          content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
          isError: true,
        });
      }
      return;
    }
    case "ping":
      sendResult(id, {});
      return;
    default:
      if (!isNotification) {
        sendError(id, -32601, `method not found: ${req.method}`);
      }
      return;
  }
}

const shutdown = (): void => {
  try {
    indexer.close();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Line-buffered stdin reader. MCP stdio framing is one JSON object per line.
let stdinBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  stdinBuf += chunk;
  let idx: number;
  while ((idx = stdinBuf.indexOf("\n")) !== -1) {
    const line = stdinBuf.slice(0, idx).replace(/\r$/, "");
    stdinBuf = stdinBuf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(line) as JsonRpcRequest;
    } catch (err) {
      sendError(null, -32700, `parse error: ${(err as Error).message}`);
      continue;
    }
    try {
      handleMessage(msg);
    } catch (err) {
      const id: JsonRpcId =
        msg.id === undefined || msg.id === null ? null : (msg.id as JsonRpcId);
      sendError(id, -32603, `internal error: ${(err as Error).message}`);
    }
  }
});
process.stdin.on("end", () => {
  shutdown();
});

} // end of MCP-mode block (else branch of `--web`)

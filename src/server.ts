#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { Indexer } from "./indexer.js";
import { search, getProject, findSimilar, getRecent, filesTouched, getRecentByEditedPath } from "./queries.js";

const HOME = homedir();
const DB_DIR = join(HOME, ".momento");
const DB_PATH = join(DB_DIR, "index.db");
const PROJECTS_ROOT = join(HOME, ".claude", "projects");

mkdirSync(DB_DIR, { recursive: true });

const indexer = new Indexer(DB_PATH);

const sessionCount = (indexer.db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number }).n;
if (sessionCount === 0) {
  indexer.buildAll(PROJECTS_ROOT).catch((err) =>
    process.stderr.write(`momento: background build failed: ${err.message}\n`),
  );
}
indexer.watch(PROJECTS_ROOT);

const TOOLS = [
  {
    name: "search",
    description: "BM25 full-text search across all indexed message content. Returns ranked snippets.",
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
    name: "find_similar",
    description: "Find past sessions whose summary or first prompt resembles the given description.",
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
    description: "Sessions that read, wrote, or edited a file path matching the given pattern (LIKE).",
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
  },
  {
    name: "get_recent_by_edited_path",
    description:
      "Most recently modified sessions whose write/edit touches fall under the given path prefix. Use this to find sessions that actually edited a repo, regardless of where Claude Code was launched.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path prefix to match against edited file paths" },
        n: { type: "number", default: 20 },
      },
      required: ["path"],
    },
  },
];

const INSTRUCTIONS = [
  "momento indexes Claude Code conversation history at ~/.claude/projects/.",
  "project_path = launch dir, not edit target. Use files_touched or get_recent_by_edited_path to find work on a specific repo.",
  "Sessions returned by get_recent and get_project include topEditedPaths: the top 5 repo directories under MOMENTO_SRC_ROOTS (defaults to ~/src) where the session actually wrote/edited files.",
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
    case "find_similar":
      return findSimilar(
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
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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

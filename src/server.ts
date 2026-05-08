#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
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

const server = new Server(
  { name: "momento", version: "0.1.0" },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    let result: unknown;
    switch (req.params.name) {
      case "search":
        result = search(indexer.db, String(args.query ?? ""), {
          limit: typeof args.limit === "number" ? args.limit : undefined,
          projectPath: typeof args.project_path === "string" ? args.project_path : undefined,
        });
        break;
      case "get_project":
        result = getProject(indexer.db, String(args.project_path ?? ""));
        break;
      case "find_similar":
        result = findSimilar(
          indexer.db,
          String(args.description ?? ""),
          typeof args.limit === "number" ? args.limit : 10,
        );
        break;
      case "get_recent":
        result = getRecent(
          indexer.db,
          typeof args.n === "number" ? args.n : 20,
          typeof args.project_path === "string" ? args.project_path : undefined,
        );
        break;
      case "files_touched":
        result = filesTouched(indexer.db, String(args.pattern ?? ""));
        break;
      case "get_recent_by_edited_path":
        result = getRecentByEditedPath(
          indexer.db,
          String(args.path ?? ""),
          typeof args.n === "number" ? args.n : 20,
        );
        break;
      default:
        throw new Error(`unknown tool: ${req.params.name}`);
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
      isError: true,
    };
  }
});

const shutdown = (): void => {
  try {
    indexer.close();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);

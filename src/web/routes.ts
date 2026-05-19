// Route handlers for the local web UI. Pure functions over (req, res, ctx)
// so the server module stays focused on transport concerns.
//
// All DB access is read-only: the SQLite connection is opened with
// readOnly: true in server.ts and never accepts user-supplied SQL.

import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import {
  search as fts_search,
  findByTopicRanked,
  getRecent,
  filesTouched,
  getRepoBreakdown,
  sessionCategoryBreakdown,
  type SearchHit,
  type SessionRow,
} from "../queries.js";
import type { EventBus } from "./events.js";
import { eventToSSE } from "./events.js";

export interface RouteCtx {
  db: DatabaseSync;
  dbPath: string;
  bus: EventBus;
  staticRoot: string;
  startedAt: number;
}

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function sendFile(
  res: ServerResponse,
  filePath: string,
  contentType: string,
): Promise<void> {
  const body = await readFile(filePath);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": body.byteLength,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function getQuery(url: URL, key: string, fallback = ""): string {
  return (url.searchParams.get(key) ?? fallback).trim();
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

export async function handleRoot(_req: IncomingMessage, res: ServerResponse, ctx: RouteCtx): Promise<void> {
  const file = join(ctx.staticRoot, "index.html");
  if (!existsSync(file)) {
    sendJson(res, 500, { error: "index.html missing" });
    return;
  }
  await sendFile(res, file, "text/html; charset=utf-8");
}

export async function handleStatic(req: IncomingMessage, res: ServerResponse, ctx: RouteCtx, rel: string): Promise<void> {
  // Resolve against staticRoot and verify the result stays inside it.
  const root = resolve(ctx.staticRoot);
  const candidate = resolve(join(root, normalize(rel)));
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    sendJson(res, 403, { error: "path traversal blocked" });
    return;
  }
  if (!existsSync(candidate)) {
    sendJson(res, 404, { error: "missing asset" });
    return;
  }
  const st = await stat(candidate);
  if (!st.isFile()) {
    sendJson(res, 404, { error: "missing asset" });
    return;
  }
  const ext = extname(candidate).toLowerCase();
  const type = STATIC_TYPES[ext] ?? "application/octet-stream";
  await sendFile(res, candidate, type);
}

export function handleStatus(_req: IncomingMessage, res: ServerResponse, ctx: RouteCtx): void {
  const uptime = Math.floor((Date.now() - ctx.startedAt) / 1000);
  let dbSize = 0;
  try {
    // statSync isn't available here; use the prepared pragma instead to avoid
    // any chance of a stale cached value. page_count * page_size is exact.
    const pc = ctx.db.prepare("PRAGMA page_count").get() as { page_count: number };
    const ps = ctx.db.prepare("PRAGMA page_size").get() as { page_size: number };
    dbSize = (pc?.page_count ?? 0) * (ps?.page_size ?? 0);
  } catch {
    dbSize = 0;
  }
  const count = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number }).n;
  sendJson(res, 200, {
    uptime_seconds: uptime,
    db_path: ctx.dbPath,
    db_size_bytes: dbSize,
    session_count: count,
    subscribers: ctx.bus.subscriberCount(),
  });
}

export function handleFeed(req: IncomingMessage, res: ServerResponse, ctx: RouteCtx): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
  });
  // Initial hello so the browser knows the stream is alive.
  res.write("event: hello\ndata: {}\n\n");

  const sub = ctx.bus.subscribe();
  let closed = false;
  const keepalive = setInterval(() => {
    if (closed) return;
    try {
      res.write(": keep-alive\n\n");
    } catch {
      cleanup();
    }
  }, 15000);
  keepalive.unref?.();

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    sub.close();
    try {
      res.end();
    } catch {
      /* ignore */
    }
  };

  req.on("close", cleanup);
  req.on("error", cleanup);

  const pump = async (): Promise<void> => {
    while (!closed) {
      const ev = await sub.next();
      if (ev === null) return;
      try {
        res.write(eventToSSE(ev));
      } catch {
        cleanup();
        return;
      }
    }
  };
  void pump();
}

export function handleRecent(_req: IncomingMessage, res: ServerResponse, ctx: RouteCtx, url: URL): void {
  const n = clamp(parseInt(getQuery(url, "n", "200"), 10), 1, 5000);
  const projectPath = getQuery(url, "project_path");
  const client = getQuery(url, "client");
  const category = getQuery(url, "category");
  // day filter: YYYY-MM-DD. Driven by the dashboard heatmap click. Compared
  // against date(modified) so a session that spans midnight still surfaces
  // on the day it was last active. Validated as a date-shape string before
  // hitting SQL (defense-in-depth; the param goes through a bound `?` too).
  const day = getQuery(url, "day");
  // repo filter: a bucketed repo root (e.g. "/Volumes/.../src/momento")
  // intersected against sessions whose topEditedPaths contain it. The
  // bucket strings come from getRepoBreakdown so the value space matches.
  const repo = getQuery(url, "repo");
  let rows = getRecent(ctx.db, n, projectPath || undefined);
  if (client) rows = rows.filter((r) => r.client === client);
  if (category) {
    // Intersect with sessions that have at least one turn of the requested
    // category. Cheap subquery; turn_categories.category is indexed.
    const ids = new Set(
      (
        ctx.db
          .prepare(`SELECT DISTINCT session_id FROM turn_categories WHERE category = ?`)
          .all(category) as { session_id: string }[]
      ).map((r) => r.session_id),
    );
    rows = rows.filter((r) => ids.has(r.id));
  }
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
    rows = rows.filter((r) => (r.modified || "").startsWith(day));
  }
  if (repo) {
    rows = rows.filter((r) => (r.topEditedPaths ?? []).includes(repo));
  }
  sendJson(res, 200, { sessions: rows });
}

// Distribution of turn categories across the indexed corpus. Powers the
// chip row in the UI: each chip shows how many distinct sessions contain
// at least one turn of that category. Sessions older than the v4 schema
// migration won't contribute until reindexed.
export function handleCategories(_req: IncomingMessage, res: ServerResponse, ctx: RouteCtx): void {
  const rows = ctx.db
    .prepare(
      `SELECT category,
              COUNT(DISTINCT session_id) AS sessions,
              COUNT(*) AS turns
       FROM turn_categories
       GROUP BY category
       ORDER BY sessions DESC`,
    )
    .all() as { category: string; sessions: number; turns: number }[];
  sendJson(res, 200, { categories: rows });
}

// Per-session category breakdown. Mirrors the sessionCategoryBreakdown MCP
// tool over HTTP so the detail rail can render a session's "shape" bar
// without going through MCP plumbing. Empty array is a valid response for
// sessions indexed before the v4 classifier migration.
export function handleSessionCategories(_req: IncomingMessage, res: ServerResponse, ctx: RouteCtx, id: string): void {
  if (!id || !/^[A-Za-z0-9._\-]+$/.test(id)) {
    sendJson(res, 400, { error: "invalid session id" });
    return;
  }
  const breakdown = sessionCategoryBreakdown(ctx.db, id);
  sendJson(res, 200, { sessionId: id, breakdown });
}

// Repo activity for the dashboard's Repos panel. One row per src-root-
// bucketed repo, ordered by session count desc. Used to power click-to-
// filter ("show me sessions that edited this repo") and to draw the lane
// chart in the panel.
export function handleRepos(_req: IncomingMessage, res: ServerResponse, ctx: RouteCtx, url: URL): void {
  const limit = clamp(parseInt(getQuery(url, "limit", "12"), 10), 1, 50);
  const repos = getRepoBreakdown(ctx.db, limit);
  sendJson(res, 200, { repos });
}

// Sessions-per-day timeline for the dashboard's Activity heatmap. Defaults
// to 14 days to match the hook's recency half-life; capped at 730 so the
// "all" scope still has a sane upper bound.
export function handleActivity(_req: IncomingMessage, res: ServerResponse, ctx: RouteCtx, url: URL): void {
  // Range capped at 730 days (2 years) so the dashboard's "all" scope still
  // has a sane upper bound — pre-2024 sessions are vanishingly few and a
  // larger range bloats the heatmap payload without adding signal.
  const days = clamp(parseInt(getQuery(url, "days", "14"), 10), 1, 730);
  const rows = ctx.db
    .prepare(
      `SELECT date(created) AS day, COUNT(*) AS n
       FROM sessions
       WHERE created IS NOT NULL AND created >= datetime('now', '-' || ? || ' days')
       GROUP BY day
       ORDER BY day ASC`,
    )
    .all(days) as { day: string; n: number }[];
  sendJson(res, 200, { days, points: rows });
}

interface SessionDetail {
  session: SessionRow | null;
  messages: { role: string; content_snippet: string }[];
  tool_calls: { tool_name: string; input_json: string; timestamp: string }[];
  file_touches: { file_path: string; operation: string; timestamp: string; touch_source: string }[];
}

export function handleSession(_req: IncomingMessage, res: ServerResponse, ctx: RouteCtx, id: string): void {
  if (!id || !/^[A-Za-z0-9._\-]+$/.test(id)) {
    sendJson(res, 400, { error: "invalid session id" });
    return;
  }
  const session = ctx.db
    .prepare(
      `SELECT id, project_path AS projectPath, summary, first_prompt AS firstPrompt,
              created, modified, git_branch AS gitBranch,
              message_count AS messageCount, jsonl_path AS jsonlPath, client
       FROM sessions WHERE id = ?`,
    )
    .get(id) as SessionRow | undefined;
  if (!session) {
    sendJson(res, 404, { error: "session not found", id });
    return;
  }
  // Full message content so the UI can render markdown (tables, code blocks,
  // lists). Bounded per-message at 64 KB; bounded total at 200 messages.
  const messages = ctx.db
    .prepare(
      `SELECT role, substr(content, 1, 65536) AS content_snippet
       FROM messages_fts WHERE session_id = ? LIMIT 200`,
    )
    .all(id) as { role: string; content_snippet: string }[];
  const toolCalls = ctx.db
    .prepare(
      `SELECT tool_name, input_json, timestamp
       FROM tool_calls WHERE session_id = ? ORDER BY timestamp ASC LIMIT 100`,
    )
    .all(id) as { tool_name: string; input_json: string; timestamp: string }[];
  const fileTouches = ctx.db
    .prepare(
      `SELECT file_path, operation, timestamp, touch_source
       FROM file_touches WHERE session_id = ? ORDER BY timestamp ASC LIMIT 100`,
    )
    .all(id) as { file_path: string; operation: string; timestamp: string; touch_source: string }[];
  const payload: SessionDetail = {
    session,
    messages,
    tool_calls: toolCalls,
    file_touches: fileTouches,
  };
  sendJson(res, 200, payload);
}

export function handleSearch(_req: IncomingMessage, res: ServerResponse, ctx: RouteCtx, url: URL): void {
  const q = getQuery(url, "q");
  const limit = clamp(parseInt(getQuery(url, "limit", "200"), 10), 1, 2000);
  const client = getQuery(url, "client");
  const category = getQuery(url, "category");
  const repo = getQuery(url, "repo");
  if (!q) {
    sendJson(res, 200, { query: "", hits: [] });
    return;
  }
  let hits: SearchHit[] = fts_search(ctx.db, q, { limit });
  if (client) hits = hits.filter((h) => h.client === client);
  if (category) {
    const ids = new Set(
      (
        ctx.db
          .prepare(`SELECT DISTINCT session_id FROM turn_categories WHERE category = ?`)
          .all(category) as { session_id: string }[]
      ).map((r) => r.session_id),
    );
    hits = hits.filter((h) => ids.has(h.sessionId));
  }
  if (repo) {
    // Session IDs whose native edits bucket under this repo. Cheap subquery
    // — file_path is indexed and LIKE prefix matches stay in the index.
    const like = `${repo}/%`;
    const ids = new Set(
      (
        ctx.db
          .prepare(
            `SELECT DISTINCT session_id FROM file_touches
             WHERE operation IN ('write','edit') AND touch_source = 'native'
               AND file_path LIKE ?`,
          )
          .all(like) as { session_id: string }[]
      ).map((r) => r.session_id),
    );
    hits = hits.filter((h) => ids.has(h.sessionId));
  }
  sendJson(res, 200, { query: q, hits });
}

export function handleFind(_req: IncomingMessage, res: ServerResponse, ctx: RouteCtx, url: URL): void {
  const q = getQuery(url, "q");
  const limit = clamp(parseInt(getQuery(url, "limit", "100"), 10), 1, 1000);
  if (!q) {
    sendJson(res, 200, { query: "", match_type: "none", hits: [] });
    return;
  }
  const ranked = findByTopicRanked(ctx.db, q, limit);
  sendJson(res, 200, { query: q, match_type: ranked.matchType, hits: ranked.hits });
}

export function handleFiles(_req: IncomingMessage, res: ServerResponse, ctx: RouteCtx, url: URL): void {
  const pattern = getQuery(url, "pattern");
  if (!pattern) {
    sendJson(res, 200, { pattern: "", touches: [] });
    return;
  }
  const touches = filesTouched(ctx.db, pattern);
  sendJson(res, 200, { pattern, touches });
}

export { sendJson };

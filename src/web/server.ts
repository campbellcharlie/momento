// Loopback-only HTTP server backed by node:http. Read-only SQLite access,
// SSE feed, and static assets. No framework dependencies.
//
// Bind policy: only 127.0.0.1, localhost, or ::1. Anything else throws at
// startup. The Host: header is also validated per-request as defense in depth.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EventBus } from "./events.js";
import { IndexWatcher } from "./watcher.js";
import {
  handleActivity,
  handleCategories,
  handleFeed,
  handleFiles,
  handleFind,
  handleRecent,
  handleRepos,
  handleRoot,
  handleSearch,
  handleSession,
  handleStatic,
  handleStatus,
  sendJson,
} from "./routes.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export interface WebServerOptions {
  dbPath: string;
  host?: string;
  port?: number;
  staticRoot?: string;
  watchIntervalMs?: number;
}

export interface WebServerHandle {
  server: Server;
  bus: EventBus;
  watcher: IndexWatcher;
  port: number;
  host: string;
  close: () => Promise<void>;
}

function defaultStaticRoot(): string {
  // When compiled, static assets are copied to dist/web/static/ by the build
  // script. As a fallback (e.g. running tests against freshly-compiled JS
  // before the copy step ran) check ../../src/web/static, which is where the
  // source assets actually live.
  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = join(here, "static");
  if (existsSync(compiled)) return compiled;
  const source = join(here, "..", "..", "src", "web", "static");
  return source;
}

function isLoopbackHostHeader(value: string | undefined): boolean {
  if (!value) return true; // some clients omit Host on raw sockets; allow.
  const host = value.split(":")[0].trim().toLowerCase().replace(/^\[|\]$/g, "");
  return LOOPBACK_HOSTS.has(host);
}

export function startWebServer(opts: WebServerOptions): Promise<WebServerHandle> {
  const host = opts.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`refusing non-loopback bind: ${host}`);
  }
  const port = opts.port ?? 8765;
  const staticRoot = opts.staticRoot ?? defaultStaticRoot();

  // Read-only DB connection. node:sqlite enforces this at the engine level.
  const db = new DatabaseSync(opts.dbPath, { readOnly: true });
  const bus = new EventBus();
  const watcher = new IndexWatcher({
    bus,
    dbPath: opts.dbPath,
    intervalMs: opts.watchIntervalMs ?? 2000,
  });
  watcher.start();

  const startedAt = Date.now();
  const ctx = { db, dbPath: opts.dbPath, bus, staticRoot, startedAt };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (!isLoopbackHostHeader(req.headers.host)) {
        sendJson(res, 403, { error: "non-loopback host rejected" });
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;

      if (path === "/") {
        await handleRoot(req, res, ctx);
        return;
      }
      if (path.startsWith("/static/")) {
        await handleStatic(req, res, ctx, path.slice("/static/".length));
        return;
      }
      if (path === "/api/status") {
        handleStatus(req, res, ctx);
        return;
      }
      if (path === "/api/feed") {
        handleFeed(req, res, ctx);
        return;
      }
      if (path === "/api/sessions/recent") {
        handleRecent(req, res, ctx, url);
        return;
      }
      if (path.startsWith("/api/sessions/")) {
        const id = decodeURIComponent(path.slice("/api/sessions/".length));
        handleSession(req, res, ctx, id);
        return;
      }
      if (path === "/api/search") {
        handleSearch(req, res, ctx, url);
        return;
      }
      if (path === "/api/find") {
        handleFind(req, res, ctx, url);
        return;
      }
      if (path === "/api/files") {
        handleFiles(req, res, ctx, url);
        return;
      }
      if (path === "/api/categories") {
        handleCategories(req, res, ctx);
        return;
      }
      if (path === "/api/activity") {
        handleActivity(req, res, ctx, url);
        return;
      }
      if (path === "/api/repos") {
        handleRepos(req, res, ctx, url);
        return;
      }
      sendJson(res, 404, { error: "not found", path });
    } catch (err) {
      // Avoid leaking stacks to the client; log to stderr.
      process.stderr.write(`momento web: ${(err as Error).message}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal error" });
      } else {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    }
  });

  return new Promise<WebServerHandle>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        server,
        bus,
        watcher,
        port: boundPort,
        host,
        close: () =>
          new Promise<void>((resolveClose) => {
            watcher.stop();
            server.close(() => {
              try {
                db.close();
              } catch {
                /* ignore */
              }
              resolveClose();
            });
          }),
      });
    });
  });
}

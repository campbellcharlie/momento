import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { Indexer } from "../dist/indexer.js";
import { loadConfig } from "../dist/config.js";
import { startWebServer } from "../dist/web/server.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");

// Build a small fixture DB from the existing per-client fixtures so each
// test runs against real-shaped data, not an empty schema.
async function buildFixtureDb() {
  const work = mkdtempSync(join(tmpdir(), "momento-web-"));
  const projects = join(work, "projects");
  mkdirSync(projects, { recursive: true });
  const projA = join(projects, "-Users-me-src-repo-a");
  mkdirSync(projA);
  copyFileSync(join(FIX, "basic-session.jsonl"), join(projA, "sess-basic.jsonl"));
  const cfg = loadConfig({ env: {}, ignoreFile: "/nonexistent" });
  const dbPath = join(work, "index.db");
  const indexer = new Indexer(dbPath, cfg);
  await indexer.buildAll(projects);
  indexer.close();
  return {
    dbPath,
    cleanup: () => rmSync(work, { recursive: true, force: true }),
  };
}

async function withServer(opts, fn) {
  const handle = await startWebServer(opts);
  try {
    return await fn(handle);
  } finally {
    await handle.close();
  }
}

async function fetchJson(url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* leave null */ }
  return { status: r.status, headers: r.headers, text, json };
}

test("web server refuses non-loopback bind", async () => {
  const fx = await buildFixtureDb();
  try {
    assert.throws(
      () => startWebServer({ dbPath: fx.dbPath, host: "0.0.0.0", port: 0 }),
      /non-loopback/,
    );
  } finally {
    fx.cleanup();
  }
});

test("GET / returns HTML 200 with X-Content-Type-Options: nosniff", async () => {
  const fx = await buildFixtureDb();
  try {
    await withServer({ dbPath: fx.dbPath, port: 0 }, async (h) => {
      const r = await fetch(`http://127.0.0.1:${h.port}/`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("x-content-type-options"), "nosniff");
      assert.match(r.headers.get("content-type") || "", /text\/html/);
      const body = await r.text();
      assert.match(body, /<title>momento/);
    });
  } finally {
    fx.cleanup();
  }
});

test("GET /api/status returns expected fields", async () => {
  const fx = await buildFixtureDb();
  try {
    await withServer({ dbPath: fx.dbPath, port: 0 }, async (h) => {
      const { status, json } = await fetchJson(`http://127.0.0.1:${h.port}/api/status`);
      assert.equal(status, 200);
      assert.ok(typeof json.uptime_seconds === "number");
      assert.equal(json.db_path, fx.dbPath);
      assert.ok(json.db_size_bytes > 0);
      assert.ok(json.session_count >= 1);
      assert.equal(typeof json.subscribers, "number");
    });
  } finally {
    fx.cleanup();
  }
});

test("GET /api/search?q=foo returns hits from FTS", async () => {
  const fx = await buildFixtureDb();
  try {
    await withServer({ dbPath: fx.dbPath, port: 0 }, async (h) => {
      const { status, json } = await fetchJson(
        `http://127.0.0.1:${h.port}/api/search?q=rate-limit`,
      );
      assert.equal(status, 200);
      assert.equal(json.query, "rate-limit");
      assert.ok(Array.isArray(json.hits));
      assert.ok(json.hits.length >= 1, "expected at least one FTS hit");
      assert.equal(json.hits[0].sessionId, "sess-basic");
    });
  } finally {
    fx.cleanup();
  }
});

test("GET /api/sessions/recent respects n and client filter", async () => {
  const fx = await buildFixtureDb();
  try {
    await withServer({ dbPath: fx.dbPath, port: 0 }, async (h) => {
      const all = await fetchJson(`http://127.0.0.1:${h.port}/api/sessions/recent?n=5`);
      assert.equal(all.status, 200);
      assert.ok(Array.isArray(all.json.sessions));
      assert.ok(all.json.sessions.length <= 5);
      assert.ok(all.json.sessions.length >= 1);

      const filtered = await fetchJson(
        `http://127.0.0.1:${h.port}/api/sessions/recent?n=20&client=claude_code`,
      );
      assert.equal(filtered.status, 200);
      assert.ok(filtered.json.sessions.every((s) => s.client === "claude_code"));

      const none = await fetchJson(
        `http://127.0.0.1:${h.port}/api/sessions/recent?client=nonexistent_client`,
      );
      assert.equal(none.status, 200);
      assert.equal(none.json.sessions.length, 0);
    });
  } finally {
    fx.cleanup();
  }
});

test("GET /api/sessions/:id returns messages, tool_calls, file_touches", async () => {
  const fx = await buildFixtureDb();
  try {
    await withServer({ dbPath: fx.dbPath, port: 0 }, async (h) => {
      const { status, json } = await fetchJson(
        `http://127.0.0.1:${h.port}/api/sessions/sess-basic`,
      );
      assert.equal(status, 200);
      assert.equal(json.session.id, "sess-basic");
      assert.ok(Array.isArray(json.messages));
      assert.ok(Array.isArray(json.tool_calls));
      assert.ok(Array.isArray(json.file_touches));
      assert.ok(json.messages.length >= 1);
    });
  } finally {
    fx.cleanup();
  }
});

test("GET /api/sessions/<bogus> returns 404", async () => {
  const fx = await buildFixtureDb();
  try {
    await withServer({ dbPath: fx.dbPath, port: 0 }, async (h) => {
      const r = await fetch(`http://127.0.0.1:${h.port}/api/sessions/does-not-exist`);
      assert.equal(r.status, 404);
    });
  } finally {
    fx.cleanup();
  }
});

test("path traversal on /static/ is blocked", async () => {
  const fx = await buildFixtureDb();
  try {
    await withServer({ dbPath: fx.dbPath, port: 0 }, async (h) => {
      // URL contains "..". WHATWG URL doesn't normalize past-root segments
      // in the path component the same way every client does, so use a raw
      // socket to send the exact bytes we want.
      const result = await rawGet(h.port, "/static/../../../etc/passwd");
      assert.ok(
        result.status === 403 || result.status === 404,
        `expected 403 or 404, got ${result.status}`,
      );
    });
  } finally {
    fx.cleanup();
  }
});

test("non-loopback Host: header is rejected with 403", async () => {
  const fx = await buildFixtureDb();
  try {
    await withServer({ dbPath: fx.dbPath, port: 0 }, async (h) => {
      const result = await rawGet(h.port, "/api/status", { Host: "evil.example.com" });
      assert.equal(result.status, 403);
    });
  } finally {
    fx.cleanup();
  }
});

test("GET /static/app.css serves CSS", async () => {
  const fx = await buildFixtureDb();
  try {
    await withServer({ dbPath: fx.dbPath, port: 0 }, async (h) => {
      const r = await fetch(`http://127.0.0.1:${h.port}/static/app.css`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type") || "", /text\/css/);
    });
  } finally {
    fx.cleanup();
  }
});

test("GET /api/find returns ranked sessions", async () => {
  const fx = await buildFixtureDb();
  try {
    await withServer({ dbPath: fx.dbPath, port: 0 }, async (h) => {
      const { status, json } = await fetchJson(
        `http://127.0.0.1:${h.port}/api/find?q=rate-limit+api+backoff`,
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(json.hits));
      assert.ok(["and", "or", "none"].includes(json.match_type));
    });
  } finally {
    fx.cleanup();
  }
});

// Send a raw HTTP/1.1 request because Node's fetch normalizes certain inputs
// (e.g. collapses "/../" in URLs, rewrites Host to match the bound address).
function rawGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      const hostHeader = headers.Host ?? `127.0.0.1:${port}`;
      const extra = Object.entries(headers)
        .filter(([k]) => k.toLowerCase() !== "host")
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join("");
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\n${extra}Connection: close\r\n\r\n`,
      );
    });
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { buf += chunk; });
    socket.on("end", () => {
      const m = /^HTTP\/1\.1 (\d+)/.exec(buf);
      resolve({ status: m ? Number(m[1]) : 0, raw: buf });
    });
    socket.on("error", reject);
  });
}

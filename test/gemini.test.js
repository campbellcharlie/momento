import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseGeminiSession,
  iterateGeminiSessions,
  resetGeminiProjectMap,
} from "../dist/gemini.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");

// Build a fake ~/.gemini/ tree with one session under one projectHash dir, and
// projects.json mapping a known path → that hash. parseGeminiSession should
// resolve projectPath via the map.
function setupFakeGemini(projectPath) {
  const home = mkdtempSync(join(tmpdir(), "momento-gemini-"));
  const geminiDir = join(home, ".gemini");
  mkdirSync(geminiDir, { recursive: true });
  const hash = createHash("sha256").update(projectPath).digest("hex");
  const chatsDir = join(geminiDir, "tmp", hash, "chats");
  mkdirSync(chatsDir, { recursive: true });
  const sessionFile = join(chatsDir, "session-2026-03-15T08-00-deadbeef.json");

  const fixture = JSON.parse(readFileSync(join(FIX, "gemini-session.json"), "utf8"));
  // Stamp the real hash into the fixture so the resolver finds it.
  fixture.projectHash = hash;
  writeFileSync(sessionFile, JSON.stringify(fixture));

  writeFileSync(
    join(geminiDir, "projects.json"),
    JSON.stringify({ projects: { [projectPath]: "test-project" } }),
  );
  return { home, geminiDir, hash, sessionFile };
}

test("parseGeminiSession — extracts user + gemini messages, skips info", async () => {
  const fx = setupFakeGemini("/Users/me/src/test-repo");
  resetGeminiProjectMap();
  try {
    const result = await parseGeminiSession(fx.sessionFile);
    assert.equal(result.sessionId, "gem-test-001");
    assert.equal(result.meta.projectPath, "/Users/me/src/test-repo");
    assert.equal(result.meta.created, "2026-03-15T08:00:00Z");
    assert.equal(result.messages.length, 2, "info message should not be indexed");
    const roles = result.messages.map((m) => m.role).sort();
    assert.deepEqual(roles, ["assistant", "user"]);
    assert.ok(
      result.messages.find((m) => m.role === "user" && m.text.includes("webcodecs")),
    );
    assert.ok(
      result.messages.find((m) => m.role === "assistant" && m.text.includes("WebCodecs")),
    );
  } finally {
    rmSync(fx.home, { recursive: true, force: true });
  }
});

test("parseGeminiSession — falls back to projectHash when projects.json lookup misses", async () => {
  const fx = setupFakeGemini("/Users/me/src/test-repo");
  // Wipe projects.json so the map is empty; parser should fall back to using
  // the raw hash as projectPath rather than crashing.
  rmSync(join(fx.geminiDir, "projects.json"));
  resetGeminiProjectMap();
  try {
    const result = await parseGeminiSession(fx.sessionFile);
    assert.equal(result.meta.projectPath, fx.hash, "expected hash fallback");
  } finally {
    rmSync(fx.home, { recursive: true, force: true });
  }
});

test("parseGeminiSession — extracts toolCalls and native file touches", async () => {
  const fx = setupFakeGemini("/Users/me/src/test-repo");
  resetGeminiProjectMap();
  try {
    const result = await parseGeminiSession(fx.sessionFile);
    // Every toolCall becomes a tool_call row, file-op or not (the error-status
    // write_file is still a call that was attempted — only its touch is skipped).
    const toolNames = result.toolCalls.map((t) => t.toolName).sort();
    assert.deepEqual(toolNames, [
      "mcp_serval_go",
      "read_file",
      "replace",
      "run_shell_command",
      "write_file",
      "write_file",
    ]);

    const byPath = new Map(
      result.filesTouched.map((f) => [f.filePath, f]),
    );
    // Structured file tools → native.
    assert.equal(byPath.get("/Users/me/src/test-repo/out.ts").operation, "write");
    assert.equal(byPath.get("/Users/me/src/test-repo/out.ts").source, "native");
    assert.equal(byPath.get("/Users/me/src/test-repo/edit.ts").operation, "edit");
    assert.equal(byPath.get("/Users/me/src/test-repo/edit.ts").source, "native");
    assert.equal(byPath.get("/Users/me/src/test-repo/read.ts").operation, "read");
    assert.equal(byPath.get("/Users/me/src/test-repo/read.ts").source, "native");
    // run_shell_command redirect → inferred.
    assert.equal(byPath.get("/Users/me/src/test-repo/gen.txt").operation, "write");
    assert.equal(byPath.get("/Users/me/src/test-repo/gen.txt").source, "inferred");
    // error-status write_file is skipped; non-file MCP tool records no touch.
    assert.ok(!byPath.has("/Users/me/src/test-repo/failed.ts"), "error status not skipped");
    assert.equal(result.filesTouched.length, 4);
  } finally {
    rmSync(fx.home, { recursive: true, force: true });
  }
});

test("parseGeminiSession — MOMENTO_EXCLUDE_PATHS drops matching touches", async () => {
  const { loadConfig } = await import("../dist/config.js");
  const fx = setupFakeGemini("/Users/me/src/test-repo");
  resetGeminiProjectMap();
  try {
    const cfg = loadConfig({ env: { MOMENTO_EXCLUDE_PATHS: "edit.ts" }, ignoreFile: "/nonexistent" });
    const result = await parseGeminiSession(fx.sessionFile, cfg);
    assert.ok(
      !result.filesTouched.some((f) => f.filePath.includes("edit.ts")),
      "excluded path leaked",
    );
  } finally {
    rmSync(fx.home, { recursive: true, force: true });
  }
});

test("iterateGeminiSessions — walks <hash>/chats/session-*.json", async () => {
  const fx = setupFakeGemini("/Users/me/src/walked-repo");
  resetGeminiProjectMap();
  try {
    const tmp = join(fx.geminiDir, "tmp");
    const refs = [];
    for await (const ref of iterateGeminiSessions(tmp)) refs.push(ref);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].sessionId, "deadbeef");
    assert.match(refs[0].jsonlPath, /session-2026-03-15T08-00-deadbeef\.json$/);
  } finally {
    rmSync(fx.home, { recursive: true, force: true });
  }
});

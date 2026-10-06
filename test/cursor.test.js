import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseCursorSession, iterateCursorSessions, CURSOR_FILE_TOOL_OP } from "../dist/cursor.js";
import { cleanFirstPrompt } from "../dist/parser.js";
import { loadConfig } from "../dist/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");

test("parseCursorSession — messages, tools, native + inferred touches", async () => {
  const cfg = loadConfig({ env: {}, ignoreFile: "/nonexistent" });
  // Layout mirrors ~/.cursor/projects/<enc>/agent-transcripts/<id>/<id>.jsonl
  const home = mkdtempSync(join(tmpdir(), "momento-cursor-"));
  const projectDir = join(home, ".cursor", "projects", "Users-me-src-repo-x");
  const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const sessionDir = join(projectDir, "agent-transcripts", sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const jsonlPath = join(sessionDir, `${sessionId}.jsonl`);
  copyFileSync(join(FIX, "cursor-transcript.jsonl"), jsonlPath);
  writeFileSync(
    join(projectDir, ".workspace-trusted"),
    JSON.stringify({ workspacePath: "/Users/me/src/repo-x", trustedAt: "2026-10-05T00:00:00.000Z" }),
  );

  try {
    const result = await parseCursorSession(jsonlPath, cfg);
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.meta.projectPath, "/Users/me/src/repo-x");
    assert.ok(result.meta.firstPrompt?.includes("rate-limit retry"));

    const userMsg = result.messages.find((m) => m.role === "user");
    assert.ok(userMsg && userMsg.text.includes("rate-limit retry"));

    const tools = result.toolCalls.map((t) => t.toolName).sort();
    assert.deepEqual(tools, ["Read", "Shell", "StrReplace", "Write"]);

    const native = result.filesTouched.filter((f) => f.source === "native");
    const inferred = result.filesTouched.filter((f) => f.source === "inferred");
    assert.ok(native.some((f) => f.operation === "read" && f.filePath.endsWith("api.ts")));
    assert.ok(native.some((f) => f.operation === "edit" && f.filePath.endsWith("api.ts")));
    assert.ok(native.some((f) => f.operation === "write" && f.filePath.endsWith("out.ts")));
    assert.ok(inferred.some((f) => f.filePath.endsWith("generated.ts")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("iterateCursorSessions — walks agent-transcripts layout", async () => {
  const work = mkdtempSync(join(tmpdir(), "momento-cursor-iter-"));
  try {
    const sessionId = "11111111-2222-3333-4444-555555555555";
    const sessionDir = join(work, "Users-me-src-x", "agent-transcripts", sessionId);
    mkdirSync(sessionDir, { recursive: true });
    copyFileSync(join(FIX, "cursor-transcript.jsonl"), join(sessionDir, `${sessionId}.jsonl`));
    // Noise: project without transcripts, hidden dir
    mkdirSync(join(work, ".agent-data-cleanup"), { recursive: true });
    mkdirSync(join(work, "empty-project"), { recursive: true });

    const refs = [];
    for await (const ref of iterateCursorSessions(work)) refs.push(ref);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].sessionId, sessionId);
    assert.equal(refs[0].projectDir, join(work, "Users-me-src-x"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("parseCursorSession — falls back to Shell working_directory when no trust file", async () => {
  const cfg = loadConfig({ env: {}, ignoreFile: "/nonexistent" });
  const home = mkdtempSync(join(tmpdir(), "momento-cursor-cwd-"));
  const projectDir = join(home, "proj");
  const sessionId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
  const sessionDir = join(projectDir, "agent-transcripts", sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const jsonlPath = join(sessionDir, `${sessionId}.jsonl`);
  copyFileSync(join(FIX, "cursor-transcript.jsonl"), jsonlPath);
  try {
    const result = await parseCursorSession(jsonlPath, cfg);
    assert.equal(result.meta.projectPath, "/Users/me/src/repo-x");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cleanFirstPrompt strips Cursor <timestamp> / <user_query> wrappers", () => {
  const cleaned = cleanFirstPrompt(
    "<timestamp>Monday, Oct 5, 2026</timestamp>\n<user_query>\nfix the bug\n</user_query>",
  );
  assert.equal(cleaned, "fix the bug");
});

test("CURSOR_FILE_TOOL_OP drift sentinel keys", () => {
  assert.deepEqual(Object.keys(CURSOR_FILE_TOOL_OP).sort(), [
    "Delete",
    "Edit",
    "MultiEdit",
    "Read",
    "StrReplace",
    "Write",
  ]);
});

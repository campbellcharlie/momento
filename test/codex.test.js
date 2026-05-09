import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseCodexSession, iterateCodexSessions } from "../dist/codex.js";
import { loadConfig } from "../dist/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");

test("parseCodexSession — RolloutLine envelope: messages, tool calls, file touches", async () => {
  const cfg = loadConfig({ env: {}, ignoreFile: "/nonexistent" });
  const result = await parseCodexSession(join(FIX, "codex-rollout.jsonl"), cfg);
  assert.equal(result.sessionId, "019ad326-d431-7713-bd5d-0b53772086fe");
  assert.equal(result.meta.projectPath, "/Users/me/src/repo-x");
  assert.equal(result.meta.gitBranch, "main");
  assert.equal(result.meta.created, "2026-04-12T10:00:00Z");

  const userMsg = result.messages.find((m) => m.role === "user");
  const assistantMsg = result.messages.find((m) => m.role === "assistant");
  assert.ok(userMsg && userMsg.text.includes("rate-limit retry"));
  assert.ok(assistantMsg && assistantMsg.text.includes("exponential backoff"));

  // reasoning blocks are excluded by default — config.indexThinking is false.
  const reasoningLeak = result.messages.find((m) => m.text.includes("backoff strategy"));
  assert.equal(reasoningLeak, undefined, "reasoning leaked into messages");

  const readCall = result.toolCalls.find((t) => t.toolName === "read_file");
  assert.ok(readCall, "read_file tool call missing");
  assert.match(readCall.inputJson, /\/Users\/me\/src\/repo-x\/src\/api\.ts/);

  // recordFileTouch tries realpathSync; fixture path doesn't exist on disk so it
  // keeps the literal value. Either way, the touch should be recorded.
  assert.equal(result.filesTouched.length, 1);
  assert.equal(result.filesTouched[0].operation, "read");
});

test("parseCodexSession — includes reasoning when MOMENTO_INDEX_THINKING=1", async () => {
  const cfg = loadConfig({ env: { MOMENTO_INDEX_THINKING: "1" }, ignoreFile: "/nonexistent" });
  const result = await parseCodexSession(join(FIX, "codex-rollout.jsonl"), cfg);
  const reasoning = result.messages.find((m) => m.text.includes("backoff strategy"));
  assert.ok(reasoning, "reasoning was supposed to be indexed");
});

test("parseCodexSession — legacy bare lines (pre-RolloutLine envelope)", async () => {
  const cfg = loadConfig({ env: {}, ignoreFile: "/nonexistent" });
  const result = await parseCodexSession(join(FIX, "codex-rollout-legacy.jsonl"), cfg);
  assert.equal(result.sessionId, "legacy-session-id");
  assert.equal(result.meta.projectPath, "/Users/me/src/legacy-repo");
  assert.equal(result.messages.length, 2);
  assert.ok(result.messages.some((m) => m.role === "user" && m.text.includes("pre-RolloutLine")));
  assert.ok(result.messages.some((m) => m.role === "assistant" && m.text.includes("legacy format")));
});

test("iterateCodexSessions — walks YYYY/MM/DD partitions", async () => {
  const work = mkdtempSync(join(tmpdir(), "momento-codex-"));
  try {
    const day = join(work, "2026", "04", "12");
    mkdirSync(day, { recursive: true });
    copyFileSync(
      join(FIX, "codex-rollout.jsonl"),
      join(day, "rollout-2026-04-12T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"),
    );
    const refs = [];
    for await (const ref of iterateCodexSessions(work)) refs.push(ref);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].sessionId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

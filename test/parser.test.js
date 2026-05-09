import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseSession, cleanFirstPrompt } from "../dist/parser.js";
import { loadConfig } from "../dist/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");

test("parseSession excludes assistant thinking blocks by default", async () => {
  const cfg = loadConfig({ env: {}, ignoreFile: "/nonexistent" });
  const parsed = await parseSession(join(FIX, "basic-session.jsonl"), cfg);
  const all = parsed.messages.map((m) => m.text).join("\n");
  assert.ok(!all.includes("sk-test-SHOULD-NEVER-INDEX"), "thinking block leaked");
  assert.ok(all.includes("rate-limit"), "user prompt missing");
  assert.ok(all.includes("exponential backoff"), "assistant reply missing");
});

test("parseSession includes thinking when MOMENTO_INDEX_THINKING=1", async () => {
  const cfg = loadConfig({
    env: { MOMENTO_INDEX_THINKING: "1" },
    ignoreFile: "/nonexistent",
  });
  const parsed = await parseSession(join(FIX, "basic-session.jsonl"), cfg);
  const all = parsed.messages.map((m) => m.text).join("\n");
  assert.ok(all.includes("sk-test-SHOULD-NEVER-INDEX"), "opt-in failed");
});

test("parseSession records file touches with operation", async () => {
  const cfg = loadConfig({ env: {}, ignoreFile: "/nonexistent" });
  const parsed = await parseSession(join(FIX, "basic-session.jsonl"), cfg);
  const ops = parsed.filesTouched.map((f) => f.operation).sort();
  assert.deepEqual(ops, ["edit", "read"]);
});

test("parseSession survives malformed JSON lines", async () => {
  const cfg = loadConfig({ env: {}, ignoreFile: "/nonexistent" });
  const parsed = await parseSession(join(FIX, "malformed-session.jsonl"), cfg);
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0].role, "user");
  assert.equal(parsed.messages[1].role, "assistant");
});

test("parseSession honors MOMENTO_EXCLUDE_PATHS", async () => {
  const cfg = loadConfig({
    env: { MOMENTO_EXCLUDE_PATHS: "private-secrets" },
    ignoreFile: "/nonexistent",
  });
  const parsed = await parseSession(join(FIX, "secrets-session.jsonl"), cfg);
  const paths = parsed.filesTouched.map((f) => f.filePath);
  assert.equal(paths.length, 1, `expected 1 touch, got ${paths.length}: ${paths.join(",")}`);
  assert.ok(paths[0].includes("normal.ts"));
  assert.ok(!paths.some((p) => p.includes("private-secrets")));
});

test("cleanFirstPrompt strips known wrapper prefixes", () => {
  assert.equal(cleanFirstPrompt(null), null);
  assert.equal(cleanFirstPrompt(""), null);
  assert.equal(cleanFirstPrompt("TASK: do the thing"), "do the thing");
  assert.equal(cleanFirstPrompt("CURRENT MESSAGE: real prompt"), "real prompt");
  assert.equal(cleanFirstPrompt("just plain text"), "just plain text");
});

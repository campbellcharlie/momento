// Parser conformance + drift sentinel across all three CLIs. Asserts each
// parser's normalized output (message roles, tool-call names, file-touches) for
// a synthetic fixture, so an upstream format change fails a test instead of
// silently dropping data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseSession, FILE_TOOL_OP as CLAUDE_FILE_TOOLS } from "../dist/parser.js";
import { parseCodexSession, FILE_TOOL_OP as CODEX_FILE_TOOLS } from "../dist/codex.js";
import {
  parseGeminiSession,
  resetGeminiProjectMap,
  GEMINI_FILE_TOOL_OP,
} from "../dist/gemini.js";
import { loadConfig } from "../dist/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");
const CFG = loadConfig({ env: {}, ignoreFile: "/nonexistent" });

// Shared normalized view of a parsed session for order-independent comparison.
function normalize(parsed) {
  return {
    roles: parsed.messages.map((m) => m.role),
    tools: parsed.toolCalls.map((t) => t.toolName).sort(),
    touches: parsed.filesTouched
      .map((f) => [basename(f.filePath), f.operation, f.source])
      .sort((a, b) => a.join().localeCompare(b.join())),
  };
}

test("conformance — Claude parser normalized output", async () => {
  const parsed = await parseSession(join(FIX, "basic-session.jsonl"), CFG);
  assert.deepEqual(normalize(parsed), {
    roles: ["user", "assistant", "assistant", "user"],
    tools: ["Edit", "Read"],
    touches: [
      ["api.ts", "edit", "native"],
      ["api.ts", "read", "native"],
    ],
  });
});

test("conformance — Codex parser normalized output", async () => {
  const parsed = await parseCodexSession(join(FIX, "codex-rollout.jsonl"), CFG);
  assert.deepEqual(normalize(parsed), {
    roles: ["user", "assistant"],
    tools: ["read_file"],
    touches: [["api.ts", "read", "native"]],
  });
});

test("conformance — Gemini parser normalized output (incl. toolCalls)", async () => {
  // Build a throwaway ~/.gemini tree so projectHash resolution runs cleanly.
  const home = mkdtempSync(join(tmpdir(), "momento-conf-gem-"));
  const projectPath = "/Users/me/src/test-repo";
  const hash = createHash("sha256").update(projectPath).digest("hex");
  const chatsDir = join(home, ".gemini", "tmp", hash, "chats");
  mkdirSync(chatsDir, { recursive: true });
  const fixture = JSON.parse(readFileSync(join(FIX, "gemini-session.json"), "utf8"));
  fixture.projectHash = hash;
  const sessionFile = join(chatsDir, "session-2026-03-15T08-00-deadbeef.json");
  writeFileSync(sessionFile, JSON.stringify(fixture));
  resetGeminiProjectMap();
  try {
    const parsed = await parseGeminiSession(sessionFile, CFG);
    assert.deepEqual(normalize(parsed), {
      roles: ["user", "assistant"],
      tools: [
        "mcp_serval_go",
        "read_file",
        "replace",
        "run_shell_command",
        "write_file",
        "write_file",
      ],
      touches: [
        ["edit.ts", "edit", "native"],
        ["gen.txt", "write", "inferred"],
        ["out.ts", "write", "native"],
        ["read.ts", "read", "native"],
      ],
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Drift sentinel: the exact set of tool names each parser treats as native
// file-ops. If an upstream CLI renames a tool (e.g. Codex drops `apply_patch`),
// this fails loudly rather than silently missing file activity.
test("drift sentinel — recognized native file-op tool names are stable", () => {
  assert.deepEqual(Object.keys(CLAUDE_FILE_TOOLS).sort(), [
    "Edit",
    "MultiEdit",
    "Read",
    "Write",
  ]);
  assert.deepEqual(Object.keys(CODEX_FILE_TOOLS).sort(), [
    "apply_patch",
    "edit_file",
    "read_file",
    "shell",
    "write_file",
  ]);
  assert.deepEqual(Object.keys(GEMINI_FILE_TOOL_OP).sort(), [
    "read_file",
    "replace",
    "write_file",
  ]);
});

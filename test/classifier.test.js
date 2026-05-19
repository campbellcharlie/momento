import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTurn, buildTurns, ALL_CATEGORIES } from "../dist/classifier.js";

// Sanity: the enum exported for MCP schema enum matches what classifyTurn
// can actually emit. Any drift here means the MCP tool advertises a category
// the classifier can't produce (or vice versa).
test("ALL_CATEGORIES covers every classifyTurn output path", () => {
  const expected = new Set([
    "coding", "debugging", "feature", "refactoring", "testing", "exploration",
    "planning", "delegation", "git", "build/deploy", "conversation",
    "brainstorming", "general",
  ]);
  assert.deepEqual(new Set(ALL_CATEGORIES), expected);
});

test("tool-presence beats keywords: Edit -> coding subcategorized", () => {
  const cat = classifyTurn({
    userMessage: "add a new logging helper",
    tools: ["Edit"],
    bashCommands: [],
    timestamp: "2026-05-18T20:00:00Z",
  });
  assert.equal(cat, "feature"); // refineByKeywords flips coding -> feature
});

test("refactor wins over feature when both keywords match", () => {
  const cat = classifyTurn({
    userMessage: "refactor and add cleanup helpers",
    tools: ["Edit"],
    bashCommands: [],
    timestamp: "",
  });
  assert.equal(cat, "refactoring");
});

test("add error handling stays feature, not debugging (issue #196 case)", () => {
  // The classic codeburn bug: DEBUG_KEYWORDS matches 'error' and FEATURE
  // matches 'add'. First-match-wins means 'add' (position 0) beats 'error'.
  const cat = classifyTurn({
    userMessage: "add error handling to the auth path",
    tools: ["Edit"],
    bashCommands: [],
    timestamp: "",
  });
  assert.equal(cat, "feature");
});

test("Bash + test keyword -> testing", () => {
  const cat = classifyTurn({
    userMessage: "run the test suite",
    tools: ["Bash"],
    bashCommands: ["npm test"],
    timestamp: "",
  });
  assert.equal(cat, "testing");
});

test("Bash + git keyword -> git (caught via bash command, not user msg)", () => {
  const cat = classifyTurn({
    userMessage: "do it",
    tools: ["Bash"],
    bashCommands: ["git push origin main"],
    timestamp: "",
  });
  assert.equal(cat, "git");
});

test("Task tool spawns -> delegation", () => {
  const cat = classifyTurn({
    userMessage: "split this across two agents",
    tools: ["Task"],
    bashCommands: [],
    timestamp: "",
  });
  assert.equal(cat, "delegation");
});

test("ExitPlanMode -> planning regardless of keywords", () => {
  const cat = classifyTurn({
    userMessage: "fix the bug",
    tools: ["ExitPlanMode"],
    bashCommands: [],
    timestamp: "",
  });
  assert.equal(cat, "planning");
});

test("Read-only tools -> exploration", () => {
  const cat = classifyTurn({
    userMessage: "what does this module do",
    tools: ["Read", "Grep"],
    bashCommands: [],
    timestamp: "",
  });
  assert.equal(cat, "exploration");
});

test("chat-only with brainstorm keyword -> brainstorming", () => {
  const cat = classifyTurn({
    userMessage: "what if we approached this differently",
    tools: [],
    bashCommands: [],
    timestamp: "",
  });
  assert.equal(cat, "brainstorming");
});

test("buildTurns pairs user -> following assistants with tool calls", () => {
  const messages = [
    { role: "user", text: "fix the auth bug", timestamp: "2026-05-18T20:00:00Z" },
    { role: "assistant", text: "looking", timestamp: "2026-05-18T20:00:05Z" },
    { role: "assistant", text: "found it", timestamp: "2026-05-18T20:00:10Z" },
    { role: "user", text: "now ship it", timestamp: "2026-05-18T20:01:00Z" },
    { role: "assistant", text: "done", timestamp: "2026-05-18T20:01:05Z" },
  ];
  const toolCalls = [
    { toolName: "Read", inputJson: "{}", timestamp: "2026-05-18T20:00:05Z" },
    { toolName: "Edit", inputJson: "{}", timestamp: "2026-05-18T20:00:10Z" },
    { toolName: "Bash", inputJson: '{"command":"git push"}', timestamp: "2026-05-18T20:01:05Z" },
  ];
  const turns = buildTurns(messages, toolCalls);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].userMessage, "fix the auth bug");
  assert.deepEqual(turns[0].tools, ["Read", "Edit"]);
  assert.equal(turns[1].userMessage, "now ship it");
  assert.deepEqual(turns[1].tools, ["Bash"]);
  assert.deepEqual(turns[1].bashCommands, ["git push"]);
});

test("buildTurns drops orphan assistant messages with no preceding user", () => {
  const turns = buildTurns(
    [{ role: "assistant", text: "system primer", timestamp: "t1" }],
    [],
  );
  assert.equal(turns.length, 0);
});

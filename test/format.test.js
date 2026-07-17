import { test } from "node:test";
import assert from "node:assert/strict";
import { formatToolResult, MAX_RESULT_CHARS } from "../dist/format.js";

test("format — empty hit-list returns a narrow-your-query steer, not a bare []", () => {
  const out = formatToolResult("search", []);
  assert.match(out, /No results for "search"/);
  assert.match(out, /rarer, more specific terms/);
});

test("format — oversized result is truncated with an explicit marker (never silent)", () => {
  const big = Array.from({ length: 5000 }, (_, i) => ({ i, blob: "x".repeat(50) }));
  const out = formatToolResult("get_recent", big);
  assert.match(out, /\[TRUNCATED: "get_recent" returned \d+ chars/);
  assert.match(out, /narrow the query or lower 'limit'/);
  // body shown is bounded by the cap (+ the appended marker)
  assert.ok(out.length < MAX_RESULT_CHARS + 400, `capped length, got ${out.length}`);
});

test("format — normal result passes through unchanged and stays valid JSON", () => {
  const r = [{ session: "abc", rating: 2536 }];
  const out = formatToolResult("search", r);
  assert.deepEqual(JSON.parse(out), r);
});

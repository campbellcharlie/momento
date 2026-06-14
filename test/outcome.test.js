import { test } from "node:test";
import assert from "node:assert/strict";
import { detectOutcome } from "../dist/outcome.js";

const u = (text) => ({ role: "user", text });
const a = (text) => ({ role: "assistant", text });

test("closing approval => success", () => {
  assert.equal(detectOutcome([u("fix the bug"), a("done"), u("that worked, thanks")], []), "success");
});

test("closing revert/broken => failure", () => {
  assert.equal(detectOutcome([u("fix it"), a("ok"), u("no, still broken, revert it")], []), "failure");
});

test("approval AND rejection in window => mixed", () => {
  assert.equal(
    detectOutcome([u("looks good but it's still broken on iPad")], []),
    "mixed",
  );
});

test("a git commit is a weak positive when no verdict given", () => {
  assert.equal(
    detectOutcome([u("add the feature"), a("added")], [{ inputJson: '{"command":"git commit -m x"}' }]),
    "success",
  );
});

test("no signal => null (unknown, never assumed-failure)", () => {
  assert.equal(detectOutcome([u("what does this function do?")], []), null);
});

test("mid-work 'still broken' does not count if not in the closing window", () => {
  const msgs = [u("still broken"), ...Array.from({ length: 6 }, () => u("keep going")), u("perfect, thanks")];
  assert.equal(detectOutcome(msgs, []), "success");
});

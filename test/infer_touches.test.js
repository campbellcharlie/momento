import { test } from "node:test";
import assert from "node:assert/strict";
import { inferShellFileTouches, extractShellCommand } from "../dist/infer_touches.js";

const TS = "2026-07-03T00:00:00Z";

function paths(cmd) {
  return inferShellFileTouches(cmd, TS)
    .map((t) => t.filePath)
    .sort();
}

test("redirect `>` yields one inferred write", () => {
  const touches = inferShellFileTouches("echo x > out.txt", TS);
  assert.equal(touches.length, 1);
  assert.equal(touches[0].filePath, "out.txt");
  assert.equal(touches[0].operation, "write");
  assert.equal(touches[0].source, "inferred");
});

test("append `>>` is still recorded", () => {
  assert.deepEqual(paths("cmd >> log"), ["log"]);
});

test("tee -a writes its file argument", () => {
  assert.deepEqual(paths("echo hi | tee -a f.log"), ["f.log"]);
});

test("sed -i infers the edited file", () => {
  assert.deepEqual(paths("sed -i 's/a/b/' config.ini"), ["config.ini"]);
});

test("cp/mv target the destination operand", () => {
  assert.deepEqual(paths("cp src.ts dst.ts"), ["dst.ts"]);
  assert.deepEqual(paths("mv a.txt b.txt"), ["b.txt"]);
});

test("/dev/null redirects are ignored", () => {
  assert.deepEqual(paths("cat foo > /dev/null"), []);
});

test("unexpanded variables are ignored", () => {
  assert.deepEqual(paths("echo $VAR > $f"), []);
  assert.deepEqual(paths("echo x > $OUT"), []);
});

test("globs are ignored", () => {
  assert.deepEqual(paths("cat *.log > all-*.txt"), []);
});

test("a plain pipe with no writer records nothing", () => {
  assert.deepEqual(paths("foo | grep x"), []);
});

test("quoted target has quotes stripped", () => {
  assert.deepEqual(paths('echo x > "my file.txt"'), ["my file.txt"]);
});

test("multiple segments are each parsed", () => {
  assert.deepEqual(paths("echo a > one.txt && echo b > two.txt"), [
    "one.txt",
    "two.txt",
  ]);
});

test("duplicate targets are de-duplicated", () => {
  assert.deepEqual(paths("echo a > f.txt; echo b >> f.txt"), ["f.txt"]);
});

test("empty command returns nothing", () => {
  assert.deepEqual(inferShellFileTouches("", TS), []);
});

test("extractShellCommand handles string and argv-array forms", () => {
  assert.equal(extractShellCommand({ command: "echo x > f" }), "echo x > f");
  assert.equal(
    extractShellCommand({ command: ["bash", "-lc", "echo x > f"] }),
    "bash -lc echo x > f",
  );
  assert.equal(extractShellCommand({ other: 1 }), null);
  assert.equal(extractShellCommand(null), null);
});

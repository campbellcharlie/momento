import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, projectExcluded, pathExcluded } from "../dist/config.js";

function withTempIgnore(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), "momento-cfg-"));
  const path = join(dir, ".momentoignore");
  writeFileSync(path, contents);
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadConfig defaults to no thinking, no excludes", () => {
  const cfg = loadConfig({ env: {}, ignoreFile: "/nonexistent" });
  assert.equal(cfg.indexThinking, false);
  assert.deepEqual(cfg.excludeProjects, []);
  assert.deepEqual(cfg.excludePaths, []);
});

test("loadConfig respects MOMENTO_INDEX_THINKING flag forms", () => {
  for (const v of ["1", "true", "yes", "TRUE"]) {
    const cfg = loadConfig({ env: { MOMENTO_INDEX_THINKING: v }, ignoreFile: "/nonexistent" });
    assert.equal(cfg.indexThinking, true, `value ${v} should enable`);
  }
  for (const v of ["", "0", "false", "no"]) {
    const cfg = loadConfig({ env: { MOMENTO_INDEX_THINKING: v }, ignoreFile: "/nonexistent" });
    assert.equal(cfg.indexThinking, false, `value ${v} should not enable`);
  }
});

test("loadConfig parses colon and comma separated env lists", () => {
  const cfg = loadConfig({
    env: {
      MOMENTO_EXCLUDE_PROJECTS: "client-foo:internal-bar",
      MOMENTO_EXCLUDE_PATHS: "/secrets,/personal",
    },
    ignoreFile: "/nonexistent",
  });
  assert.deepEqual(cfg.excludeProjects, ["client-foo", "internal-bar"]);
  assert.deepEqual(cfg.excludePaths, ["/secrets", "/personal"]);
});

test("loadConfig reads .momentoignore lines, ignores comments and blanks", () => {
  withTempIgnore("# comment\n\n/private\nproject:client-x\n  /also-private  \n", (path) => {
    const cfg = loadConfig({ env: {}, ignoreFile: path });
    assert.deepEqual(cfg.excludePaths, ["/private", "/also-private"]);
    assert.deepEqual(cfg.excludeProjects, ["client-x"]);
  });
});

test("projectExcluded / pathExcluded are substring matches", () => {
  const cfg = loadConfig({
    env: {
      MOMENTO_EXCLUDE_PROJECTS: "client-foo",
      MOMENTO_EXCLUDE_PATHS: "/secrets",
    },
    ignoreFile: "/nonexistent",
  });
  assert.ok(projectExcluded(cfg, "/Users/me/.claude/projects/-client-foo-app"));
  assert.ok(!projectExcluded(cfg, "/Users/me/.claude/projects/-other"));
  assert.ok(pathExcluded(cfg, "/Users/me/secrets/keys.env"));
  assert.ok(!pathExcluded(cfg, "/Users/me/src/app/foo.ts"));
});

test("missing .momentoignore is silently treated as empty", () => {
  const cfg = loadConfig({ env: {}, ignoreFile: "/no/such/file.ignore" });
  assert.deepEqual(cfg.excludePaths, []);
  assert.deepEqual(cfg.excludeProjects, []);
});

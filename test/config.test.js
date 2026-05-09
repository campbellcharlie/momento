import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  projectExcluded,
  pathExcluded,
  compileRule,
  matchRules,
} from "../dist/config.js";

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
  assert.deepEqual(cfg.rawProjectPatterns, []);
  assert.deepEqual(cfg.rawPathPatterns, []);
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
  assert.deepEqual(cfg.rawProjectPatterns, ["client-foo", "internal-bar"]);
  assert.deepEqual(cfg.rawPathPatterns, ["/secrets", "/personal"]);
});

test("loadConfig reads .momentoignore lines, ignores comments and blanks", () => {
  withTempIgnore("# comment\n\n/private\nproject:client-x\n  /also-private  \n", (path) => {
    const cfg = loadConfig({ env: {}, ignoreFile: path });
    assert.deepEqual(cfg.rawPathPatterns, ["/private", "/also-private"]);
    assert.deepEqual(cfg.rawProjectPatterns, ["client-x"]);
  });
});

test("substring patterns still work (back-compat)", () => {
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

test("compileRule: glob `*.env` matches by basename anywhere in the path", () => {
  const r = compileRule("*.env");
  assert.ok(r.test("/Users/me/src/app/keys.env"));
  assert.ok(r.test("/Users/me/.env"));
  // Should NOT match if the segment name doesn't end in .env (e.g. directory-only).
  assert.ok(!r.test("/Users/me/src/app/.envrc"));
  // Should not match a different basename.
  assert.ok(!r.test("/Users/me/src/app/foo.ts"));
});

test("compileRule: anchored glob `/Users/me/private/*` only matches that prefix", () => {
  const r = compileRule("/Users/me/private/*");
  assert.ok(r.test("/Users/me/private/foo"));
  assert.ok(!r.test("/Users/foo/Users/me/private/foo"));
});

test("compileRule: literal (no glob) falls back to substring match for back-compat", () => {
  const r = compileRule("/secrets");
  assert.ok(r.test("/Users/me/secrets/foo"));
  assert.ok(r.test("/secrets/x"));
  assert.ok(!r.test("/Users/me/safe"));
});

test("compileRule: `**/secrets/**` matches at any depth", () => {
  const r = compileRule("**/secrets/**");
  assert.ok(r.test("/Users/me/src/secrets/keys.env"));
  assert.ok(r.test("/var/secrets/foo"));
  assert.ok(!r.test("/Users/me/src/safe/foo"));
});

test("compileRule: character class `[ab]` works", () => {
  const r = compileRule("foo[12].txt");
  assert.ok(r.test("/x/foo1.txt"));
  assert.ok(r.test("/x/foo2.txt"));
  assert.ok(!r.test("/x/foo3.txt"));
});

test("compileRule: `?` matches single non-/ char", () => {
  const r = compileRule("foo?.txt");
  assert.ok(r.test("/x/fooA.txt"));
  assert.ok(!r.test("/x/foo.txt"));
  assert.ok(!r.test("/x/foo/A.txt"));
});

test("matchRules: negation re-includes a previously excluded path", () => {
  const rules = [compileRule("**/secrets/**"), compileRule("!**/secrets/public/**")];
  assert.equal(matchRules(rules, "/Users/me/secrets/keys.env"), true);
  assert.equal(matchRules(rules, "/Users/me/secrets/public/notes.md"), false);
});

test("loadConfig: end-to-end glob in .momentoignore", () => {
  // Claude Code's project dir slug looks like `-Users-...-foo`, so realistic
  // project filters wildcard both sides to land on the slug body.
  withTempIgnore("**/secrets/**\n!**/secrets/public/**\nproject:*client-*\n", (path) => {
    const cfg = loadConfig({ env: {}, ignoreFile: path });
    assert.ok(pathExcluded(cfg, "/Users/me/src/foo/secrets/k.env"));
    assert.ok(!pathExcluded(cfg, "/Users/me/src/foo/secrets/public/ok.md"));
    assert.ok(projectExcluded(cfg, "/Users/me/.claude/projects/-client-acme"));
    assert.ok(!projectExcluded(cfg, "/Users/me/.claude/projects/-other"));
  });
});

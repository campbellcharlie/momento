import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runRebuild, runStatus, runDoctor, runExplainExclusions } from "../dist/admin.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");

function captureStdout(fn) {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdout.write = (chunk) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  try {
    return { value: fn(), out: buf };
  } finally {
    process.stdout.write = orig;
  }
}

async function captureAsyncStdout(fn) {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = "";
  process.stdout.write = (chunk) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  try {
    const value = await fn();
    return { value, out: buf };
  } finally {
    process.stdout.write = orig;
  }
}

function makePaths() {
  const work = mkdtempSync(join(tmpdir(), "momento-admin-"));
  const projectsRoot = join(work, "projects");
  const proj = join(projectsRoot, "-Users-me-src-repo-a");
  mkdirSync(proj, { recursive: true });
  copyFileSync(join(FIX, "basic-session.jsonl"), join(proj, "sess-basic.jsonl"));
  return {
    work,
    paths: {
      dbDir: work,
      dbPath: join(work, "index.db"),
      projectsRoot,
      ignoreFile: join(work, ".momentoignore"),
      // Isolate from real ~/.codex / ~/.gemini history during tests.
      codexRoot: join(work, "no-codex"),
      geminiRoot: join(work, "no-gemini"),
    },
  };
}

test("runRebuild creates the db and indexes sessions", async () => {
  const { work, paths } = makePaths();
  try {
    const { out } = await captureAsyncStdout(() => runRebuild(paths));
    assert.ok(existsSync(paths.dbPath), "db not created");
    assert.match(out, /rebuild complete/);
    assert.match(out, /1 sessions/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("runStatus reports session counts after rebuild", async () => {
  const { work, paths } = makePaths();
  try {
    await runRebuild(paths);
    const { out } = captureStdout(() => runStatus(paths));
    assert.match(out, /sessions:\s+1/);
    assert.match(out, /index thinking:\s+no/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("runStatus on a missing db is harmless", () => {
  const { work, paths } = makePaths();
  try {
    const { out } = captureStdout(() => runStatus(paths));
    assert.match(out, /no index/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("runDoctor returns non-zero when projects root is missing", () => {
  const work = mkdtempSync(join(tmpdir(), "momento-admin-"));
  try {
    const paths = {
      dbDir: work,
      dbPath: join(work, "index.db"),
      projectsRoot: join(work, "no-such-projects"),
      ignoreFile: join(work, ".momentoignore"),
      codexRoot: join(work, "no-codex"),
      geminiRoot: join(work, "no-gemini"),
    };
    const { value, out } = captureStdout(() => runDoctor(paths));
    assert.equal(value, 2, `expected fail exit, got ${value}: ${out}`);
    assert.match(out, /claude_code root not found/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("runDoctor reports clean after rebuild", async () => {
  const { work, paths } = makePaths();
  try {
    writeFileSync(paths.ignoreFile, "");
    await runRebuild(paths);
    const { value, out } = captureStdout(() => runDoctor(paths));
    // Node 22 will still warn about needing the experimental flag, so accept 0 or 1.
    assert.ok(value === 0 || value === 1, `unexpected exit ${value}: ${out}`);
    assert.match(out, /db has 1 sessions/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// loadConfig reads process.env directly, so we sandbox the MOMENTO_* vars to
// keep these tests independent of the surrounding shell.
function withCleanEnv(fn) {
  const keys = ["MOMENTO_EXCLUDE_PROJECTS", "MOMENTO_EXCLUDE_PATHS", "MOMENTO_INDEX_THINKING"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("runExplainExclusions lists rules with no target", () => {
  const { work, paths } = makePaths();
  try {
    writeFileSync(paths.ignoreFile, "**/secrets/**\nproject:*client-*\n");
    const { value, out } = withCleanEnv(() => captureStdout(() => runExplainExclusions(paths)));
    assert.equal(value, 0);
    assert.match(out, /exclude projects \(1\)/);
    assert.match(out, /\*client-\*/);
    assert.match(out, /exclude paths \(1\)/);
    assert.match(out, /\*\*\/secrets\/\*\*/);
    assert.match(out, /Pass a path to trace/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("runExplainExclusions traces an excluded path and exits 1", () => {
  const { work, paths } = makePaths();
  try {
    writeFileSync(paths.ignoreFile, "**/secrets/**\n");
    const { value, out } = withCleanEnv(() =>
      captureStdout(() => runExplainExclusions(paths, "/Users/me/src/secrets/keys.env")),
    );
    assert.equal(value, 1, `expected excluded; got ${value}\n${out}`);
    assert.match(out, /verdict: EXCLUDED/);
    assert.match(out, /EXCLUDE/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("runExplainExclusions honors negation rules and exits 0", () => {
  const { work, paths } = makePaths();
  try {
    writeFileSync(paths.ignoreFile, "**/secrets/**\n!**/secrets/public/**\n");
    const { value, out } = withCleanEnv(() =>
      captureStdout(() =>
        runExplainExclusions(paths, "/Users/me/src/secrets/public/readme.md"),
      ),
    );
    assert.equal(value, 0, `expected re-included; got ${value}\n${out}`);
    assert.match(out, /RE-INCLUDE/);
    assert.match(out, /verdict: indexed/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("runExplainExclusions on a path with no matching rules reports indexed", () => {
  const { work, paths } = makePaths();
  try {
    writeFileSync(paths.ignoreFile, "**/secrets/**\n");
    const { value, out } = withCleanEnv(() =>
      captureStdout(() => runExplainExclusions(paths, "/Users/me/src/regular/file.ts")),
    );
    assert.equal(value, 0);
    assert.match(out, /verdict: indexed/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

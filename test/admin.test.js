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
import { runRebuild, runStatus, runDoctor } from "../dist/admin.js";

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
    };
    const { value, out } = captureStdout(() => runDoctor(paths));
    assert.equal(value, 2, `expected fail exit, got ${value}: ${out}`);
    assert.match(out, /projects root not found/);
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

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Indexer, defaultSources } from "../dist/indexer.js";
import { loadConfig } from "../dist/config.js";
import { search, findByTopic, findByTopicWithRecency, findSimilar, getRecent, filesTouched } from "../dist/queries.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");

async function buildOnce(env = {}, ignoreContent) {
  const work = mkdtempSync(join(tmpdir(), "momento-idx-"));
  const projects = join(work, "projects");
  mkdirSync(projects, { recursive: true });
  const projA = join(projects, "-Users-me-src-repo-a");
  const projSecrets = join(projects, "-Users-me-src-private-secrets");
  mkdirSync(projA);
  mkdirSync(projSecrets);
  copyFileSync(join(FIX, "basic-session.jsonl"), join(projA, "sess-basic.jsonl"));
  copyFileSync(join(FIX, "secrets-session.jsonl"), join(projSecrets, "sess-secrets.jsonl"));
  copyFileSync(join(FIX, "malformed-session.jsonl"), join(projA, "sess-malformed.jsonl"));

  const ignorePath = join(work, ".momentoignore");
  if (ignoreContent !== undefined) writeFileSync(ignorePath, ignoreContent);

  const cfg = loadConfig({
    env,
    ignoreFile: ignoreContent !== undefined ? ignorePath : "/nonexistent",
  });
  const dbPath = join(work, "index.db");
  const indexer = new Indexer(dbPath, cfg);
  await indexer.buildAll(projects);
  return {
    root: projects,
    dbPath,
    indexer,
    cleanup: () => {
      indexer.close();
      rmSync(work, { recursive: true, force: true });
    },
  };
}

test("Indexer.buildAll indexes sessions and supports search", async () => {
  const fx = await buildOnce();
  try {
    const hits = search(fx.indexer.db, "rate-limit");
    assert.ok(hits.length >= 1, "expected at least one hit");
    assert.equal(hits[0].sessionId, "sess-basic");

    const leaks = search(fx.indexer.db, "SHOULD-NEVER-INDEX");
    assert.equal(leaks.length, 0, "thinking content leaked into search");
  } finally {
    fx.cleanup();
  }
});

test("Indexer skips excluded projects entirely", async () => {
  const fx = await buildOnce({ MOMENTO_EXCLUDE_PROJECTS: "private-secrets" });
  try {
    const recent = getRecent(fx.indexer.db, 50);
    const ids = recent.map((s) => s.id);
    assert.ok(ids.includes("sess-basic"));
    assert.ok(!ids.includes("sess-secrets"), "excluded project still indexed");
  } finally {
    fx.cleanup();
  }
});

test("Indexer drops touches under excluded paths", async () => {
  const fx = await buildOnce({ MOMENTO_EXCLUDE_PATHS: "private-secrets" });
  try {
    const touches = filesTouched(fx.indexer.db, "%");
    for (const t of touches) {
      assert.ok(!t.filePath.includes("private-secrets"), `leaked: ${t.filePath}`);
      assert.equal(t.source, "native");
    }
  } finally {
    fx.cleanup();
  }
});

test(".momentoignore drives both project and path excludes", async () => {
  const ignore = "# privacy\nproject:private-secrets\n";
  const fx = await buildOnce({}, ignore);
  try {
    const recent = getRecent(fx.indexer.db, 50);
    assert.ok(!recent.some((s) => s.id === "sess-secrets"));
  } finally {
    fx.cleanup();
  }
});

test("findByTopic returns a session when the prompt overlaps", async () => {
  const fx = await buildOnce();
  try {
    const hits = findByTopic(fx.indexer.db, "rate-limit api client backoff");
    const ids = hits.map((h) => h.id);
    assert.ok(ids.includes("sess-basic"), `missing sess-basic in ${ids.join(",")}`);
  } finally {
    fx.cleanup();
  }
});

test("findSimilar deprecated alias still works", async () => {
  const fx = await buildOnce();
  try {
    const hits = findSimilar(fx.indexer.db, "rate-limit api");
    assert.ok(hits.length >= 1);
  } finally {
    fx.cleanup();
  }
});

test("findByTopicWithRecency returns matching sessions with positive RRF score", async () => {
  const fx = await buildOnce();
  try {
    const hits = findByTopicWithRecency(fx.indexer.db, "rate-limit api client backoff");
    assert.ok(hits.length >= 1, "expected at least one hit");
    assert.ok(
      hits.every((h) => typeof h.score === "number" && h.score > 0),
      "RRF scores should all be positive (higher is better)",
    );
    // Same matching set as findByTopic — recency only re-ranks within candidates.
    const baseline = findByTopic(fx.indexer.db, "rate-limit api client backoff");
    assert.deepEqual(
      new Set(hits.map((h) => h.id)),
      new Set(baseline.map((h) => h.id)),
      "recency lane should not change the candidate set, only the order",
    );
  } finally {
    fx.cleanup();
  }
});

test("DB file is created and contains expected tables", async () => {
  const fx = await buildOnce();
  try {
    const rows = fx.indexer.db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')")
      .all();
    const names = rows.map((r) => r.name);
    for (const t of ["sessions", "messages_fts", "sessions_fts", "tool_calls", "file_touches"]) {
      assert.ok(names.includes(t), `missing table/vt ${t}`);
    }
    assert.ok(readFileSync(fx.dbPath).length > 0);
  } finally {
    fx.cleanup();
  }
});

// watchSources() has no other coverage, and the mechanism underneath it was
// swapped from chokidar to native recursive fs.watch — these pin the contract
// it has to keep: new files get indexed, deleted files get dropped, and the
// whole tree costs a bounded number of descriptors rather than one per file.
async function until(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test("watchSources indexes a session created after the watch starts", async () => {
  const work = mkdtempSync(join(tmpdir(), "momento-watch-"));
  const projects = join(work, ".claude", "projects");
  const projA = join(projects, "-Users-me-src-repo-a");
  mkdirSync(projA, { recursive: true });
  const indexer = new Indexer(join(work, "index.db"), loadConfig({ env: {}, ignoreFile: "/nonexistent" }));
  const source = defaultSources(work).find((s) => s.client === "claude_code");
  try {
    indexer.watchSources([source]);
    const target = join(projA, "sess-basic.jsonl");
    copyFileSync(join(FIX, "basic-session.jsonl"), target);
    const indexed = await until(
      () => getRecent(indexer.db, 50).some((s) => s.id === "sess-basic"),
    );
    assert.ok(indexed, "watcher never indexed the new session");

    rmSync(target);
    const removed = await until(
      () => !getRecent(indexer.db, 50).some((s) => s.id === "sess-basic"),
    );
    assert.ok(removed, "watcher never removed the deleted session");
  } finally {
    indexer.close();
    rmSync(work, { recursive: true, force: true });
  }
});

test("watchSources ignores files outside the source extension", async () => {
  const work = mkdtempSync(join(tmpdir(), "momento-watch-ext-"));
  const projA = join(work, ".claude", "projects", "-Users-me-src-repo-a");
  mkdirSync(projA, { recursive: true });
  const indexer = new Indexer(join(work, "index.db"), loadConfig({ env: {}, ignoreFile: "/nonexistent" }));
  const source = defaultSources(work).find((s) => s.client === "claude_code");
  try {
    indexer.watchSources([source]);
    writeFileSync(join(projA, "notes.md"), "not a transcript");
    writeFileSync(join(projA, "sess-basic.jsonl"), readFileSync(join(FIX, "basic-session.jsonl")));
    assert.ok(
      await until(() => getRecent(indexer.db, 50).some((s) => s.id === "sess-basic")),
      "the .jsonl sibling should still have been indexed",
    );
    const ids = getRecent(indexer.db, 50).map((s) => s.id);
    assert.deepEqual(ids, ["sess-basic"], "a non-transcript file produced a session row");
  } finally {
    indexer.close();
    rmSync(work, { recursive: true, force: true });
  }
});

test("watchSources tolerates a source root that does not exist yet", async () => {
  const work = mkdtempSync(join(tmpdir(), "momento-watch-missing-"));
  const indexer = new Indexer(join(work, "index.db"), loadConfig({ env: {}, ignoreFile: "/nonexistent" }));
  const source = defaultSources(join(work, "absent")).find((s) => s.client === "claude_code");
  try {
    assert.doesNotThrow(() => indexer.watchSources([source]));
  } finally {
    indexer.close();
    rmSync(work, { recursive: true, force: true });
  }
});

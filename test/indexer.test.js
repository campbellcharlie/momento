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
import { Indexer } from "../dist/indexer.js";
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

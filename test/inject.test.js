import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Indexer } from "../dist/indexer.js";
import { loadConfig } from "../dist/config.js";

function writeSession(sessionPath, sessionId, repoPath, userText, assistantText, filePath) {
  const entries = [
    {
      type: "user",
      uuid: `${sessionId}-u1`,
      timestamp: "2026-05-08T10:00:00.000Z",
      sessionId,
      cwd: repoPath,
      gitBranch: "main",
      message: {
        role: "user",
        content: userText,
      },
    },
    {
      type: "assistant",
      uuid: `${sessionId}-a1`,
      timestamp: "2026-05-08T10:00:05.000Z",
      sessionId,
      cwd: repoPath,
      gitBranch: "main",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: assistantText,
          },
          {
            type: "tool_use",
            name: "Edit",
            input: {
              file_path: filePath,
              old_string: "foo",
              new_string: "bar",
            },
          },
        ],
      },
    },
  ];
  writeFileSync(sessionPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

async function buildCliFixture() {
  const home = mkdtempSync(join(tmpdir(), "momento-inject-"));
  const dbDir = join(home, ".momento");
  const srcRoot = join(home, "src");
  const repoA = join(srcRoot, "repo-a");
  const repoB = join(srcRoot, "repo-b");
  mkdirSync(dbDir, { recursive: true });
  mkdirSync(join(repoA, "src"), { recursive: true });
  mkdirSync(join(repoB, "src"), { recursive: true });

  writeSession(
    join(repoA, "sess-a.jsonl"),
    "sess-a",
    repoA,
    "please fix the rate-limit retry logic in the api client",
    "I added rate-limit retry logic for the API client with exponential backoff.",
    join(repoA, "src", "api.ts"),
  );
  writeSession(
    join(repoB, "sess-b.jsonl"),
    "sess-b",
    repoB,
    "what was that enable_burst_mode flag for the API rate-limit hack",
    "The API rate-limit hack depended on the enable_burst_mode flag.",
    join(repoB, "src", "flags.ts"),
  );

  const cfg = loadConfig({ env: {}, ignoreFile: join(home, ".momentoignore") });
  const indexer = new Indexer(join(dbDir, "index.db"), cfg);
  await indexer.buildAll(srcRoot);
  indexer.close();
  return {
    home,
    repoA,
    repoB,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

function runInject(home, cwd, prompt, extraEnv = {}, useArgv = false) {
  const args = [join(process.cwd(), "dist/cli.js")];
  if (useArgv) args.push(prompt);
  return spawnSync(process.execPath, args, {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      MOMENTO_SRC_ROOTS: join(home, "src"),
      MOMENTO_INJECT_DEBUG: "1",
      ...extraEnv,
    },
    input: useArgv ? undefined : prompt,
    encoding: "utf8",
  });
}

function readLastDebugEntry(home) {
  const debugLog = join(home, ".momento", "inject.log");
  assert.ok(existsSync(debugLog), "expected inject debug log");
  const lines = readFileSync(debugLog, "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

test("momento-inject skips short mechanical prompts and writes a debug decision", async () => {
  const fx = await buildCliFixture();
  try {
    const result = runInject(fx.home, fx.repoA, "continue");
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");

    const last = readLastDebugEntry(fx.home);
    assert.equal(last.reason, "mechanical_prompt");
  } finally {
    fx.cleanup();
  }
});

test("momento-inject injects same-repo history for a substantive prompt with a strong match", async () => {
  const fx = await buildCliFixture();
  try {
    const result = runInject(fx.home, fx.repoA, "please fix the rate-limit retry logic in the api client");
    assert.equal(result.status, 0);
    assert.match(result.stdout, /<!-- momento: relevant past sessions -->/);
    assert.match(result.stdout, /sess-a/);

    const last = readLastDebugEntry(fx.home);
    assert.equal(last.reason, "inject");
    assert.equal(last.selectionReason, "same_repo");
    assert.deepEqual(last.selectedHitIds, ["sess-a"]);
  } finally {
    fx.cleanup();
  }
});

test("momento-inject can read the prompt from argv when stdin is empty", async () => {
  const fx = await buildCliFixture();
  try {
    const result = runInject(
      fx.home,
      fx.repoA,
      "please fix the rate-limit retry logic in the api client",
      {},
      true,
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout, /sess-a/);
  } finally {
    fx.cleanup();
  }
});

test("momento-inject applies score floor on OR-fallback matches", async () => {
  // A prompt where no single document contains ALL the rare tokens forces
  // findByTopicRanked into OR fallback, where MIN_SCORE acts as the floor.
  const fx = await buildCliFixture();
  try {
    const result = runInject(
      fx.home,
      fx.repoA,
      "kubernetes deployment manifests with rate-limit", // unique terms miss; OR fallback matches rate/limit
      { MOMENTO_INJECT_MIN_SCORE: "-100" },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");

    const last = readLastDebugEntry(fx.home);
    assert.equal(last.matchType, "or");
    assert.equal(last.reason, "low_confidence");
  } finally {
    fx.cleanup();
  }
});

test("momento-inject in a non-repo cwd still injects a strong multi-term match", async () => {
  // cwd = home (not under src root, no .git) → currentRepo null → no_repo_context.
  // A multi-term match must still surface (the fix must not over-suppress).
  const fx = await buildCliFixture();
  try {
    const result = runInject(
      fx.home,
      fx.home,
      "please fix the rate-limit retry logic in the api client",
    );
    assert.equal(result.status, 0);
    const last = readLastDebugEntry(fx.home);
    assert.equal(last.selectionReason, "no_repo_context");
    assert.equal(last.currentRepo, null);
    assert.equal(last.reason, "inject");
    assert.match(result.stdout, /sess-a/);
  } finally {
    fx.cleanup();
  }
});

test("momento-inject in a non-repo cwd gates hits below the matched-term floor", async () => {
  // Same no-repo prompt, but raise the term floor so even the strong match is
  // filtered out → the raw-pool fallback injects nothing (the leak is closed).
  const fx = await buildCliFixture();
  try {
    const result = runInject(
      fx.home,
      fx.home,
      "please fix the rate-limit retry logic in the api client",
      { MOMENTO_INJECT_NO_REPO_MIN_TERMS: "99" },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    const last = readLastDebugEntry(fx.home);
    assert.equal(last.reason, "no_repo_weak_match");
  } finally {
    fx.cleanup();
  }
});

test("momento-inject does not inject cross-repo history for a generic prompt in the current repo context", async () => {
  const fx = await buildCliFixture();
  try {
    const result = runInject(
      fx.home,
      fx.repoA,
      "what was that enable_burst_mode flag for the API rate-limit hack?",
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");

    const last = readLastDebugEntry(fx.home);
    assert.notEqual(last.reason, "inject");
    assert.notEqual(last.selectionReason, "explicit_other_repo");
    assert.ok(
      JSON.stringify(last.selectedHitIds ?? []).indexOf("sess-b") === -1,
      "generic prompt should not inject repo-b history",
    );
    assert.equal(last.currentRepo, realpathSync(fx.repoA));
  } finally {
    fx.cleanup();
  }
});

test("momento-inject filters out the current session id from its own injection", async () => {
  const fx = await buildCliFixture();
  try {
    const payload = JSON.stringify({
      session_id: "sess-a",
      prompt: "please fix the rate-limit retry logic in the api client",
    });
    const result = runInject(fx.home, fx.repoA, payload);
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /sess-a/);

    const last = readLastDebugEntry(fx.home);
    assert.equal(last.currentSessionId, "sess-a");
    assert.equal(last.selfHitFiltered, true);
    assert.ok(
      (last.selectedHitIds ?? []).indexOf("sess-a") === -1,
      "current session id should not appear in selectedHitIds",
    );
  } finally {
    fx.cleanup();
  }
});

test("momento-inject allows cross-repo history when the prompt explicitly names the other repo", async () => {
  const fx = await buildCliFixture();
  try {
    const result = runInject(
      fx.home,
      fx.repoA,
      "what was that repo-b enable_burst_mode flag for the API rate-limit hack?",
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout, /sess-b/);
    assert.doesNotMatch(result.stdout, /sess-a/);

    const last = readLastDebugEntry(fx.home);
    assert.equal(last.reason, "inject");
    assert.equal(last.selectionReason, "explicit_other_repo");
    assert.deepEqual(last.selectedHitIds, ["sess-b"]);
  } finally {
    fx.cleanup();
  }
});

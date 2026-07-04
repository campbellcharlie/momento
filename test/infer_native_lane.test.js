// Proves that a Bash-redirect-inferred touch enriches files_touched but NEVER
// enters the native path-trusted view (get_recent_by_edited_path).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Indexer } from "../dist/indexer.js";
import { loadConfig } from "../dist/config.js";
import { filesTouched, getRecentByEditedPath } from "../dist/queries.js";

test("Bash-redirect touches are inferred and stay out of the native lane", async () => {
  const work = mkdtempSync(join(tmpdir(), "momento-lane-"));
  const projects = join(work, "projects");
  const proj = join(projects, "-Users-me-src-lanerepo");
  mkdirSync(proj, { recursive: true });

  const bashSession = [
    JSON.stringify({
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-05-08T10:00:00.000Z",
      sessionId: "sess-bash",
      cwd: "/Users/me/src/lanerepo",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "echo generated > /Users/me/src/lanerepo/out.txt" },
          },
        ],
      },
    }),
  ].join("\n");
  writeFileSync(join(proj, "sess-bash.jsonl"), bashSession + "\n");

  const cfg = loadConfig({ env: {}, ignoreFile: "/nonexistent" });
  const indexer = new Indexer(join(work, "index.db"), cfg);
  try {
    await indexer.buildAll(projects);

    // The inferred touch is visible in the content view, tagged inferred.
    const touches = filesTouched(indexer.db, "out.txt");
    const inferred = touches.find((t) => t.filePath.endsWith("/out.txt"));
    assert.ok(inferred, "inferred touch missing from files_touched");
    assert.equal(inferred.source, "inferred");

    // ...but the native path-view must NOT surface it.
    const native = getRecentByEditedPath(indexer.db, "/Users/me/src/lanerepo");
    assert.ok(
      !native.some((s) => s.id === "sess-bash"),
      "inferred touch polluted the native path-view",
    );
  } finally {
    indexer.close();
    rmSync(work, { recursive: true, force: true });
  }
});

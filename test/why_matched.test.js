// Provenance (`why` / `whyText`) assertions over a controlled corpus.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Indexer } from "../dist/indexer.js";
import { loadConfig } from "../dist/config.js";
import { search, findByTopic } from "../dist/queries.js";

// Nonsense rare tokens so stopwords / porter stemming never interfere. Each
// prompt is a separate user message; the FIRST one becomes first_prompt (also
// indexed in sessions_fts), so tests that want a pure message-body match put
// their rare tokens in a LATER message.
function session(id, prompts) {
  return (
    prompts
      .map((text, i) =>
        JSON.stringify({
          type: "user",
          uuid: `${id}-u${i}`,
          timestamp: "2026-05-08T10:00:00.000Z",
          sessionId: id,
          cwd: "/Users/me/src/whyrepo",
          message: { role: "user", content: text },
        }),
      )
      .join("\n") + "\n"
  );
}

async function buildCorpus() {
  const work = mkdtempSync(join(tmpdir(), "momento-why-"));
  const projects = join(work, "projects");
  const proj = join(projects, "-Users-me-src-whyrepo");
  mkdirSync(proj, { recursive: true });

  writeFileSync(
    join(proj, "sess-and.jsonl"),
    session("sess-and", [
      "session boot sequence begin",
      "the quantumflux and hyperloop calibration run",
    ]),
  );
  writeFileSync(
    join(proj, "sess-or.jsonl"),
    session("sess-or", [
      "session boot sequence begin",
      "only quantumflux appears here nothing else",
    ]),
  );
  writeFileSync(
    join(proj, "sess-summary.jsonl"),
    session("sess-summary", ["generic body text with no special token"]),
  );
  // Sidecar summary for sess-summary carries a token absent from its body.
  writeFileSync(
    join(proj, "sessions-index.json"),
    JSON.stringify({
      entries: [
        { sessionId: "sess-summary", summary: "summariumtoken widget report" },
      ],
    }),
  );

  const cfg = loadConfig({ env: {}, ignoreFile: "/nonexistent" });
  const indexer = new Indexer(join(work, "index.db"), cfg);
  await indexer.buildAll(projects);
  return { indexer, cleanup: () => { indexer.close(); rmSync(work, { recursive: true, force: true }); } };
}

test("why — AND match names both rare terms in the message field", async () => {
  const fx = await buildCorpus();
  try {
    const hits = findByTopic(fx.indexer.db, "quantumflux hyperloop");
    const hit = hits.find((h) => h.id === "sess-and");
    assert.ok(hit, "sess-and should match");
    assert.ok(hit.why, "why block missing");
    assert.equal(hit.why.matchType, "and");
    assert.deepEqual(hit.why.matchedTerms.sort(), ["hyperloop", "quantumflux"]);
    assert.equal(hit.why.matchField, "message");
    assert.equal(typeof hit.why.score, "number");
    assert.ok(hit.whyText.includes("quantumflux"), "whyText should cite a term");
  } finally {
    fx.cleanup();
  }
});

test("why — OR fallback reports matchType 'or' with the single present term", async () => {
  const fx = await buildCorpus();
  try {
    // zzzmissing appears nowhere → AND fails, OR fallback fires on quantumflux.
    const hits = findByTopic(fx.indexer.db, "quantumflux zzzmissing");
    const hit = hits.find((h) => h.id === "sess-or");
    assert.ok(hit, "sess-or should match via OR");
    assert.equal(hit.why.matchType, "or");
    assert.deepEqual(hit.why.matchedTerms, ["quantumflux"]);
  } finally {
    fx.cleanup();
  }
});

test("why — a summary-only hit reports matchField 'summary'", async () => {
  const fx = await buildCorpus();
  try {
    const hits = findByTopic(fx.indexer.db, "summariumtoken");
    const hit = hits.find((h) => h.id === "sess-summary");
    assert.ok(hit, "sess-summary should match via its summary");
    assert.equal(hit.why.matchField, "summary");
    assert.deepEqual(hit.why.matchedTerms, ["summariumtoken"]);
  } finally {
    fx.cleanup();
  }
});

test("why — search() hits carry provenance and a non-empty whyText", async () => {
  const fx = await buildCorpus();
  try {
    const hits = search(fx.indexer.db, "hyperloop");
    assert.ok(hits.length >= 1);
    for (const h of hits) {
      assert.ok(h.why, "every search hit needs a why block");
      assert.equal(h.why.matchField, "message");
      assert.ok(h.whyText && h.whyText.length > 0);
    }
  } finally {
    fx.cleanup();
  }
});

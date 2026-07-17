import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Indexer } from "../dist/indexer.js";
import { indexLedgerInto, indexAuditInto, indexExternalFast, searchLedger, searchAudit } from "../dist/external.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "mext-"));
  return { indexer: new Indexer(join(dir, "index.db")), dir };
}

test("search_ledger indexes ISE ledger rows and finds them by narrative keyword", () => {
  const { indexer, dir } = freshDb();
  writeFileSync(
    join(dir, "ledger.jsonl"),
    [
      JSON.stringify({ id: "L-1", outcome: "cracked", stack: "flask", vuln_class: "ssti", learned: "quokkabypass via jinja" }),
      JSON.stringify({ id: "L-2", outcome: "misfit", stack: "static", vuln_class: "xss", learned: "unrelated wombat note" }),
    ].join("\n"),
  );
  indexLedgerInto(indexer.db, [dir]);

  const hits = searchLedger(indexer.db, "quokkabypass");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].entry_id, "L-1");
  assert.equal(hits[0].outcome, "cracked");

  // outcome filter
  assert.equal(searchLedger(indexer.db, "note", { outcome: "cracked" }).length, 0);
  assert.equal(searchLedger(indexer.db, "wombat", { outcome: "misfit" }).length, 1);
  indexer.close();
});

test("search_audit indexes marshal audit rows with backend/tool/ok filters, newest-first", () => {
  const { indexer, dir } = freshDb();
  const audit = join(dir, "audit.jsonl");
  writeFileSync(
    audit,
    [
      JSON.stringify({ ts: "2026-07-17T10:00:00Z", event: "call", backend: "serval", tool: "navigate", arg_keys: ["url:str[42]"], ok: true, ms: 412 }),
      JSON.stringify({ ts: "2026-07-17T11:00:00Z", event: "call", backend: "serval", tool: "navigate", arg_keys: ["url:str[9]"], ok: false, ms: 5 }),
      JSON.stringify({ ts: "2026-07-17T12:00:00Z", event: "call", backend: "momento", tool: "search", arg_keys: ["query:str[10]"], ok: true, ms: 3 }),
    ].join("\n"),
  );
  indexAuditInto(indexer.db, [audit]);

  const nav = searchAudit(indexer.db, "navigate");
  assert.equal(nav.length, 2);
  assert.equal(nav[0].ts, "2026-07-17T11:00:00Z"); // newest-first

  assert.equal(searchAudit(indexer.db, "navigate", { backend: "momento" }).length, 0);
  assert.equal(searchAudit(indexer.db, "navigate", { ok: false }).length, 1);
  assert.equal(searchAudit(indexer.db, "search", { backend: "momento" }).length, 1);
  assert.equal(searchAudit(indexer.db, "navigate", { since: "2026-07-17T10:30:00Z" }).length, 1);
  indexer.close();
});

test("external sources are OPTIONAL — absent files never error, searches return []", () => {
  const { indexer, dir } = freshDb();
  // no ledger / audit files exist under dir
  assert.doesNotThrow(() => indexLedgerInto(indexer.db, [dir]));
  assert.doesNotThrow(() => indexAuditInto(indexer.db, [join(dir, "audit.jsonl")]));
  // fast hot-path refresh against a home with no ISE/marshal → must be a no-throw no-op
  assert.doesNotThrow(() => indexExternalFast(indexer.db, { ...process.env, ISE_HOME: dir, MARSHAL_AUDIT: join(dir, "nope.jsonl") }));
  assert.deepEqual(searchLedger(indexer.db, "anything"), []);
  assert.deepEqual(searchAudit(indexer.db, "anything"), []);
  indexer.close();
});

test("re-ingest is idempotent (mtime-gated) — no duplicate rows on repeated indexing", () => {
  const { indexer, dir } = freshDb();
  writeFileSync(join(dir, "ledger.jsonl"), JSON.stringify({ id: "L-9", outcome: "shipped", learned: "narwhaltoken rotation" }));
  indexLedgerInto(indexer.db, [dir]);
  indexLedgerInto(indexer.db, [dir]); // second pass — mtime unchanged
  assert.equal(searchLedger(indexer.db, "narwhaltoken").length, 1);
  indexer.close();
});

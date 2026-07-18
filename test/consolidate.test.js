import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Indexer } from "../dist/indexer.js";
import { indexAuditInto } from "../dist/external.js";
import { consolidateInto, searchFacts, refreshAndConsolidate } from "../dist/consolidate.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "mcons-"));
  return { indexer: new Indexer(join(dir, "index.db")), dir };
}
function writeAudit(path, rows) {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n"));
  utimesSync(path, new Date(), new Date(Date.now() + 5000)); // force a distinct mtime so re-ingest fires
}
const call = (backend, tool, ok) => ({ ts: "2026-07-18T10:00:00Z", event: "call", backend, tool, arg_keys: [], ok, ms: 12 });

test("consolidation derives tool-reliability + ledger-pattern facts, recallable by kind/keyword", () => {
  const { indexer, dir } = freshDb();
  const audit = join(dir, "audit.jsonl");
  writeAudit(audit, [call("serval", "navigate", true), call("serval", "navigate", true), call("serval", "navigate", true), call("serval", "navigate", true), call("serval", "navigate", false)]);
  indexAuditInto(indexer.db, [audit]);
  writeFileSync(
    join(dir, "ledger.jsonl"),
    [
      JSON.stringify({ id: "L-1", outcome: "shipped", persona: "p", stack: "flask", vuln_class: "ssti" }),
      JSON.stringify({ id: "L-2", outcome: "shipped", persona: "p", stack: "flask", vuln_class: "ssti" }),
      JSON.stringify({ id: "L-3", outcome: "shipped", persona: "p", stack: "flask", vuln_class: "ssti" }),
      JSON.stringify({ id: "L-4", outcome: "misfit", persona: "p", stack: "flask", vuln_class: "ssti" }),
    ].join("\n"),
  );

  const r = consolidateInto(indexer.db, { ledgerRoots: [dir], now: "2026-07-18T12:00:00Z" });
  assert.equal(r.tool_reliability, 1);
  assert.equal(r.ledger_pattern, 1);
  assert.equal(r.total_current, 2);

  const tool = searchFacts(indexer.db, { kind: "tool_reliability" });
  assert.equal(tool.length, 1);
  assert.equal(tool[0].subject, "serval.navigate");
  assert.equal(tool[0].n, 5);
  assert.match(tool[0].statement, /4\/5 calls succeeded \(80% reliable\)/);

  const led = searchFacts(indexer.db, { kind: "ledger_pattern" });
  assert.equal(led.length, 1);
  assert.equal(led[0].n, 4);
  assert.match(led[0].statement, /3\/4 positive outcomes \(75% success\)/);

  // keyword search over the fact statement
  assert.equal(searchFacts(indexer.db, { query: "navigate" }).length, 1);
  assert.equal(searchFacts(indexer.db, { query: "flask" }).length, 1);
  indexer.close();
});

test("bi-temporal: a changed claim invalidates the old fact (valid_to) rather than deleting it", () => {
  const { indexer, dir } = freshDb();
  const audit = join(dir, "audit.jsonl");
  writeAudit(audit, [call("serval", "navigate", true), call("serval", "navigate", true), call("serval", "navigate", true), call("serval", "navigate", true), call("serval", "navigate", false)]);
  indexAuditInto(indexer.db, [audit]);
  consolidateInto(indexer.db, { ledgerRoots: [dir], now: "2026-07-18T12:00:00Z" });

  // Five more successful calls → reliability rises → the statement changes.
  writeAudit(audit, [...Array(10)].map((_, i) => call("serval", "navigate", i !== 4)));
  indexAuditInto(indexer.db, [audit]);
  const r = consolidateInto(indexer.db, { ledgerRoots: [dir], now: "2026-07-18T13:00:00Z" });
  assert.equal(r.changed, 1);

  const current = searchFacts(indexer.db, { kind: "tool_reliability" });
  assert.equal(current.length, 1, "only the current belief is returned");
  assert.equal(current[0].n, 10);
  assert.match(current[0].statement, /9\/10 calls succeeded \(90% reliable\)/);

  // the prior belief is retained (invalidated, not deleted) — provenance for "what did I believe, when"
  const all = indexer.db.prepare("SELECT valid_to FROM facts WHERE id = 'tool:serval.navigate' ORDER BY valid_from").all();
  assert.equal(all.length, 2);
  assert.equal(all[0].valid_to, "2026-07-18T13:00:00Z", "old row closed at the new pass time");
  assert.equal(all[1].valid_to, null, "new row is current");
  indexer.close();
});

test("idempotent: re-running an unchanged pass adds no new fact rows", () => {
  const { indexer, dir } = freshDb();
  const audit = join(dir, "audit.jsonl");
  writeAudit(audit, [call("momento", "search", true), call("momento", "search", true), call("momento", "search", true)]);
  indexAuditInto(indexer.db, [audit]);
  consolidateInto(indexer.db, { ledgerRoots: [dir], now: "2026-07-18T12:00:00Z" });
  consolidateInto(indexer.db, { ledgerRoots: [dir], now: "2026-07-18T12:05:00Z" });
  const n = indexer.db.prepare("SELECT COUNT(*) AS n FROM facts").get().n;
  assert.equal(n, 1, "no duplicate/archived rows when the claim is unchanged");
  indexer.close();
});

test("consolidate-on-read: refreshAndConsolidate surfaces NEW audit rows without a manual pass (the recall_facts hot path)", () => {
  const { indexer, dir } = freshDb();
  const audit = join(dir, "audit.jsonl");
  const env = { ...process.env, MARSHAL_AUDIT: audit, ISE_HOME: join(dir, "noledger") }; // isolate from real ~/.marshal + ~/.ise
  writeAudit(audit, [call("alpha", "one", true), call("alpha", "one", true), call("alpha", "one", true)]);
  refreshAndConsolidate(indexer.db, env);
  assert.deepEqual(searchFacts(indexer.db, { kind: "tool_reliability" }).map((f) => f.subject), ["alpha.one"]);

  // a NEW tool shows up in the audit; the very next read must reflect it — no separate consolidate call.
  writeAudit(audit, [call("alpha", "one", true), call("alpha", "one", true), call("alpha", "one", true), call("beta", "two", true), call("beta", "two", true), call("beta", "two", true)]);
  refreshAndConsolidate(indexer.db, env);
  assert.deepEqual(searchFacts(indexer.db, { kind: "tool_reliability" }).map((f) => f.subject).sort(), ["alpha.one", "beta.two"]);
  indexer.close();
});

test("optional & additive: no audit, no ledger → consolidate is a no-throw no-op, recall returns []", () => {
  const { indexer, dir } = freshDb();
  let r;
  assert.doesNotThrow(() => { r = consolidateInto(indexer.db, { ledgerRoots: [dir], now: "2026-07-18T12:00:00Z" }); });
  assert.equal(r.total_current, 0);
  assert.deepEqual(searchFacts(indexer.db, {}), []);
  assert.deepEqual(searchFacts(indexer.db, { query: "anything" }), []);
  indexer.close();
});

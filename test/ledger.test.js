import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLedgerFiles, readLedgerRows, aggregateLedger } from "../dist/ledger.js";

test("readLedgerRows applies compensating events and skips bad lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "mledger-"));
  const p = join(dir, "ledger.jsonl");
  writeFileSync(
    p,
    [
      JSON.stringify({ id: "L-1", module: "pentest", outcome: "cracked", persona: "tsai", stack: "flask", vuln_class: "ssti" }),
      JSON.stringify({ id: "L-2", module: "pentest", outcome: "misfit", persona: "r", stack: "static", vuln_class: "ssti" }),
      "{ corrupt line",
      JSON.stringify({ id: "C-1", outcome: "retracted", supersedes: "L-2" }),
    ].join("\n"),
  );
  const rows = readLedgerRows(p);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "L-1");
});

test("aggregateLedger groups idea-quality and computes harness loss", () => {
  const dir = mkdtempSync(join(tmpdir(), "mledger-"));
  const sub = join(dir, "proj");
  mkdirSync(sub);
  writeFileSync(
    join(sub, "ledger.jsonl"),
    [
      JSON.stringify({ id: "L-1", module: "pentest", outcome: "cracked", persona: "tsai", stack: "flask", vuln_class: "ssti" }),
      JSON.stringify({ id: "L-2", module: "pentest", outcome: "hardened", persona: "tsai", stack: "flask", vuln_class: "ssti" }),
      JSON.stringify({ id: "L-3", module: "pentest", outcome: "blocked-tooling", persona: "k", stack: "cf", vuln_class: "smuggling" }),
    ].join("\n"),
  );
  const agg = aggregateLedger({}, [dir]);
  assert.equal(agg.total_rows, 3);
  assert.equal(agg.sources, 1);
  const tsai = agg.idea_quality.find((g) => g.persona === "tsai");
  assert.equal(tsai.positive, 2);
  assert.equal(tsai.n, 2);
  assert.equal(agg.harness_health.total_blocked, 1);
  assert.ok(Math.abs(agg.harness_health.harness_loss_rate - 1 / 3) < 1e-9);
});

test("aggregateLedger is an additive no-op when no ledgers exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "mledger-empty-"));
  const agg = aggregateLedger({}, [dir]);
  assert.equal(agg.total_rows, 0);
  assert.equal(agg.sources, 0);
  assert.equal(agg.idea_quality.length, 0);
  assert.equal(findLedgerFiles([dir]).length, 0);
});

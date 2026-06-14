import { test } from "node:test";
import assert from "node:assert/strict";
import { aliasTerms } from "../dist/synonyms.js";

test("aliasTerms expands a multi-word synonym to its group members", () => {
  const t = aliasTerms("vulnerability reward program submission");
  // The phrase fires the bounty group; the other members come back FTS-quoted.
  assert.ok(t.includes('"bounty"'), `expected "bounty" in ${JSON.stringify(t)}`);
  assert.ok(t.includes('"bug bounty"'));
  assert.ok(t.includes('"vrp"'));
  // The trigger phrase itself is not re-emitted as its own alias.
  assert.ok(!t.includes('"vulnerability reward program"'));
});

test("aliasTerms is bidirectional", () => {
  const t = aliasTerms("looking at bug bounty scope");
  assert.ok(t.includes('"vrp"'));
  assert.ok(t.includes('"vulnerability reward program"'));
});

test("aliasTerms returns [] when no group fires (byte-identical query path)", () => {
  assert.deepEqual(aliasTerms("refactor the swiftui layout code"), []);
});

test("aliasTerms is case-insensitive", () => {
  assert.ok(aliasTerms("RECON of the target").includes('"reconnaissance"'));
});

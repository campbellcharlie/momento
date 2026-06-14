import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzzyPrefixTerms } from "../dist/fuzzy.js";

test("identifier-like alpha+digit tokens emit an alpha-stem prefix", () => {
  assert.deepEqual(fuzzyPrefixTerms(["wwdc27"]), ["wwdc*"]);
  assert.deepEqual(fuzzyPrefixTerms(["oauth2"]), ["oauth*"]);
});

test("plain words and short stems do not emit prefixes", () => {
  assert.deepEqual(fuzzyPrefixTerms(["serval"]), []); // no digit
  assert.deepEqual(fuzzyPrefixTerms(["v1"]), []); // stem "v" < 3 chars
  assert.deepEqual(fuzzyPrefixTerms(["123"]), []); // no alpha
});

test("dedupes prefixes across tokens", () => {
  assert.deepEqual(fuzzyPrefixTerms(["wwdc26", "wwdc27"]), ["wwdc*"]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { aliasTerms } from '../dist/synonyms.js';
import { search, findByTopicRanked } from '../dist/queries.js';

test('synonyms require complete tokens and tolerate whitespace/punctuation', () => {
  for (const q of ['iodelay enrollment', 'reconstruct', 'preauthz', 'authn_token', 'αllmβ']) {
    assert.deepEqual(aliasTerms(q), [], q);
  }
  assert.ok(aliasTerms('(LLM)').includes('"large language model"'));
  assert.ok(aliasTerms('vulnerability  reward\nprogram').includes('"vrp"'));
});

function corpus(fn) {
  const db = new DatabaseSync(':memory:');
  const source = readFileSync(new URL('../src/indexer.ts', import.meta.url), 'utf8');
  db.exec(source.match(/const SCHEMA = `([\s\S]*?)`;/)[1]);
  const add = (id, text, summary = null) => {
    db.prepare('INSERT INTO sessions(id,project_path,jsonl_path,summary) VALUES(?,?,?,?)')
      .run(id, '/fixture', '/fixture.jsonl', summary);
    db.prepare('INSERT INTO messages_fts(session_id,role,content) VALUES(?,?,?)')
      .run(id, 'assistant', text);
  };
  try { fn(db, add); } finally { db.close(); }
}

test('enrollment cannot retrieve unrelated language-model material', () => corpus((db, add) => {
  add('model', 'large language model serving');
  assert.deepEqual(search(db, 'iodelay enrollment'), []);
  assert.deepEqual(findByTopicRanked(db, 'iodelay enrollment').hits, []);
}));

test('alias retrieval survives without inventing literal AND matches', () => corpus((db, add) => {
  add('model', 'large language model serving', 'llm absenttoken');
  for (const hit of [search(db, 'llm absenttoken')[0], findByTopicRanked(db, 'llm absenttoken').hits[0]]) {
    assert.ok(hit);
    assert.deepEqual(hit.why.matchedTerms, []);
    assert.ok(hit.why.matchedAliases.includes('large language model'));
    assert.equal(hit.why.via, 'alias');
    assert.equal(hit.why.evidenceScope, 'returned-text');
    assert.doesNotMatch(hit.whyText, /AND match on/);
  }
}));

test('fuzzy matches report prefixes without claiming absent literal identifiers', () => corpus((db, add) => {
  add('conference', 'WWDC26 announcement');
  const hit = findByTopicRanked(db, 'wwdc27').hits[0];
  assert.ok(hit);
  assert.deepEqual(hit.why.matchedTerms, []);
  assert.deepEqual(hit.why.matchedPrefixes, ['wwdc*']);
  assert.equal(hit.why.via, 'fuzzy');
}));

test('literal provenance recognizes highlighted terms without substring matches', () => corpus((db, add) => {
  add('exact', 'quantumflux hyperloop');
  const hit = findByTopicRanked(db, 'quantumflux hyperloop').hits[0];
  assert.deepEqual(hit.why.matchedTerms, ['quantumflux', 'hyperloop']);
}));

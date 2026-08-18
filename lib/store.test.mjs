/**
 * Tests for the row shaping. Run: node --test lib/store.test.mjs
 *
 * These exist because of a bug that hid twice over.
 *
 * `savePages` spread the whole crawled page into the row. That was correct
 * until the crawler grew `_bodyLinks` and `_bodyText` to feed the work list —
 * fields that exist only in memory. PostgREST rejects an entire batch on the
 * first unknown key, so storage stopped working completely, and nothing
 * noticed because nothing was running with credentials.
 *
 * Then it hid a second time: worker.mjs had its own copy of the same shaping,
 * so fixing store.mjs fixed the local run and left the nightly one broken.
 * `pageRow` is now the single implementation, and this is what guards it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageRow } from './store.mjs';

const crawled = {
  url: 'https://actionrecoveryonline.com/about',
  http_status: 200,
  redirected_to: null,
  response_ms: 84,
  title: 'About',
  meta_description: 'A description.',
  canonical: 'https://actionrecoveryonline.com/about',
  h1: 'About',
  h1_count: 1,
  robots_meta: null,
  x_robots_tag: null,
  word_count: 545,
  schema_types: ['Organization'],
  internal_links: 12,
  content_hash: 'abc123',
  // in-memory only — these are the ones that broke it
  _bodyLinks: ['/results', '/phoenix-debt-collection-agency'],
  _bodyText: 'x'.repeat(20000),
};

const meta = { runId: 'run-1', company: 'aro', observedAt: '2026-08-17T00:00:00.000Z' };

test('drops the in-memory-only fields', () => {
  const row = pageRow(crawled, meta);
  assert.equal('_bodyLinks' in row, false);
  assert.equal('_bodyText' in row, false);
});

test('keeps every real column', () => {
  const row = pageRow(crawled, meta);
  for (const c of ['url', 'http_status', 'title', 'meta_description', 'canonical',
                   'h1', 'h1_count', 'robots_meta', 'x_robots_tag', 'word_count',
                   'schema_types', 'internal_links', 'content_hash', 'response_ms']) {
    assert.ok(c in row, `expected column ${c}`);
  }
  assert.equal(row.word_count, 545);
  assert.deepEqual(row.schema_types, ['Organization']);
});

test('stamps the run metadata', () => {
  const row = pageRow(crawled, meta);
  assert.equal(row.run_id, 'run-1');
  assert.equal(row.company, 'aro');
  assert.equal(row.observed_at, '2026-08-17T00:00:00.000Z');
  assert.equal(row.source, 'seo.crawl');
});

test('a null column is kept, an absent one is omitted', () => {
  // null is a fact — "we looked, there was no robots meta". undefined is not,
  // and sending it would write a null the crawler never observed.
  const row = pageRow({ url: 'u', robots_meta: null }, meta);
  assert.equal(row.robots_meta, null);
  assert.equal('canonical' in row, false);
});

test('an unknown field added later cannot reach the database', () => {
  // The actual regression guard. A new crawler field must not be able to
  // break the nightly insert for every other field.
  const row = pageRow({ ...crawled, somethingNewNobodyAdded: 'boom' }, meta);
  assert.equal('somethingNewNobodyAdded' in row, false);
});

test('the source can be overridden, because the worker passes its own', () => {
  const row = pageRow(crawled, { ...meta, source: 'seo.crawl.worker' });
  assert.equal(row.source, 'seo.crawl.worker');
});

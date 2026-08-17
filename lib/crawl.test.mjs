/**
 * Tests for the collector. Run: node --test lib/crawl.test.mjs
 *
 * These exist because of one bad run. On 2026-08-16 the monitor reported two
 * pages down and a redirect broken on a site that was entirely healthy — all
 * three served 200 on the next request, twice over. Three critical alarms from
 * nothing, in an email whose whole value rests on silence meaning "fine".
 *
 * Nothing here talks to the network. Every test stubs global fetch, so the
 * retry is asserted by counting calls rather than by hoping a real request
 * misbehaves at the right moment.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { crawlSite } from './crawl.mjs';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const SITE = {
  company: 'test',
  domain: 'example.test',
  sitemap_url: 'https://example.test/sitemap.xml',
  extra_hosts: [],
  redirects_path: null,
  repo_path: null,
};

const SITEMAP = '<urlset><loc>https://example.test/a</loc></urlset>';
const PAGE = '<html><head><title>A</title></head><body><main><p>hello world</p></main></body></html>';

/**
 * Stub fetch with a per-URL script of responses. Each entry is consumed in
 * order, so `[500, 200]` means "fail once, then succeed" — exactly the shape
 * of the incident this guards against.
 */
function stubFetch(script) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const key = String(url);
    calls.push(key);
    const queue = script[key];
    const next = Array.isArray(queue) ? (queue.length > 1 ? queue.shift() : queue[0]) : queue;
    // Checked FIRST: 'throw' is a string, so the numeric branch below would
    // read .status off it, get undefined, and quietly hand back a 200 —
    // which is exactly how this stub passed a test it should have failed.
    if (next === 'throw') throw new Error('socket hang up');
    const status = typeof next === 'number' ? next : next.status;
    const body = key.endsWith('sitemap.xml') ? SITEMAP : PAGE;
    return new Response(body, { status, headers: next.headers || {} });
  };
  return calls;
}

test('a page that fails once and then succeeds is not reported as broken', async () => {
  const calls = stubFetch({
    'https://example.test/': 200,
    'https://example.test/sitemap.xml': 200,
    'https://example.test/a': [503, 200],
  });
  const snap = await crawlSite(SITE);
  assert.equal(snap.pages[0].http_status, 200);
  assert.equal(calls.filter((c) => c === 'https://example.test/a').length, 2);
});

test('a page that fails twice IS reported — the retry is evidence, not a mute', async () => {
  stubFetch({
    'https://example.test/': 200,
    'https://example.test/sitemap.xml': 200,
    'https://example.test/a': [503, 503],
  });
  const snap = await crawlSite(SITE);
  assert.equal(snap.pages[0].http_status, 503);
});

test('a 404 is taken at its word and not retried', async () => {
  // A 404 is a real answer arrived at quickly. Retrying it only slows the
  // crawl down to confirm what it was already told.
  const calls = stubFetch({
    'https://example.test/': 200,
    'https://example.test/sitemap.xml': 200,
    'https://example.test/a': [404, 200],
  });
  const snap = await crawlSite(SITE);
  assert.equal(snap.pages[0].http_status, 404);
  assert.equal(calls.filter((c) => c === 'https://example.test/a').length, 1);
});

test('a thrown request is retried too', async () => {
  const calls = stubFetch({
    'https://example.test/': 200,
    'https://example.test/sitemap.xml': 200,
    'https://example.test/a': ['throw', 200],
  });
  const snap = await crawlSite(SITE);
  assert.equal(snap.pages[0].http_status, 200);
  assert.equal(calls.filter((c) => c === 'https://example.test/a').length, 2);
});

test('a 429 is retried — rate limiting is the most likely blip of all', async () => {
  const calls = stubFetch({
    'https://example.test/': 200,
    'https://example.test/sitemap.xml': 200,
    'https://example.test/a': [429, 200],
  });
  const snap = await crawlSite(SITE);
  assert.equal(snap.pages[0].http_status, 200);
  assert.equal(calls.filter((c) => c === 'https://example.test/a').length, 2);
});

test('a healthy page is fetched exactly once', async () => {
  const calls = stubFetch({
    'https://example.test/': 200,
    'https://example.test/sitemap.xml': 200,
    'https://example.test/a': 200,
  });
  await crawlSite(SITE);
  assert.equal(calls.filter((c) => c === 'https://example.test/a').length, 1);
});

test('an x-robots-tag header is captured off the response', async () => {
  // The 2026-08-16 noindex incident: this header was invisible to the crawler,
  // so a live noindex delivered without a meta tag could not be seen at all.
  stubFetch({
    'https://example.test/': 200,
    'https://example.test/sitemap.xml': 200,
    'https://example.test/a': { status: 200, headers: { 'x-robots-tag': 'noindex, nofollow' } },
  });
  const snap = await crawlSite(SITE);
  assert.equal(snap.pages[0].x_robots_tag, 'noindex, nofollow');
});

test('no x-robots-tag header records null, not undefined', async () => {
  stubFetch({
    'https://example.test/': 200,
    'https://example.test/sitemap.xml': 200,
    'https://example.test/a': 200,
  });
  const snap = await crawlSite(SITE);
  assert.equal(snap.pages[0].x_robots_tag, null);
});

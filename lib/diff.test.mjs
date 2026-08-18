/**
 * Tests for the finding logic. Run: node --test lib/diff.test.mjs
 *
 * The cases that matter most are the NEGATIVES — a monitor that invents
 * problems gets muted within a week, and a muted monitor is worth nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { absoluteFindings, comparativeFindings, computeFindings, reconcile } from './diff.mjs';

const site = { domain: 'actionrecoveryonline.com', sitemap_url: 'https://actionrecoveryonline.com/sitemap.xml' };

const page = (over = {}) => ({
  url: 'https://actionrecoveryonline.com/about',
  http_status: 200,
  title: 'About — Action Recovery',
  meta_description: 'A description.',
  canonical: 'https://actionrecoveryonline.com/about',
  h1: 'About',
  h1_count: 1,
  robots_meta: null,
  schema_types: ['Organization'],
  content_hash: 'abc',
  ...over,
});

const snap = (pages, over = {}) => ({
  company: 'aro',
  hostChecks: [{ host: 'actionrecoveryonline.com', status: 200 }],
  sitemapError: null,
  pages,
  redirects: [],
  error: null,
  ...over,
});

const kinds = (list) => list.map((x) => x.kind).sort();

test('a healthy site produces no findings', () => {
  assert.deepEqual(absoluteFindings(snap([page()]), site), []);
});

test('catches the Starlight bug: canonical pointing at another domain', () => {
  const out = absoluteFindings(
    snap([page({ canonical: 'https://cash-craft-auto.lovable.app/' })]),
    { domain: 'starlightautoglass.com' }
  );
  const hit = out.find((x) => x.kind === 'canonical_offsite');
  assert.ok(hit, 'should flag an off-site canonical');
  assert.equal(hit.severity, 'critical');
});

test('www is treated as the same site, not an off-site canonical', () => {
  const out = absoluteFindings(
    snap([page({ canonical: 'https://www.actionrecoveryonline.com/about' })]),
    site
  );
  assert.equal(out.filter((x) => x.kind === 'canonical_offsite').length, 0);
});

test('flags noindex, 404s and a missing title', () => {
  const out = absoluteFindings(
    snap([
      page({ url: 'https://x/a', robots_meta: 'noindex, follow' }),
      page({ url: 'https://x/b', http_status: 404 }),
      page({ url: 'https://x/c', title: null }),
    ]),
    site
  );
  assert.ok(kinds(out).includes('noindex'));
  assert.ok(kinds(out).includes('page_error'));
  assert.ok(kinds(out).includes('title_missing'));
});

test('a broken page is not also reported as missing a title', () => {
  // Otherwise one 404 produces five findings and the email is nonsense.
  const out = absoluteFindings(snap([page({ http_status: 500, title: null, canonical: null })]), site);
  assert.deepEqual(kinds(out), ['page_error']);
});

test('spots duplicate titles across pages', () => {
  const out = absoluteFindings(
    snap([page({ url: 'https://x/a' }), page({ url: 'https://x/b' })]),
    site
  );
  assert.equal(out.filter((x) => x.kind === 'duplicate_title').length, 1);
});

test('FIRST RUN claims nothing comparative', () => {
  // With no yesterday, every page is "new" — reporting that is noise.
  assert.deepEqual(comparativeFindings(null, snap([page()])), []);
});

test('notices a page that vanished from the sitemap', () => {
  const before = snap([page({ url: 'https://x/a' }), page({ url: 'https://x/b' })]);
  const after = snap([page({ url: 'https://x/a' })]);
  const out = comparativeFindings(before, after);
  assert.equal(out.find((x) => x.kind === 'page_dropped').url, 'https://x/b');
});

test('notices a title change and carries both values', () => {
  const out = comparativeFindings(
    snap([page({ title: 'Old title' })]),
    snap([page({ title: 'New title' })])
  );
  const hit = out.find((x) => x.kind === 'title_changed');
  assert.equal(hit.previous_value, 'Old title');
  assert.equal(hit.current_value, 'New title');
});

test('notices structured data disappearing', () => {
  const out = comparativeFindings(
    snap([page({ schema_types: ['Organization', 'FAQPage'] })]),
    snap([page({ schema_types: ['Organization'] })])
  );
  assert.ok(out.find((x) => x.kind === 'schema_lost').detail.includes('FAQPage'));
});

test('a FAILED crawl reports one problem, not thirty', () => {
  // The single most important guard here. A network blip must never read as
  // "the entire site disappeared overnight".
  const out = computeFindings(
    snap([page({ url: 'https://x/a' }), page({ url: 'https://x/b' })]),
    snap([], { error: 'sitemap HTTP 000' }),
    site
  );
  assert.deepEqual(kinds(out), ['crawl_failed']);
});

test('reconcile separates new, ongoing and fixed', () => {
  const open = [
    { kind: 'noindex', url: 'https://x/a' },
    { kind: 'page_error', url: 'https://x/b' },
  ];
  const now = [
    { kind: 'noindex', url: 'https://x/a' }, // still there
    { kind: 'title_missing', url: 'https://x/c' }, // new
  ];
  const r = reconcile(open, now);
  assert.deepEqual(kinds(r.opened), ['title_missing']);
  assert.deepEqual(kinds(r.stillOpen), ['noindex']);
  assert.deepEqual(kinds(r.resolved), ['page_error']);
});

// ---------------------------------------------------------- noindex, both ways

test('a noindex response header is critical, even with clean markup', () => {
  // The 2026-08-16 incident: a staging build went live on the real domain and
  // sat there ~11 hours. The meta check would have caught it, but a
  // header-only noindex was invisible to this file entirely.
  const found = absoluteFindings(snap([page({ x_robots_tag: 'noindex, nofollow' })]), site);
  const hit = found.find((x) => x.kind === 'noindex_header');
  assert.ok(hit);
  assert.equal(hit.severity, 'critical');
});

test('an ordinary x-robots-tag is not a noindex', () => {
  const found = absoluteFindings(snap([page({ x_robots_tag: 'nosnippet' })]), site);
  assert.deepEqual(found.filter((x) => x.kind === 'noindex_header'), []);
});

test('no x-robots-tag header produces no finding', () => {
  const found = absoluteFindings(snap([page()]), site);
  assert.deepEqual(found.filter((x) => x.kind === 'noindex_header'), []);
});

// ------------------------------------------------- alias hosts serving the site

const hostSnap = (checks) => snap([page()], { hostChecks: checks });

test('an alias host serving the site in its own right is a finding', () => {
  // The 2026-08-17 case: www answered 200 for months while every canonical
  // pointed at the apex, and the impressions split three ways.
  const found = absoluteFindings(hostSnap([
    { host: 'actionrecoveryonline.com', status: 200, final_host: 'actionrecoveryonline.com', is_canonical: true },
    { host: 'www.actionrecoveryonline.com', status: 200, final_host: 'www.actionrecoveryonline.com', is_canonical: false },
  ]), site);
  const hit = found.find((x) => x.kind === 'duplicate_host');
  assert.ok(hit);
  assert.equal(hit.severity, 'warning');
  assert.match(hit.detail, /instead of redirecting/);
});

test('an alias host that redirects to the canonical is fine', () => {
  const found = absoluteFindings(hostSnap([
    { host: 'actionrecoveryonline.com', status: 200, final_host: 'actionrecoveryonline.com', is_canonical: true },
    { host: 'www.actionrecoveryonline.com', status: 200, final_host: 'actionrecoveryonline.com', is_canonical: false },
  ]), site);
  assert.deepEqual(found.filter((x) => x.kind === 'duplicate_host'), []);
});

test('the canonical host is never called a duplicate of itself', () => {
  const found = absoluteFindings(hostSnap([
    { host: 'actionrecoveryonline.com', status: 200, final_host: 'actionrecoveryonline.com', is_canonical: true },
  ]), site);
  assert.deepEqual(found.filter((x) => x.kind === 'duplicate_host'), []);
});

test('a down host is reported once, not twice', () => {
  // Without the `continue` it would be both down AND a duplicate host.
  const found = absoluteFindings(hostSnap([
    { host: 'www.actionrecoveryonline.com', status: 0, final_host: null, is_canonical: false, error: 'timeout' },
  ]), site);
  assert.equal(found.filter((x) => x.url === 'https://www.actionrecoveryonline.com/').length, 1);
  assert.equal(found.find((x) => x.url === 'https://www.actionrecoveryonline.com/').kind, 'host_down');
});

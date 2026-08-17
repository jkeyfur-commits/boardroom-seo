/**
 * Tests for the work list. Run: node --test lib/opportunities.test.mjs
 *
 * Same bar as diff.test.mjs, for the same reason: the negatives matter most.
 * A work list is a to-do list, and a to-do list with junk on it stops being
 * read — the difference is that here the junk *displaces* real work, because
 * the list is capped at twelve. Every false positive costs a real slot.
 *
 * Three of these tests exist because the first live run produced exactly that
 * failure: five Cloudflare `/cdn-cgi/` email-obfuscation links and the
 * homepage took six of ARO's twelve slots.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  orphanPages,
  missingFromSitemap,
  metadataWork,
  linkingOpportunities,
  buildWorkList,
  searchOpportunities,
} from './opportunities.mjs';

const ORIGIN = 'https://actionrecoveryonline.com';
const u = (p) => ORIGIN + p;

const page = (over = {}) => ({
  url: u('/about'),
  http_status: 200,
  title: 'About — Action Recovery',
  meta_description: 'A short description.',
  word_count: 800,
  ...over,
});

// ---------------------------------------------------------------- orphans

test('a page nothing links to in body content is an orphan', () => {
  const out = orphanPages([page({ url: u('/results') })], new Map());
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'orphan_page');
  assert.equal(out[0].impact, 'high');
  assert.equal(out[0].url, u('/results'));
});

test('a page with an in-body link pointing at it is not an orphan', () => {
  const links = new Map([[u('/results'), 2]]);
  assert.deepEqual(orphanPages([page({ url: u('/results') })], links), []);
});

test('the homepage is never an orphan', () => {
  // Reached from the logo in every header and from the domain itself. Before
  // this rule it took a high-impact slot on both sites, every single run.
  assert.deepEqual(orphanPages([page({ url: u('/') })], new Map()), []);
});

test('a broken page is not reported as an orphan', () => {
  // That is layer 1's job, and reporting it twice in two voices is worse
  // than reporting it once.
  assert.deepEqual(orphanPages([page({ http_status: 404 })], new Map()), []);
});

test('utility pages are exempt', () => {
  const pages = [page({ url: u('/thank-you') }), page({ url: u('/privacy') })];
  assert.deepEqual(orphanPages(pages, new Map()), []);
});

// ------------------------------------------------------------- sitemap gap

test('a live page absent from the sitemap is flagged', () => {
  const out = missingFromSitemap([page({ url: u('/new-page') })], [u('/about')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'not_in_sitemap');
});

test('a page present in the sitemap is not flagged', () => {
  assert.deepEqual(missingFromSitemap([page()], [u('/about')]), []);
});

test("Cloudflare's /cdn-cgi/ links are not pages", () => {
  // These appear in the HTML as ordinary internal hrefs. The first live run
  // reported five of them as missing pages and pushed real work off the list.
  const junk = page({ url: u('/cdn-cgi/l/email-protection#a5d6d0d5') });
  assert.deepEqual(missingFromSitemap([junk], []), []);
  assert.deepEqual(orphanPages([junk], new Map()), []);
});

test('assets are not pages', () => {
  const pages = [
    page({ url: u('/brand/seal.svg') }),
    page({ url: u('/docs/rates.pdf') }),
    page({ url: u('/sitemap.xml') }),
  ];
  assert.deepEqual(missingFromSitemap(pages, []), []);
});

// ------------------------------------------------------------------ meta

test('an over-length description is flagged with its length', () => {
  const out = metadataWork([page({ meta_description: 'x'.repeat(200) })]);
  const hit = out.find((o) => o.kind === 'description_too_long');
  assert.ok(hit);
  assert.match(hit.title, /200 chars/);
});

test('a description at the limit is left alone', () => {
  const out = metadataWork([page({ meta_description: 'x'.repeat(160) })]);
  assert.deepEqual(out.filter((o) => o.kind === 'description_too_long'), []);
});

test('a missing description produces no metadata opportunity', () => {
  // Absent is layer 1's finding, not layer 2's suggestion.
  const out = metadataWork([page({ meta_description: null, title: null })]);
  assert.deepEqual(out.filter((o) => o.kind.startsWith('description')), []);
  assert.deepEqual(out.filter((o) => o.kind.startsWith('title')), []);
});

test('thin content is low impact, never high', () => {
  const out = metadataWork([page({ word_count: 120 })]);
  const hit = out.find((o) => o.kind === 'thin_content');
  assert.ok(hit);
  assert.equal(hit.impact, 'low');
});

test('a zero word count is not called thin', () => {
  // Zero means the parser found no <main>, which is a parsing problem and
  // not a content problem. Reporting it as "thin" sends real effort at a bug.
  const out = metadataWork([page({ word_count: 0 })]);
  assert.deepEqual(out.filter((o) => o.kind === 'thin_content'), []);
});

// ------------------------------------------------------------- link ideas

const targets = [{ url: u('/phoenix-debt-collection-agency'), phrases: ['Phoenix'] }];

test('a page that raises the subject and does not link gets a suggestion', () => {
  const text = new Map([[u('/about'), 'We have served Phoenix creditors since 2009.']]);
  const out = linkingOpportunities([page()], targets, text);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'link_opportunity');
  assert.match(out[0].fix, /phoenix-debt-collection-agency/);
});

test('a page that already links there gets nothing', () => {
  // The real-world shape: the link is an href, so it does NOT appear in the
  // stripped body text. Checking the text was the original bug — it reported
  // /how-it-works as unlinked when that page had a "see also" block pointing
  // straight at the target.
  const text = new Map([[u('/about'), 'We have served Phoenix creditors since 2009.']]);
  const links = new Map([[u('/about'), ['/phoenix-debt-collection-agency']]]);
  assert.deepEqual(linkingOpportunities([page()], targets, text, links), []);
});

test('a page mentioning the subject with no link to it still gets a suggestion', () => {
  const text = new Map([[u('/about'), 'We have served Phoenix creditors since 2009.']]);
  const links = new Map([[u('/about'), ['/results', '/services']]]);
  assert.equal(linkingOpportunities([page()], targets, text, links).length, 1);
});

test('omitting the links map does not crash, it just suggests', () => {
  const text = new Map([[u('/about'), 'Serving Phoenix.']]);
  assert.equal(linkingOpportunities([page()], targets, text).length, 1);
});

test('the target page is never told to link to itself', () => {
  const self = page({ url: u('/phoenix-debt-collection-agency') });
  const text = new Map([[self.url, 'A Phoenix collection agency.']]);
  assert.deepEqual(linkingOpportunities([self], targets, text), []);
});

test('matching is case-insensitive', () => {
  const text = new Map([[u('/about'), 'work across phoenix and the east valley']]);
  assert.equal(linkingOpportunities([page()], targets, text).length, 1);
});

// ------------------------------------------------------------------ list

test('the list is ranked high, then medium, then low', () => {
  const list = buildWorkList([
    metadataWork([page({ word_count: 50 })]),                    // low
    metadataWork([page({ meta_description: 'x'.repeat(200) })]), // medium
    orphanPages([page({ url: u('/results') })], new Map()),      // high
  ]);
  assert.deepEqual(list.map((o) => o.impact), ['high', 'medium', 'low']);
});

test('forty copies of one suggestion collapse to three plus a counted line', () => {
  // The failure this prevents: nine over-long descriptions filled nine of
  // ARO's twelve slots and buried the internal-linking work underneath.
  const many = Array.from({ length: 40 }, (_, i) =>
    page({ url: u(`/p${i}`), word_count: 50 })
  );
  const list = buildWorkList([metadataWork(many)]);
  assert.equal(list.length, 4);
  const rollup = list.find((o) => o.rollup);
  assert.ok(rollup);
  assert.match(rollup.title, /37 more pages/);
  assert.match(rollup.detail, /\/p39/);
});

test('the collapse threshold and the cap are both honoured', () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    page({ url: u(`/p${i}`), word_count: 50 })
  );
  assert.equal(buildWorkList([metadataWork(many)], 12, 1).length, 2);
  assert.equal(buildWorkList([metadataWork(many)], 1).length, 1);
});

test('a kind at the threshold is listed in full, with no rollup line', () => {
  const three = Array.from({ length: 3 }, (_, i) => page({ url: u(`/p${i}`), word_count: 50 }));
  const list = buildWorkList([metadataWork(three)]);
  assert.equal(list.length, 3);
  assert.ok(!list.some((o) => o.rollup));
});

test('collapsing one kind does not displace another', () => {
  const thin = Array.from({ length: 9 }, (_, i) => page({ url: u(`/p${i}`), word_count: 50 }));
  const list = buildWorkList([
    metadataWork(thin),
    orphanPages([page({ url: u('/results') })], new Map()),
  ]);
  assert.ok(list.some((o) => o.kind === 'orphan_page'));
  assert.equal(list.filter((o) => o.kind === 'thin_content').length, 4); // 3 + rollup
});

test('every opportunity carries a url, a plain-English title and a fix', () => {
  const list = buildWorkList([
    orphanPages([page({ url: u('/results') })], new Map()),
    metadataWork([page({ meta_description: 'x'.repeat(200) })]),
  ]);
  assert.ok(list.length);
  for (const o of list) {
    assert.ok(o.url && o.title && o.detail && o.fix, JSON.stringify(o));
    assert.ok(['high', 'medium', 'low'].includes(o.impact));
  }
});

test('a clean site produces an empty list, not a filler one', () => {
  const clean = page({ url: u('/about'), word_count: 900, meta_description: 'Short.' });
  const list = buildWorkList([
    orphanPages([clean], new Map([[clean.url, 1]])),
    missingFromSitemap([clean], [clean.url]),
    metadataWork([clean]),
    linkingOpportunities([clean], targets, new Map([[clean.url, 'no mention here']])),
  ]);
  assert.deepEqual(list, []);
});

test('the search half returns nothing rather than guessing', () => {
  // Guarding the stub on purpose: the day someone implements it, this test
  // fails and forces them to decide what an empty search dataset means.
  assert.deepEqual(searchOpportunities(null), []);
});

/**
 * Tests for the weekly digest. Run: node --test lib/report.test.mjs
 *
 * The first live render of this said:
 *
 *   avg position  41.1  (up from 50.9)
 *
 * which reads as a decline and was in fact the largest improvement on the
 * page — average position runs backwards. Most of what follows guards the
 * wording rather than the arithmetic, because the wording is the product.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPerformanceText, buildWeeklyText, buildWeeklySubject } from './report.mjs';

const week = (over = {}) => ({
  impressions: 100,
  clicks: 5,
  position: 12.3,
  queries: 40,
  brand: { impressions: 40, clicks: 5 },
  nonBrand: { impressions: 60, clicks: 0 },
  ...over,
});

const site = (over = {}) => ({
  company: 'aro',
  recent: { startDate: '2026-08-08', endDate: '2026-08-15' },
  prior: { startDate: '2026-08-01', endDate: '2026-08-08' },
  thisWeek: week(),
  lastWeek: week({ impressions: 50, clicks: 2, position: 20.1 }),
  ...over,
});

// ------------------------------------------------------------- direction

test('a falling average position reads as an improvement', () => {
  const t = buildPerformanceText([site()]);
  assert.match(t, /avg position\s+12\.3\s+\(improved from 20\.1\)/);
  assert.doesNotMatch(t, /avg position.*\(up from/);
});

test('a rising average position reads as a slip', () => {
  const t = buildPerformanceText([
    site({ thisWeek: week({ position: 30 }), lastWeek: week({ position: 10 }) }),
  ]);
  assert.match(t, /avg position\s+30\s+\(slipped from 10\)/);
});

test('more impressions is up, fewer is down', () => {
  assert.match(buildPerformanceText([site()]), /impressions\s+100\s+\(up from 50\)/);
  const down = buildPerformanceText([
    site({ thisWeek: week({ impressions: 20 }), lastWeek: week({ impressions: 90 }) }),
  ]);
  assert.match(down, /impressions\s+20\s+\(down from 90\)/);
});

// ------------------------------------------------------------- formatting

test('a long decimal is trimmed to one place', () => {
  // Starlight's first render printed "avg position 3.6875".
  const t = buildPerformanceText([site({ thisWeek: week({ position: 3.6875 }), lastWeek: null })]);
  assert.match(t, /avg position\s+3\.7/);
  assert.doesNotMatch(t, /3\.6875/);
});

test('a zero prior week says so instead of dividing by it', () => {
  const t = buildPerformanceText([site({ lastWeek: week({ impressions: 0, clicks: 0 }) })]);
  assert.match(t, /\(nothing last week\)/);
  assert.doesNotMatch(t, /Infinity|NaN/);
});

test('an unchanged number says unchanged rather than picking a direction', () => {
  const t = buildPerformanceText([site({ thisWeek: week(), lastWeek: week() })]);
  assert.match(t, /\(unchanged\)/);
});

// ------------------------------------------------------- the point of it

test('non-brand is called out in capitals, because it is the answer', () => {
  const t = buildPerformanceText([site()]);
  assert.match(t, /NON-BRAND\s+60 impressions, 0 clicks/);
});

test('the verdict names the number of people who saw it and did not click', () => {
  const t = buildPerformanceText([site()]);
  assert.match(t, /60 people searched for what this business does, saw it, and none clicked/);
});

test('no non-brand impressions at all gets its own sentence', () => {
  const t = buildPerformanceText([
    site({ thisWeek: week({ nonBrand: { impressions: 0, clicks: 0 } }) }),
  ]);
  assert.match(t, /Nobody who was not already looking for you saw the site at all/);
});

test('non-brand clicks are reported as the win they are', () => {
  const t = buildPerformanceText([
    site({ thisWeek: week({ nonBrand: { impressions: 60, clicks: 7 } }) }),
  ]);
  assert.match(t, /7 of 60 non-brand impressions became a visit/);
});

// ------------------------------------------------------------- assembly

test('no search data renders nothing rather than an empty heading', () => {
  assert.equal(buildPerformanceText([]), '');
  assert.equal(buildPerformanceText([{ company: 'aro' }]), '');
});

test('the digest still builds with no search data at all', () => {
  const t = buildWeeklyText([{ company: 'aro', work: [] }], []);
  assert.match(t, /THE WEEKLY WORK LIST/);
  assert.match(t, /Nothing obvious to improve/);
});

test('the digest carries both halves when both exist', () => {
  const perSite = [
    { company: 'aro', work: [{ impact: 'high', title: 'T', url: 'u', detail: 'd', fix: 'f' }] },
  ];
  const t = buildWeeklyText(perSite, [site()]);
  assert.match(t, /SEARCH PERFORMANCE/);
  assert.match(t, /WORTH DOING/);
  assert.ok(t.indexOf('SEARCH PERFORMANCE') < t.indexOf('WORTH DOING'), 'numbers before the to-do list');
});

test('the subject counts the work, not the sites', () => {
  assert.match(buildWeeklySubject([{ work: [1, 2] }, { work: [3] }]), /3 things worth doing/);
  assert.match(buildWeeklySubject([{ work: [1] }]), /1 thing worth doing/);
});

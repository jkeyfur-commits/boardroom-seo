/**
 * Layer 2 — the work list.
 *
 * Layer 1 answers "did anything break." This answers "what is worth doing
 * next," which is a different question and needs a different bar: a finding is
 * a defect, an opportunity is a judgement call. So these are RANKED and
 * capped, never dumped. A list of ninety suggestions is a list nobody reads.
 *
 * TWO SOURCES, ONE MISSING.
 *
 *   crawl data   — what this file uses. Available tonight, no credentials.
 *   search data  — impressions, clicks, average position. Needs the Search
 *                  Console API, which needs a Google Cloud project. The three
 *                  highest-value checks live there and are stubbed at the
 *                  bottom, ready rather than pretended.
 *
 * WHY THIS IS WORTH HAVING WITHOUT THE SEARCH HALF: on 2026-08-16 I shipped a
 * page with no internal links pointing at it and no sitemap entry, and only
 * caught both because I happened to check by hand. Two of the rules below are
 * exactly those checks. A page nobody links to is a page Google barely crawls,
 * and "I built it and forgot to wire it in" is the most common way good
 * content does nothing at all.
 */

const rank = { high: 0, medium: 1, low: 2 };

const op = (kind, impact, url, title, detail, fix) => ({ kind, impact, url, title, detail, fix });

/** Google truncates around here. Not a hard rule — a guideline worth flagging. */
const DESC_MAX = 160;
const TITLE_MAX = 60;
const THIN_WORDS = 300;

/**
 * Pages the site links to nowhere in its own body content.
 *
 * Footer links do NOT count. A site-wide footer link is worth very little —
 * it appears on every page, so it says nothing about which page is important.
 * An in-body link is a page choosing to point at another page, which is the
 * signal that carries.
 */
export function orphanPages(pages, bodyLinks) {
  return pages
    .filter((p) => p.http_status === 200)
    .filter((p) => !(bodyLinks.get(p.url) > 0))
    .filter((p) => !isUtility(p.url))
    // The homepage is reached from the logo in every header and from the
    // domain itself. It cannot be an orphan, and flagging it wastes a slot
    // on a list that is deliberately only twelve long.
    .filter((p) => shortPath(p.url) !== '/')
    .map((p) =>
      op('orphan_page', 'high', p.url, 'No page links to this in its content',
        'Only reachable from the footer or the sitemap. Google weighs an in-body link far above a site-wide one, so this page is barely being crawled.',
        'Link to it from a page whose reader would want it — the moment in the text where the question comes up.')
    );
}

/** Live and returning 200, but absent from the sitemap we hand Google. */
export function missingFromSitemap(pages, sitemapUrls) {
  const inSitemap = new Set(sitemapUrls);
  return pages
    .filter((p) => p.http_status === 200 && !inSitemap.has(p.url) && !isUtility(p.url))
    .map((p) =>
      op('not_in_sitemap', 'high', p.url, 'Live page missing from the sitemap',
        'The sitemap is the main way Google discovers pages. A page absent from it relies on being linked to and stumbled upon.',
        'Add it to the sitemap generator.')
    );
}

/** Pages with impressions are handled in the search half; this is the on-page shape. */
export function metadataWork(pages) {
  const out = [];
  for (const p of pages) {
    if (p.http_status !== 200 || isUtility(p.url)) continue;

    if (p.meta_description && p.meta_description.length > DESC_MAX) {
      out.push(
        op('description_too_long', 'medium', p.url, `Description will be cut off (${p.meta_description.length} chars)`,
          `Google shows roughly ${DESC_MAX}. Everything past that is invisible, and the end of a description is usually where the reason to click lives.`,
          'Trim to under 160, front-loading the specific benefit.')
      );
    }
    if (p.title && p.title.length > TITLE_MAX) {
      out.push(
        op('title_too_long', 'medium', p.url, `Title will be cut off (${p.title.length} chars)`,
          `Titles are truncated near ${TITLE_MAX} characters.`,
          'Shorten, keeping the distinguishing words first.')
      );
    }
    if (p.word_count > 0 && p.word_count < THIN_WORDS) {
      out.push(
        op('thin_content', 'low', p.url, `Thin page (${p.word_count} words)`,
          'Short is not automatically bad — a payment page should be short. Worth a look only if this page is meant to rank.',
          'Either deepen it, or accept it as a utility page and ignore this.')
      );
    }
  }
  return out;
}

/**
 * Internal linking opportunities: page A talks about a subject that page B is
 * entirely about, and does not link to it.
 *
 * This is the cheapest ranking work that exists — no new content, no outreach,
 * just connecting things already written. It is also the most commonly skipped,
 * because nobody re-reads thirty pages looking for missed connections.
 */
export function linkingOpportunities(pages, targets, bodyText, bodyLinks = new Map()) {
  const out = [];
  for (const t of targets) {
    for (const p of pages) {
      // The utility filter the other three rules already apply, and this one
      // did not. It was suggesting marketing links on /privacy, /terms and a
      // debtor-facing dispute page — pages whose whole job is to be plain and
      // uncommercial. A legal notice does not need a route into the funnel.
      if (p.url === t.url || p.http_status !== 200 || isUtility(p.url)) continue;
      const text = (bodyText.get(p.url) || '').toLowerCase();
      if (!text) continue;
      // Already links there — nothing to suggest.
      //
      // THIS USED TO CHECK THE TEXT, WHICH CANNOT WORK. Body text is stripped
      // of tags, so an href never appears in it; the check could only ever
      // match when a page printed the URL as visible prose. On 2026-08-16 it
      // told me /how-it-works did not link to /how-we-contact-your-customers.
      // It did — twice, in a "see also" block written for that exact purpose —
      // and I added a third before noticing. Now it reads the real links.
      if ((bodyLinks.get(p.url) || []).includes(shortPath(t.url))) continue;
      const hit = t.phrases.find((phrase) => text.includes(phrase.toLowerCase()));
      if (hit) {
        out.push(
          op('link_opportunity', 'medium', p.url, `Mentions "${hit}" but does not link to ${shortPath(t.url)}`,
            `This page raises the subject that ${shortPath(t.url)} is entirely about. A reader hitting that sentence is exactly who should be sent there.`,
            `Link the phrase "${hit}" to ${shortPath(t.url)}.`)
        );
      }
    }
  }
  return out;
}

/**
 * Paths that are not pages and must never reach the work list.
 *
 * `/cdn-cgi/` is Cloudflare's own namespace. Its email-obfuscation links look
 * exactly like internal links in the HTML — the first run of this file
 * reported five of them as "live pages missing from the sitemap" and pushed
 * real work off the bottom of a twelve-item list.
 */
const isUtility = (url) =>
  /\/cdn-cgi\//.test(url) ||
  /\.(pdf|jpe?g|png|svg|webp|ico|xml|txt|css|js)$/i.test(url.split(/[?#]/)[0]) ||
  // make-a-payment and dispute-an-account are DEBTOR-facing on a site that
  // sells to creditors. They exist so a consumer holding a letter can act,
  // they are short by design, and they are not ranking targets — so "thin
  // page" and "add an internal link" are both wrong advice about them, and
  // advice that is wrong every week is how a work list stops being read.
  /\/(thank-you|lead-problem|404|privacy|terms|sitemap|make-a-payment|dispute-an-account)/.test(url);

const shortPath = (url) => url.replace(/^https?:\/\/[^/]+/, '') || '/';

/**
 * Rank, collapse, cap, return. The cap is the point: an opportunity list is a
 * to-do list, and a to-do list of ninety items is not one.
 *
 * COLLAPSING MATTERS AS MUCH AS CAPPING. The first live run filled nine of
 * ARO's twelve slots with the same suggestion about nine different pages, and
 * buried the internal-linking work underneath it. Nine copies of one idea is
 * one idea plus eight lines of noise, so past `perKind` the rest become a
 * single counted line and the slots go back to distinct work.
 */
export function buildWorkList(parts, limit = 12, perKind = 3) {
  const all = parts.flat().sort((a, b) => rank[a.impact] - rank[b.impact]);

  const seen = new Map();
  const kept = [];
  const overflow = new Map();

  for (const o of all) {
    const n = (seen.get(o.kind) || 0) + 1;
    seen.set(o.kind, n);
    if (n <= perKind) kept.push(o);
    else overflow.set(o.kind, [...(overflow.get(o.kind) || []), o]);
  }

  for (const [kind, rest] of overflow) {
    const first = rest[0];
    kept.push({
      kind,
      impact: first.impact,
      url: `${rest.length} more page${rest.length === 1 ? '' : 's'}`,
      title: `Same again on ${rest.length} more page${rest.length === 1 ? '' : 's'}`,
      detail: rest.map((o) => shortPath(o.url)).join(', '),
      fix: first.fix,
      rollup: true,
    });
  }

  return kept.sort((a, b) => rank[a.impact] - rank[b.impact]).slice(0, limit);
}

/**
 * The search-data half. NOT IMPLEMENTED, and deliberately not faked.
 *
 * These three are the highest-value checks in layer 2 and every one of them
 * needs impressions, clicks and average position from the Search Console API:
 *
 *   striking_distance   ranks 5–20 for a query. Small effort, real gain —
 *                       the single best-return SEO work that exists.
 *   impressions_no_clicks
 *                       people see it and do not click. That is a title and
 *                       description problem, not a content problem, and it is
 *                       invisible without the data.
 *   decaying            traffic falling over weeks. The 2026 core updates
 *                       penalised pages untouched for 90 days by 20–40%.
 *
 * Returning [] rather than guessing: a work list that invents priorities is
 * worse than a short one, because it sends real effort at imagined problems.
 */
export function searchOpportunities(_searchData) {
  return [];
}

/**
 * SEO monitor — the nightly job.
 *
 *   node run.mjs                 crawl, compare, store, email if anything changed
 *   node run.mjs --dry-run       crawl and compare, print, write nothing, send nothing
 *   node run.mjs --site aro      one company only
 *   node run.mjs --json          raw snapshot to stdout
 *
 * Needs, to do its full job:
 *   BOARDROOM_SUPABASE_URL, BOARDROOM_SUPABASE_SERVICE_ROLE_KEY
 *   RESEND_API_KEY, SEO_ALERT_FROM, SEO_ALERT_TO
 *
 * Without them it still crawls and still reports to the console — the useful
 * half works before any credential exists, which is what makes it testable.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { crawlSite } from './lib/crawl.mjs';
import { computeFindings, reconcile } from './lib/diff.mjs';
import * as store from './lib/store.mjs';
import { shouldSend, buildSubject, buildText, buildWeeklySubject, buildWeeklyText, sendEmail } from './lib/report.mjs';
import { orphanPages, missingFromSitemap, metadataWork, linkingOpportunities, buildWorkList } from './lib/opportunities.mjs';

const SITES = [
  {
    company: 'aro',
    domain: 'actionrecoveryonline.com',
    sitemap_url: 'https://actionrecoveryonline.com/sitemap.xml',
    extra_hosts: ['www.actionrecoveryonline.com'],
    redirects_path: 'public/_redirects',
    repo_path: 'C:\\Users\\KIEFF\\aro-website',
  },
  {
    company: 'starlight',
    domain: 'starlightautoglass.com',
    sitemap_url: 'https://starlightautoglass.com/sitemap.xml',
    extra_hosts: ['www.starlightautoglass.com'],
    redirects_path: null,
    repo_path: null,
  },
];

const args = process.argv.slice(2);
const only = args.includes('--site') ? args[args.indexOf('--site') + 1] : null;
const dryRun = args.includes('--dry-run');
const asJson = args.includes('--json');
/** The work list on its own, on a schedule, regardless of whether anything
 *  broke. Separate from the nightly mail on purpose — see report.mjs. */
const weekly = args.includes('--weekly');

const log = (...a) => { if (!asJson) console.error(...a); };
const loadRedirects = (repo, rel) => readFile(path.join(repo, rel), 'utf8');

const canStore = store.storeConfigured() && !dryRun;
if (!canStore && !asJson) {
  log(dryRun ? '(dry run — nothing will be written or sent)' : '(no Boardroom credentials — console only)\n');
}

const perSite = [];
const snapshots = [];

for (const site of SITES.filter((s) => !only || s.company === only)) {
  log(`── ${site.company}`);
  const snap = await crawlSite(site, { readFile: loadRedirects });
  snapshots.push(snap);

  const counts = {
    pagesChecked: snap.pages.length,
    pagesOk: snap.pages.filter((p) => p.http_status === 200).length,
    redirectsChecked: snap.redirects.length,
    redirectsOk: snap.redirects.filter((r) => r.ok).length,
  };

  // Compare against the last SUCCESSFUL run. Without storage there is no
  // history, so every run behaves like a first run — absolute checks only.
  let previous = null;
  let openRows = [];
  if (canStore) {
    previous = await store.loadPreviousSnapshot(site.company);
    openRows = await store.loadOpenFindings(site.company);
  }

  const found = computeFindings(previous, snap, site);
  const delta = reconcile(openRows, found);

  if (canStore) {
    const runId = await store.saveRun(snap, counts);
    await store.savePages(runId, snap);
    await store.applyFindings(site.company, delta, openRows);
  }

  // ---- layer 2: what is worth doing next -----------------------------------
  // Body links only. A footer link appears on every page and so says nothing
  // about which page matters; counting it would make every page look linked.
  const origin = `https://${site.domain}`;
  const bodyLinkCounts = new Map();
  const bodyText = new Map();
  const bodyLinksByPage = new Map();
  const linkedPaths = new Set();
  for (const p of snap.pages) {
    bodyText.set(p.url, p._bodyText || '');
    bodyLinksByPage.set(p.url, p._bodyLinks || []);
    for (const href of p._bodyLinks || []) {
      const abs = origin + href;
      linkedPaths.add(abs);
      if (abs !== p.url) bodyLinkCounts.set(abs, (bodyLinkCounts.get(abs) || 0) + 1);
    }
  }

  // A page reachable by an in-body link but absent from the sitemap. This is
  // the only way to spot it — the crawler starts FROM the sitemap, so a page
  // missing from it is invisible unless something links to it.
  const sitemapUrls = snap.pages.map((p) => p.url);
  const discovered = [...linkedPaths]
    .filter((u) => !sitemapUrls.includes(u))
    .map((u) => ({ url: u, http_status: 200, word_count: 0 }));

  // Pages worth linking TO, and the phrases that should trigger a link.
  const LINK_TARGETS = [
    { url: `${origin}/how-we-contact-your-customers`,
      phrases: ['phone call', 'contact your customers', 'letter series', 'escalat'] },
    { url: `${origin}/phoenix-debt-collection-agency`, phrases: ['Phoenix'] },
  ].filter((t) => sitemapUrls.includes(t.url));

  const work = buildWorkList([
    orphanPages(snap.pages, bodyLinkCounts),
    missingFromSitemap([...snap.pages, ...discovered], sitemapUrls),
    metadataWork(snap.pages),
    linkingOpportunities(snap.pages, LINK_TARGETS, bodyText, bodyLinksByPage),
  ]);

  perSite.push({ company: site.company, domain: site.domain, ...counts, ...delta, work });

  log(`   ${counts.pagesOk}/${counts.pagesChecked} pages OK` +
      (counts.redirectsChecked ? `, ${counts.redirectsOk}/${counts.redirectsChecked} redirects OK` : ''));
  log(`   ${delta.opened.length} new · ${delta.stillOpen.length} ongoing · ${delta.resolved.length} fixed`);
  for (const x of delta.opened.filter((x) => x.severity === 'critical')) {
    log(`   🔴 ${x.kind} — ${x.url || site.domain}`);
  }
  if (work.length) {
    log(`   worth doing (${work.length}):`);
    for (const w of work) {
      log(`     [${w.impact}] ${w.title}`);
      log(`             ${w.url.replace(origin, '') || '/'}`);
    }
  } else {
    log('   nothing obvious to improve.');
  }
  log('');
}

if (asJson) {
  process.stdout.write(JSON.stringify({ snapshots, perSite }, null, 2));
} else if (weekly) {
  // Always sends, even with an empty list — this one is a scheduled digest a
  // human expects on a day, not an alert. The silence rule belongs to the
  // nightly mail, and applying it here would just make the weekly unreliable.
  const subject = buildWeeklySubject(perSite);
  const text = buildWeeklyText(perSite);
  const cfg = process.env.RESEND_API_KEY && process.env.SEO_ALERT_FROM && process.env.SEO_ALERT_TO;
  if (dryRun || !cfg) {
    log(`--- would send: ${subject} ---\n`);
    log(text);
  } else {
    log(`Emailed (${await sendEmail({
      apiKey: process.env.RESEND_API_KEY,
      from: process.env.SEO_ALERT_FROM,
      to: process.env.SEO_ALERT_TO,
      subject,
      text,
    })}): ${subject}`);
  }
} else if (!shouldSend({ opened: perSite.flatMap((s) => s.opened), resolved: perSite.flatMap((s) => s.resolved) })) {
  log('Nothing changed. No email — silence is the signal.');
} else {
  const subject = buildSubject(perSite);
  const text = buildText(perSite);
  const cfg = process.env.RESEND_API_KEY && process.env.SEO_ALERT_FROM && process.env.SEO_ALERT_TO;
  if (dryRun || !cfg) {
    log(`--- would send: ${subject} ---\n`);
    log(text);
  } else {
    const id = await sendEmail({
      apiKey: process.env.RESEND_API_KEY,
      from: process.env.SEO_ALERT_FROM,
      to: process.env.SEO_ALERT_TO,
      subject,
      text,
    });
    log(`Emailed (${id}): ${subject}`);
    if (canStore) {
      // Stamped only AFTER the send succeeded — a crash must not silence a finding.
      await store.markNotified(
        perSite.flatMap((s) => s.opened).map((x) => x.finding_id).filter(Boolean)
      );
    }
  }
}

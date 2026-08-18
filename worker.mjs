/**
 * The nightly trigger — a Cloudflare Worker on a cron schedule.
 *
 * WHY A WORKER AND NOT A SCHEDULED TASK ON THE LAPTOP: a monitor that only runs
 * when a particular machine happens to be awake is a monitor you cannot trust,
 * and the failure is silent — you get no email either way. This runs whether
 * anyone is at a desk or not.
 *
 * ONE DELIBERATE OMISSION: the redirect check. It reads public/_redirects from
 * the repo, which a Worker has no access to. It is also already enforced at
 * deploy time by aro-website's own gates, which refuse to publish when a rule
 * breaks — so checking it again nightly would be belt on top of a belt. It
 * stays available locally: `node run.mjs`.
 *
 * Deploy:  npx wrangler deploy
 * Secrets: npx wrangler secret put BOARDROOM_SUPABASE_URL
 *          npx wrangler secret put BOARDROOM_SUPABASE_SERVICE_ROLE_KEY
 *          npx wrangler secret put RESEND_API_KEY
 *          npx wrangler secret put SEO_ALERT_TO
 * Test:    curl -H "x-run-key: <SEO_RUN_KEY>" https://<worker>.workers.dev/run
 */
import { crawlSite } from './lib/crawl.mjs';
import { computeFindings, reconcile } from './lib/diff.mjs';
import { shouldSend, buildSubject, buildText, sendEmail } from './lib/report.mjs';
import { buildWeeklySubject, buildWeeklyText } from './lib/report.mjs';
import {
  orphanPages, missingFromSitemap, metadataWork, linkingOpportunities, buildWorkList,
} from './lib/opportunities.mjs';
import { getAccessToken, querySearchAnalytics, windowEnding } from './lib/searchconsole.mjs';
// Row SHAPE is shared with run.mjs even though the transport is not — this
// file talks to Supabase through `env`, not process.env. Keeping its own copy
// of the shaping is what let the `_bodyLinks` bug survive being fixed once.
import { pageRow } from './lib/store.mjs';

const SITES = [
  {
    company: 'aro',
    domain: 'actionrecoveryonline.com',
    sitemap_url: 'https://actionrecoveryonline.com/sitemap.xml',
    extra_hosts: ['www.actionrecoveryonline.com'],
    search_property: 'sc-domain:actionrecoveryonline.com',
  },
  {
    company: 'starlight',
    domain: 'starlightautoglass.com',
    sitemap_url: 'https://starlightautoglass.com/sitemap.xml',
    extra_hosts: ['www.starlightautoglass.com'],
    search_property: 'sc-domain:starlightautoglass.com',
  },
];

const SOURCE = 'seo.crawl';

function db(env) {
  // Missing config is OUR problem, and it must say so plainly. Without this it
  // surfaces as "Cannot read properties of undefined (reading 'replace')",
  // which tells whoever is on the end of it precisely nothing.
  const missing = ['BOARDROOM_SUPABASE_URL', 'BOARDROOM_SUPABASE_SERVICE_ROLE_KEY'].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(
      `not configured: ${missing.join(', ')} — set with: npx wrangler secret put ${missing[0]}`
    );
  }
  const base = env.BOARDROOM_SUPABASE_URL.replace(/\/$/, '');
  const headers = {
    apikey: env.BOARDROOM_SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.BOARDROOM_SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
  return async (path, { method = 'GET', body, prefer } = {}) => {
    const res = await fetch(`${base}/rest/v1/${path}`, {
      method,
      headers: prefer ? { ...headers, Prefer: prefer } : headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`supabase ${method} ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  };
}

/**
 * ONE SITE PER INVOCATION, and the reason is a hard platform limit.
 *
 * Cloudflare allows 50 subrequests per Worker invocation on the free plan. A
 * run covering both sites needs about 52 — 32 fetches to crawl ARO's 29 pages,
 * 7 for Starlight, plus Supabase and the email — and the retry added to
 * crawl.mjs can push a bad night higher still. The first real invocation died
 * on exactly that.
 *
 * So each cron trigger handles one site, and `event.cron` says which. Crons
 * cannot carry arguments, but they can be told apart, which is enough.
 *
 * A side benefit worth keeping even on a paid plan: a site whose crawl hangs
 * no longer takes the other one down with it. The cost is that a night with
 * problems on both sites produces two emails rather than one — acceptable,
 * because the subject names the site and most nights are silent anyway.
 */
const CRON_SITE = {
  '0 9 * * *': 'aro',
  '10 9 * * *': 'starlight',
};

/** Monday 07:00 Phoenix. The digest, not the alarm. */
const CRON_WEEKLY = '0 14 * * 1';

/**
 * The weekly digest: how search went, and what is worth doing.
 *
 * COVERS BOTH SITES IN ONE EMAIL, unlike the nightly run, because a digest
 * split in two is not a digest. That is affordable here only because this
 * path writes NOTHING to Supabase — it is a report, not a record — which buys
 * back the subrequests the nightly spends on storage.
 *
 * Budget, against Cloudflare's 50 per invocation: 39 to crawl both sites, one
 * token exchange, four analytics queries, one send. Roughly 45. If a rule is
 * ever added that needs more fetching, this is the number to check first.
 *
 * IT ALWAYS SENDS. The silence rule belongs to the nightly mail — a digest a
 * human expects on a Monday and does not get is indistinguishable from one
 * that had nothing to say, and the second time that happens nobody trusts it.
 */
async function runWeekly(env) {
  /**
   * THE CREDENTIAL IS THE JSON HERE, NOT A PATH — the opposite of what
   * searchconsole.mjs argues for, and for a reason it cannot avoid: a Worker
   * has no filesystem. `loadCredentials` reads a file, so the Worker parses
   * the secret directly instead.
   *
   * Missing credentials degrade to a digest with the work list and no
   * numbers, rather than no digest. A Monday with half the email is a visible
   * problem; a Monday with no email looks like a quiet week.
   */
  const key = env.GOOGLE_CREDENTIALS_JSON ? JSON.parse(env.GOOGLE_CREDENTIALS_JSON) : null;
  const token = key ? await getAccessToken(key) : null;
  const end = new Date(Date.now() - 3 * 86400000);
  const recent = windowEnding(end, 7);
  const prior = windowEnding(new Date(end.getTime() - 7 * 86400000), 7);

  const perSite = [];
  const perf = [];

  for (const site of SITES) {
    const snap = await crawlSite(site, {});
    const origin = `https://${site.domain}`;

    const bodyLinkCounts = new Map();
    const bodyText = new Map();
    const bodyLinksByPage = new Map();
    for (const p of snap.pages) {
      bodyText.set(p.url, p._bodyText || '');
      bodyLinksByPage.set(p.url, p._bodyLinks || []);
      for (const href of p._bodyLinks || []) {
        const abs = origin + href;
        if (abs !== p.url) bodyLinkCounts.set(abs, (bodyLinkCounts.get(abs) || 0) + 1);
      }
    }
    const sitemapUrls = snap.pages.map((p) => p.url);
    const targets = [
      { url: `${origin}/how-we-contact-your-customers`,
        phrases: ['phone call', 'contact your customers', 'letter series', 'escalat'] },
      { url: `${origin}/phoenix-debt-collection-agency`, phrases: ['Phoenix'] },
    ].filter((t) => sitemapUrls.includes(t.url));

    perSite.push({
      company: site.company,
      domain: site.domain,
      work: buildWorkList([
        orphanPages(snap.pages, bodyLinkCounts),
        missingFromSitemap(snap.pages, sitemapUrls),
        metadataWork(snap.pages),
        linkingOpportunities(snap.pages, targets, bodyText, bodyLinksByPage),
      ]),
    });

    if (token && site.search_property) {
      const totals = async (window) => {
        const rows = await querySearchAnalytics(token, site.search_property, {
          ...window, dimensions: ['query'], rowLimit: 500,
        });
        const impressions = rows.reduce((n, r) => n + r.impressions, 0);
        const clicks = rows.reduce((n, r) => n + r.clicks, 0);
        const weighted = rows.reduce((n, r) => n + r.position * r.impressions, 0);
        const brandRe = /action ?recovery|\baro\b|starlight/i;
        const part = (want) => {
          const sel = rows.filter((r) => brandRe.test(r.keys[0]) === want);
          return {
            impressions: sel.reduce((n, r) => n + r.impressions, 0),
            clicks: sel.reduce((n, r) => n + r.clicks, 0),
          };
        };
        return {
          impressions, clicks, queries: rows.length,
          position: impressions ? weighted / impressions : null,
          brand: part(true), nonBrand: part(false),
        };
      };
      perf.push({
        company: site.company, recent, prior,
        thisWeek: await totals(recent),
        lastWeek: await totals(prior),
      });
    }
  }

  await sendEmail({
    apiKey: env.RESEND_API_KEY,
    from: env.SEO_ALERT_FROM ?? 'Boardroom SEO <alerts@send.actionrecoveryonline.com>',
    to: env.SEO_ALERT_TO,
    subject: buildWeeklySubject(perSite),
    text: buildWeeklyText(perSite, perf),
  });

  return {
    emailed: true,
    sites: perSite.length,
    work: perSite.reduce((n, s) => n + s.work.length, 0),
    performance: perf.length,
  };
}

async function runOnce(env, only = null) {
  const q = db(env);
  const perSite = [];

  for (const site of SITES.filter((s) => !only || s.company === only)) {
    const snap = await crawlSite(site, {});

    // Baseline = last SUCCESSFUL run. Diffing against a failed crawl would
    // report every page as missing.
    const runs = await q(
      `seo_runs?company=eq.${site.company}&error=is.null&select=run_id&order=observed_at.desc&limit=1`
    );
    const previous = runs?.length
      ? { pages: (await q(`seo_pages?run_id=eq.${runs[0].run_id}&select=url,http_status,title,meta_description,canonical,h1_count,robots_meta,schema_types,content_hash&limit=2000`)) ?? [] }
      : null;

    const openRows = (await q(
      `seo_findings?company=eq.${site.company}&resolved_at=is.null&select=finding_id,kind,url,severity,detail`
    )) ?? [];

    const delta = reconcile(openRows, computeFindings(previous, snap, site));

    const [run] = await q('seo_runs', {
      method: 'POST',
      prefer: 'return=representation',
      body: [{
        company: site.company, source: SOURCE, observed_at: snap.observed_at,
        finished_at: new Date().toISOString(),
        pages_checked: snap.pages.length,
        pages_ok: snap.pages.filter((p) => p.http_status === 200).length,
        error: snap.error,
      }],
    });

    for (let i = 0; i < snap.pages.length; i += 200) {
      await q('seo_pages', {
        method: 'POST',
        prefer: 'return=minimal',
        body: snap.pages.slice(i, i + 200).map((p) =>
          pageRow(p, {
            runId: run.run_id,
            company: site.company,
            source: SOURCE,
            observedAt: snap.observed_at,
          })
        ),
      });
    }

    const now = new Date().toISOString();
    if (delta.opened.length) {
      await q('seo_findings', {
        method: 'POST',
        prefer: 'return=minimal',
        body: delta.opened.map((x) => ({
          company: site.company, source: SOURCE, kind: x.kind, severity: x.severity,
          url: x.url, detail: x.detail, previous_value: x.previous_value,
          current_value: x.current_value, first_seen: now, last_seen: now,
        })),
      });
    }
    const byKey = new Map(openRows.map((r) => [`${r.kind}::${r.url}`, r]));
    for (const x of delta.stillOpen) {
      const row = byKey.get(`${x.kind}::${x.url}`);
      if (row) await q(`seo_findings?finding_id=eq.${row.finding_id}`, { method: 'PATCH', prefer: 'return=minimal', body: { last_seen: now } });
    }
    for (const x of delta.resolved) {
      await q(`seo_findings?finding_id=eq.${x.finding_id}`, { method: 'PATCH', prefer: 'return=minimal', body: { resolved_at: now } });
    }

    perSite.push({
      company: site.company, domain: site.domain,
      pagesChecked: snap.pages.length,
      pagesOk: snap.pages.filter((p) => p.http_status === 200).length,
      redirectsChecked: 0,
      ...delta,
    });
  }

  const opened = perSite.flatMap((s) => s.opened);
  const resolved = perSite.flatMap((s) => s.resolved);

  if (!shouldSend({ opened, resolved })) {
    return { emailed: false, opened: 0, resolved: 0, note: 'nothing changed' };
  }

  await sendEmail({
    apiKey: env.RESEND_API_KEY,
    from: env.SEO_ALERT_FROM ?? 'Boardroom SEO <alerts@send.actionrecoveryonline.com>',
    to: env.SEO_ALERT_TO,
    subject: buildSubject(perSite),
    text: buildText(perSite),
  });

  return { emailed: true, opened: opened.length, resolved: resolved.length };
}

export default {
  async scheduled(event, env, ctx) {
    // An unrecognised cron runs everything rather than nothing: a schedule
    // added later should degrade to "does too much" and hit the subrequest
    // limit loudly, not to "does nothing" and go silent.
    if (event.cron === CRON_WEEKLY) {
      ctx.waitUntil(
        runWeekly(env).catch((err) => console.error(`weekly digest failed: ${err.message}`))
      );
      return;
    }
    const only = CRON_SITE[event.cron] ?? null;
    ctx.waitUntil(
      runOnce(env, only).catch((err) =>
        console.error(`seo monitor failed (${event.cron} -> ${only ?? 'all'}): ${err.message}`)
      )
    );
  },

  // Manual trigger, so a run can be forced without waiting for 3am. Behind a
  // shared key — an open endpoint that writes to the warehouse is the same
  // mistake boardroom-core already has.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/run') return new Response('not found', { status: 404 });
    if (!env.SEO_RUN_KEY || request.headers.get('x-run-key') !== env.SEO_RUN_KEY) {
      return new Response('unauthorized', { status: 401 });
    }
    try {
      // ?site=aro forces one site, matching what a cron does. Without it the
      // manual trigger runs both and trips the same subrequest limit the
      // split exists to avoid.
      // ?weekly=1 renders and sends the digest on demand, so it can be seen
      // without waiting until Monday.
      if (url.searchParams.get('weekly')) return Response.json(await runWeekly(env));
      const only = url.searchParams.get('site');
      return Response.json(await runOnce(env, only));
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  },
};

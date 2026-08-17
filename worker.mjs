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

const SITES = [
  {
    company: 'aro',
    domain: 'actionrecoveryonline.com',
    sitemap_url: 'https://actionrecoveryonline.com/sitemap.xml',
    extra_hosts: ['www.actionrecoveryonline.com'],
  },
  {
    company: 'starlight',
    domain: 'starlightautoglass.com',
    sitemap_url: 'https://starlightautoglass.com/sitemap.xml',
    extra_hosts: ['www.starlightautoglass.com'],
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

async function runOnce(env) {
  const q = db(env);
  const perSite = [];

  for (const site of SITES) {
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
        body: snap.pages.slice(i, i + 200).map((p) => ({
          run_id: run.run_id, company: site.company, source: SOURCE,
          observed_at: snap.observed_at, ...p,
        })),
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
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      runOnce(env).catch((err) => console.error(`seo monitor failed: ${err.message}`))
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
      return Response.json(await runOnce(env));
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  },
};

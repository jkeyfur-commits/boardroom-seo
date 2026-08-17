# Boardroom SEO monitor

Watches Action Recovery and Starlight every night and emails **only when
something changed**. Silence means fine.

It found the Starlight canonical bug on its first run — every page telling
Google to credit `cash-craft-auto.lovable.app` instead of
`starlightautoglass.com`. That had been live and invisible.

## Running it

```bash
node run.mjs --dry-run     # crawl + compare, write nothing, send nothing
node run.mjs               # the real thing
node run.mjs --site aro    # one company
npm test                   # the finding logic
```

Nightly in production: a Cloudflare Worker on a 09:00 UTC cron (02:00 Phoenix),
so a problem introduced by yesterday's deploy is in the inbox by breakfast.

## What it checks

Hostnames (apex **and** www), sitemap health, every page in the sitemap, titles,
meta descriptions, canonicals, H1s, `noindex`, structured data, duplicate
titles, and — locally only — every redirect rule.

Two kinds of check, and the split is the whole design:

- **Absolute** — true from tonight alone. "This 404s." "This canonical points
  off-site." These fire on the very first run.
- **Comparative** — needs yesterday. "The title changed." "A page vanished."
  **Skipped on a first run**, because with nothing to compare against everything
  looks new, and an alert that cries wolf on night one is never read again.

A crawl that fails outright reports **one** finding, never thirty. A network
blip must not read as "the whole site disappeared".

## Why the email is short

`seo_findings` is a ledger, not a snapshot: a finding opens the night it appears
and closes the night it stops. So the email says *"2 new, 1 fixed"* and counts
the rest. Long-standing issues are never re-listed — that is what kills
monitoring.

## Storage — and the Boardroom convention

Everything lands in the **`boardroom-analytics`** Supabase project, alongside
`nuvision_*`. Tables: `seo_sites`, `seo_runs`, `seo_pages`, `seo_findings`.

Naming follows the house style already there (`{source}_{entity}`, snake_case,
`loaded_at`). **One addition, and it is the bit worth copying:**

```
company      'aro' | 'starlight' | 'clear-title'
source       'seo.crawl' | 'seo.gsc' | 'ads.google' | ...
observed_at  when the fact was TRUE — not when it was written
```

`nuvision_*` has no `company` column because Nuvision *is* Starlight — single
tenant by accident of its source. Anything arriving next is multi-company, so
those three columns exist from row one rather than being retrofitted across a
million rows in a year.

`observed_at` vs `loaded_at` matters the first time anything is backfilled.
Conflating them is how a time-series warehouse starts quietly lying.

### If you are adding the next data source (ad spend, pipeline, calls)

1. **Do not build a general framework yet.** One real second source teaches more
   than any amount of designing for an imagined one.
2. **Carry those three columns.** That is the entire compatibility tax.
3. **Do not throw anything away.** Storage is cheap; a metric nobody recorded in
   March cannot be recovered in June.

## RLS

All four tables have Row Level Security **on with no policies** — service_role
writes, the publishable anon key reads nothing.

⚠️ The `nuvision_*` tables next door do **not**, and 39,412 rows of customer job
data are exposed to anyone holding that key. Four `SECURITY DEFINER` views
(`v_jobs_*`) would bypass RLS even after the tables are locked, so both need
fixing together. Flagged 2026-08-16, not yet done.

## Configuration

Local run needs nothing to crawl and report to the console. To store and email:

| Variable | Purpose |
|---|---|
| `BOARDROOM_SUPABASE_URL` | boardroom-analytics project URL |
| `BOARDROOM_SUPABASE_SERVICE_ROLE_KEY` | service role key |
| `RESEND_API_KEY` | sending |
| `SEO_ALERT_FROM` | defaults to `alerts@send.actionrecoveryonline.com` |
| `SEO_ALERT_TO` | comma-separated |
| `SEO_RUN_KEY` | shared secret for the manual `/run` endpoint |

The crawl works before any of these exist. That is deliberate — a job you cannot
develop without production credentials is a job whose credentials end up
somewhere they should not be.

## Deploying the nightly

```bash
npx wrangler deploy
npx wrangler secret put BOARDROOM_SUPABASE_URL
npx wrangler secret put BOARDROOM_SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put SEO_ALERT_TO
npx wrangler secret put SEO_RUN_KEY
```

Force a run without waiting for 3am:

```bash
curl -H "x-run-key: $SEO_RUN_KEY" https://boardroom-seo-monitor.<subdomain>.workers.dev/run
```

The Worker skips the redirect check — it cannot read `public/_redirects`, and
aro-website's deploy gates already refuse to publish when a rule breaks.

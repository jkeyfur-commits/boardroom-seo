/**
 * Turning facts into findings.
 *
 * TWO KINDS OF CHECK, and the distinction is the whole design:
 *
 *   ABSOLUTE    true or false from tonight alone. "This page 404s."
 *               "This canonical points at another domain." These fire on the
 *               very first run, before any history exists.
 *
 *   COMPARATIVE only meaningful against yesterday. "This title changed."
 *               "This page vanished from the sitemap." These are SKIPPED on a
 *               first run — with nothing to compare to, everything looks new,
 *               and an alert that cries wolf on night one is never read again.
 *
 * A finding is identified by (company, kind, url). The store opens it the first
 * night it appears and closes it the night it stops — so the email says "2 new,
 * 1 fixed" instead of re-listing the same forty items until you stop reading.
 */

const crit = 'critical';
const warn = 'warning';
const info = 'info';

const f = (kind, severity, url, detail, extra = {}) => ({
  kind,
  severity,
  url: url ?? '',
  detail,
  previous_value: extra.previous ?? null,
  current_value: extra.current ?? null,
});

const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
};

/** Checks that need only tonight's crawl. */
export function absoluteFindings(snap, site) {
  const out = [];
  const expectedHost = site.domain;

  for (const h of snap.hostChecks) {
    if (h.status !== 200) {
      out.push(
        f('host_down', crit, `https://${h.host}/`,
          `${h.host} returned ${h.status || 'no response'}${h.error ? ` (${h.error})` : ''}`,
          { current: String(h.status) })
      );
      continue;
    }

    /**
     * An alias host that serves the site in its own right, rather than
     * redirecting to the canonical one.
     *
     * FOUND BY HAND ON 2026-08-17, NOT BY THIS MONITOR — which is the reason
     * the check exists. `www.actionrecoveryonline.com` had been answering 200
     * for months while every canonical tag pointed at the apex, and Search
     * Console showed the homepage's impressions split three ways across
     * hostnames. This file was watching that host the whole time and only ever
     * asked whether it responded.
     *
     * Warning, not critical: nothing is broken for a visitor, and Google does
     * eventually consolidate on the canonical. It is ranking signal leaking
     * away slowly, which is precisely the kind of thing nobody notices.
     */
    if (!h.is_canonical && h.final_host && h.final_host !== expectedHost) {
      out.push(
        f('duplicate_host', warn, `https://${h.host}/`,
          `${h.host} serves the site instead of redirecting to ${expectedHost}`,
          { current: h.final_host, previous: expectedHost })
      );
    }
  }

  if (snap.sitemapError) {
    out.push(f('sitemap_problem', crit, site.sitemap_url, snap.sitemapError, { current: snap.sitemapError }));
  }

  for (const p of snap.pages) {
    if (p.http_status !== 200) {
      out.push(f('page_error', crit, p.url, `Returns HTTP ${p.http_status}`, { current: String(p.http_status) }));
      continue; // everything below assumes a page we could actually read
    }

    if ((p.robots_meta || '').toLowerCase().includes('noindex')) {
      out.push(f('noindex', crit, p.url, 'Page tells search engines not to index it', { current: p.robots_meta }));
    }

    // The same instruction, delivered as a response header instead of markup.
    // Checked separately because it is invisible in the HTML and therefore
    // invisible to every check above it.
    //
    // NOT HYPOTHETICAL: on 2026-08-16 a staging build — carrying both this
    // header and the meta tag — was published to actionrecoveryonline.com by
    // a deploy script whose "review" branch was the production branch. It sat
    // live for roughly eleven hours. The meta check above would have caught
    // it; nothing was crawling, so nothing did. The deploy script is fixed,
    // and this is the second line of defence.
    if ((p.x_robots_tag || '').toLowerCase().includes('noindex')) {
      out.push(
        f('noindex_header', crit, p.url, 'Server header tells search engines not to index this page', {
          current: p.x_robots_tag,
        })
      );
    }

    // The Starlight bug. A canonical pointing at another host hands that host
    // the credit for this page — it is the single most damaging thing a page
    // can quietly say, because nothing looks broken to a human visitor.
    if (p.canonical) {
      const ch = hostOf(p.canonical);
      if (ch && expectedHost && ch !== expectedHost && ch !== `www.${expectedHost}`) {
        out.push(
          f('canonical_offsite', crit, p.url,
            `Canonical points to ${ch}, not ${expectedHost} — this tells Google to credit the other domain`,
            { current: p.canonical })
        );
      }
    } else {
      out.push(f('canonical_missing', warn, p.url, 'No canonical tag'));
    }

    if (!p.title) out.push(f('title_missing', crit, p.url, 'No title tag'));
    if (!p.meta_description) out.push(f('description_missing', warn, p.url, 'No meta description'));
    if (p.h1_count === 0) out.push(f('h1_missing', warn, p.url, 'No H1 heading'));
    if (p.h1_count > 1) out.push(f('h1_multiple', info, p.url, `${p.h1_count} H1 headings`, { current: String(p.h1_count) }));
    if (p.schema_types?.includes('__invalid_json_ld__')) {
      out.push(f('schema_invalid', warn, p.url, 'Structured data on the page is not valid JSON'));
    }
  }

  // Duplicates are a property of the SET, not of any one page.
  const byTitle = new Map();
  for (const p of snap.pages) {
    if (!p.title || p.http_status !== 200) continue;
    byTitle.set(p.title, [...(byTitle.get(p.title) ?? []), p.url]);
  }
  for (const [title, urls] of byTitle) {
    if (urls.length > 1) {
      out.push(
        f('duplicate_title', warn, urls[0],
          `${urls.length} pages share the title "${title}": ${urls.join(', ')}`,
          { current: title })
      );
    }
  }

  for (const r of snap.redirects) {
    if (!r.ok) {
      out.push(
        f('redirect_broken', crit, r.from,
          `${r.from} should land on ${r.to} — got HTTP ${r.final_status} at ${r.final_url}`,
          { current: `${r.final_status} ${r.final_url}` })
      );
    }
  }

  return out;
}

/** Checks that only mean something against a previous crawl. */
export function comparativeFindings(prev, curr) {
  if (!prev) return []; // first run: nothing to compare, so claim nothing

  const before = new Map(prev.pages.map((p) => [p.url, p]));
  const after = new Map(curr.pages.map((p) => [p.url, p]));
  const out = [];

  for (const [url, was] of before) {
    if (!after.has(url)) {
      out.push(f('page_dropped', crit, url, 'Page was in the sitemap yesterday and is gone today'));
      continue;
    }
    const now = after.get(url);
    if (was.http_status === 200 && now.http_status !== 200) {
      out.push(
        f('page_broke', crit, url, `Was working, now returns HTTP ${now.http_status}`,
          { previous: '200', current: String(now.http_status) })
      );
    }
    if (was.title && now.title && was.title !== now.title) {
      out.push(f('title_changed', warn, url, 'Title changed', { previous: was.title, current: now.title }));
    }
    if (was.meta_description && now.meta_description && was.meta_description !== now.meta_description) {
      out.push(
        f('description_changed', info, url, 'Meta description changed',
          { previous: was.meta_description, current: now.meta_description })
      );
    }
    if (was.canonical && now.canonical && was.canonical !== now.canonical) {
      out.push(f('canonical_changed', warn, url, 'Canonical changed', { previous: was.canonical, current: now.canonical }));
    }
    // Losing structured data is silent and costs rich results.
    const lost = (was.schema_types ?? []).filter((t) => !(now.schema_types ?? []).includes(t));
    if (lost.length) {
      out.push(
        f('schema_lost', warn, url, `Structured data removed: ${lost.join(', ')}`,
          { previous: (was.schema_types ?? []).join(', '), current: (now.schema_types ?? []).join(', ') })
      );
    }
  }

  const added = [...after.keys()].filter((u) => !before.has(u));
  if (added.length) {
    out.push(
      f('pages_added', info, '', `${added.length} new page(s) in the sitemap: ${added.slice(0, 5).join(', ')}${added.length > 5 ? '…' : ''}`,
        { current: String(added.length) })
    );
  }

  return out;
}

/**
 * A run that could not see the site is NOT evidence that the site changed.
 * Diffing a failed crawl reports every page as dropped — thirty false alarms
 * from one flaky network moment, which is how people learn to ignore alerts.
 */
export function computeFindings(prev, curr, site) {
  if (curr.error) {
    return [f('crawl_failed', crit, site.domain, `Crawl could not complete: ${curr.error}`, { current: curr.error })];
  }
  return [...absoluteFindings(curr, site), ...comparativeFindings(prev, curr)];
}

/** What changed since last night — the only thing worth emailing. */
export function reconcile(openFindings, current) {
  const key = (x) => `${x.kind}::${x.url}`;
  const currentKeys = new Set(current.map(key));
  const openKeys = new Set(openFindings.map(key));

  return {
    opened: current.filter((c) => !openKeys.has(key(c))),
    stillOpen: current.filter((c) => openKeys.has(key(c))),
    resolved: openFindings.filter((o) => !currentKeys.has(key(o))),
  };
}

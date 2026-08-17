/**
 * The collector. Fetches a site and records what it finds — facts only.
 *
 * DESIGN RULE: nothing in this file decides whether something is GOOD or BAD.
 * It records `http_status`, not `is_broken`. Interpretation lives in diff.mjs,
 * against yesterday's facts. Mixing the two is how monitoring ends up
 * re-reporting the same forty issues every morning until nobody reads it.
 *
 * No dependencies — Node's fetch plus regex parsing. A real HTML parser would
 * be nicer, but this runs against sites we build ourselves and control the
 * markup of, and a zero-install collector is one less thing to break at 3am.
 */

const UA = 'boardroom-seo/1.0 (+monitoring; contact jim@arocollections.com)';

/** Bounded-concurrency map. Politeness, not performance — these are our own
 *  origins and hammering Cloudflare with 30 parallel requests looks like an
 *  attack to its own WAF. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function get(url, { redirect = 'follow', timeoutMs = 20000 } = {}) {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect,
      signal: ctl.signal,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml' },
    });
    const body = await res.text();
    return {
      status: res.status,
      finalUrl: res.url,
      body,
      ms: Date.now() - started,
      location: res.headers.get('location'),
      // A noindex delivered as a HEADER is invisible in the HTML. ARO's own
      // staging/_headers sets exactly this on /*, and its comment explains
      // why: it "does not depend on a crawler parsing the document". Which is
      // precisely what made it invisible to a crawler parsing the document.
      xRobotsTag: res.headers.get('x-robots-tag'),
    };
  } catch (err) {
    return { status: 0, finalUrl: url, body: '', ms: Date.now() - started, error: String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

const strip = (s) =>
  s == null
    ? null
    : s
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

const attr = (html, re) => {
  const m = html.match(re);
  return m ? strip(m[1]) : null;
};

/** FNV-1a — we only need "did this change", not cryptographic strength. */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function parsePage(url, res) {
  const html = res.body || '';

  // Main content only — the header and footer are on every page, so hashing
  // the whole document would flag all 30 pages whenever the footer changes.
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const mainText = strip(mainMatch ? mainMatch[1] : html) || '';

  const schemaTypes = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)]
    .flatMap((m) => {
      try {
        const json = JSON.parse(m[1]);
        const nodes = json['@graph'] || (Array.isArray(json) ? json : [json]);
        return nodes.map((n) => n && n['@type']).filter(Boolean);
      } catch {
        // Malformed JSON-LD is itself a finding — recorded as a sentinel type
        // rather than silently swallowed.
        return ['__invalid_json_ld__'];
      }
    });

  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => strip(m[1]));

  return {
    url,
    http_status: res.status,
    redirected_to: res.finalUrl !== url ? res.finalUrl : null,
    response_ms: res.ms,
    title: attr(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
    meta_description: attr(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i),
    canonical: attr(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i),
    h1: h1s[0] ?? null,
    h1_count: h1s.length,
    robots_meta: attr(html, /<meta[^>]+name=["']robots["'][^>]+content=["']([^"']*)["']/i),
    x_robots_tag: res.xRobotsTag ?? null,
    word_count: mainText ? mainText.split(/\s+/).filter(Boolean).length : 0,
    schema_types: [...new Set(schemaTypes)],
    internal_links: [...html.matchAll(/href=["'](\/[^"'#?][^"']*)["']/g)].length,
    content_hash: hash(mainText),
    // Layer 2 needs WHICH links and the readable text, not just counts.
    // Scoped to <main> on purpose: header and footer links appear on every
    // page, so counting them would make every page look well-linked and the
    // orphan check would never fire.
    _bodyLinks: [...(mainMatch ? mainMatch[1] : '').matchAll(/href=["'](\/[^"'#?][^"']*)["']/g)].map((m) => m[1]),
    _bodyText: mainText.slice(0, 20000),
  };
}

async function readSitemap(sitemapUrl) {
  const res = await get(sitemapUrl);
  if (res.status !== 200) return { urls: [], error: `sitemap HTTP ${res.status}` };
  const urls = [...res.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  return { urls, error: urls.length ? null : 'sitemap parsed to zero URLs' };
}

/**
 * Redirect rules, checked the way a crawler experiences them: does the source
 * 301, and does the destination actually serve a 200? A 301 into a 404 passes
 * a naive check and recovers nothing.
 */
async function checkRedirects(origin, rulesText) {
  const rules = rulesText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/))
    .filter((p) => p.length >= 2)
    .map(([from, to]) => ({ from, to }));

  return pool(rules, 6, async ({ from, to }) => {
    const hop = await get(origin + from, { redirect: 'manual' });
    const final = await get(origin + from, { redirect: 'follow' });
    const expected = origin + to;
    return {
      from,
      to,
      hop_status: hop.status,
      final_status: final.status,
      final_url: final.finalUrl,
      ok: (hop.status === 301 || hop.status === 308) && final.status === 200 && final.finalUrl === expected,
    };
  });
}

export async function crawlSite(site, { readFile } = {}) {
  const observed_at = new Date().toISOString();
  const origin = `https://${site.domain}`;

  const hostChecks = await pool([site.domain, ...(site.extra_hosts || [])], 4, async (host) => {
    const r = await get(`https://${host}/`);
    return { host, status: r.status, ms: r.ms, error: r.error ?? null };
  });

  const { urls, error: sitemapError } = await readSitemap(site.sitemap_url);
  const pages = await pool(urls, 5, async (u) => parsePage(u, await get(u)));

  let redirects = [];
  if (site.redirects_path && site.repo_path && readFile) {
    try {
      redirects = await checkRedirects(origin, await readFile(site.repo_path, site.redirects_path));
    } catch (err) {
      redirects = [];
      console.error(`  redirects unreadable: ${err.message}`);
    }
  }

  return {
    company: site.company,
    source: 'seo.crawl',
    observed_at,
    hostChecks,
    sitemapError,
    pages,
    redirects,
    // A run that could not see the site must be marked, never diffed. Otherwise
    // "the network blipped" reads as "every page vanished" and fires 30 alarms.
    error: sitemapError && pages.length === 0 ? sitemapError : null,
  };
}

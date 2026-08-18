/**
 * Persistence into Boardroom analytics, over Supabase's REST endpoint.
 *
 * No SDK on purpose — this is four table writes and a couple of reads, and a
 * dependency-free job is one less thing to break unattended at 3am.
 *
 * Every row carries company / source / observed_at, the Boardroom convention:
 * whose fact it is, which collector produced it, and when it was TRUE (as
 * distinct from when we wrote it down, which is loaded_at and defaults in the
 * database). Those diverge on any backfill.
 */

const SOURCE = 'seo.crawl';

function client() {
  const url = process.env.BOARDROOM_SUPABASE_URL;
  const key = process.env.BOARDROOM_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null; // caller decides whether that is fatal
  return {
    url: url.replace(/\/$/, ''),
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
  };
}

export const storeConfigured = () => client() !== null;

async function req(path, { method = 'GET', body, prefer } = {}) {
  const c = client();
  if (!c) throw new Error('BOARDROOM_SUPABASE_URL / _SERVICE_ROLE_KEY not set');
  const headers = { ...c.headers };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${c.url}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`supabase ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** The previous SUCCESSFUL run — a failed crawl is not a baseline. */
export async function loadPreviousSnapshot(company) {
  const runs = await req(
    `seo_runs?company=eq.${company}&error=is.null&select=run_id,observed_at&order=observed_at.desc&limit=1`
  );
  if (!runs?.length) return null;
  const pages = await req(
    `seo_pages?run_id=eq.${runs[0].run_id}&select=url,http_status,title,meta_description,canonical,h1_count,robots_meta,schema_types,content_hash&limit=2000`
  );
  return { pages: pages ?? [], observed_at: runs[0].observed_at };
}

export async function loadOpenFindings(company) {
  return (
    (await req(
      `seo_findings?company=eq.${company}&resolved_at=is.null&select=finding_id,kind,url,severity,detail,first_seen,notified_at`
    )) ?? []
  );
}

export async function saveRun(snap, counts) {
  const [row] = await req('seo_runs', {
    method: 'POST',
    prefer: 'return=representation',
    body: [
      {
        company: snap.company,
        source: SOURCE,
        observed_at: snap.observed_at,
        finished_at: new Date().toISOString(),
        pages_checked: counts.pagesChecked,
        pages_ok: counts.pagesOk,
        redirects_checked: counts.redirectsChecked,
        redirects_ok: counts.redirectsOk,
        error: snap.error,
      },
    ],
  });
  return row.run_id;
}

/**
 * The columns `seo_pages` actually has. Spreading the whole page object was
 * fine until the crawler grew fields that exist only in memory — `_bodyLinks`
 * and `_bodyText`, which feed layer 2 and are far too large to store anyway.
 * PostgREST rejects the entire batch on the first unknown key, so a field
 * added for one purpose broke persistence for every purpose.
 *
 * An allow-list rather than "strip keys starting with _": the convention is
 * mine and the next person's new field will not follow it. This fails by
 * silently not storing something, which is recoverable; the alternative fails
 * by crashing the nightly run, which is not.
 */
const PAGE_COLUMNS = [
  'url', 'http_status', 'redirected_to', 'response_ms', 'title', 'meta_description',
  'canonical', 'h1', 'h1_count', 'robots_meta', 'x_robots_tag', 'word_count',
  'schema_types', 'internal_links', 'content_hash',
];

export async function savePages(runId, snap) {
  if (!snap.pages.length) return 0;
  // Chunked: one 3000-row request is a timeout waiting to happen.
  const rows = snap.pages.map((p) => {
    const row = {
      run_id: runId,
      company: snap.company,
      source: SOURCE,
      observed_at: snap.observed_at,
    };
    for (const c of PAGE_COLUMNS) if (p[c] !== undefined) row[c] = p[c];
    return row;
  });
  for (let i = 0; i < rows.length; i += 200) {
    await req('seo_pages', { method: 'POST', prefer: 'return=minimal', body: rows.slice(i, i + 200) });
  }
  return rows.length;
}

/**
 * Findings are a LEDGER, not a snapshot: open the new ones, touch the ones that
 * persist, close the ones that stopped. That is what lets the email say
 * "2 new, 1 fixed" instead of restating everything every night.
 */
export async function applyFindings(company, { opened, stillOpen, resolved }, openRows) {
  const now = new Date().toISOString();

  if (opened.length) {
    await req('seo_findings', {
      method: 'POST',
      prefer: 'return=minimal',
      body: opened.map((x) => ({
        company,
        source: SOURCE,
        kind: x.kind,
        severity: x.severity,
        url: x.url,
        detail: x.detail,
        previous_value: x.previous_value,
        current_value: x.current_value,
        first_seen: now,
        last_seen: now,
      })),
    });
  }

  const byKey = new Map(openRows.map((r) => [`${r.kind}::${r.url}`, r]));

  for (const x of stillOpen) {
    const row = byKey.get(`${x.kind}::${x.url}`);
    if (row) {
      await req(`seo_findings?finding_id=eq.${row.finding_id}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: { last_seen: now, current_value: x.current_value },
      });
    }
  }

  for (const x of resolved) {
    await req(`seo_findings?finding_id=eq.${x.finding_id}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: { resolved_at: now },
    });
  }
}

/** Stamped only after the alert actually sent, so a crash cannot silence a finding. */
export async function markNotified(findingIds) {
  if (!findingIds.length) return;
  await req(`seo_findings?finding_id=in.(${findingIds.join(',')})`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: { notified_at: new Date().toISOString() },
  });
}

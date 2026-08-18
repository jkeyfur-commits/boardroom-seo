/**
 * Search Console API client — the half of layer 2 that needed credentials.
 *
 * No dependencies, same rule as the rest of this repo. Google's own client
 * library pulls in a large dependency tree to do what amounts to signing a
 * JWT and posting it, and a zero-install collector is one less thing to break
 * at 3am.
 *
 * AUTH: service account, two-legged. Sign a JWT with the private key, trade it
 * for an access token, use that for an hour. There is no user consent step and
 * no refresh token to expire — which is exactly why a service account is the
 * right choice for something that runs unattended every night.
 *
 * ACCESS IS GRANTED IN SEARCH CONSOLE, NOT IAM. The service account has no
 * project roles at all. It reads data because it was added as a Restricted
 * user on each property (2026-08-16). Adding IAM roles here would do nothing;
 * removing that user is what revokes access.
 *
 * WHAT "RESTRICTED" ALLOWS: searchAnalytics.query, which is everything the
 * three checks need. If a call ever returns 403 with a permission message,
 * the fix is the Users and permissions page, not this file.
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * The credential is a FILE PATH in the environment, never the JSON itself.
 *
 * A 2.3KB blob containing a PEM private key does not belong in an env var: it
 * gets truncated by shells, mangled by newline handling, and echoed into logs
 * by anything that dumps the environment on error. The path is boring and the
 * file has filesystem permissions.
 */
export function loadCredentials(path = process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  if (!path) return null;
  try {
    const key = JSON.parse(readFileSync(path, 'utf8'));
    if (!key.client_email || !key.private_key || !key.token_uri) {
      throw new Error('missing client_email, private_key or token_uri');
    }
    return key;
  } catch (err) {
    // Loud, not silent. A monitor that quietly loses its search data looks
    // identical to a site with no search opportunities.
    throw new Error(`Search Console credentials unusable (${path}): ${err.message}`);
  }
}

export const searchConfigured = () => Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);

/** Sign the assertion and trade it for an access token. Valid one hour. */
export async function getAccessToken(key, { now = Date.now } = {}) {
  const iat = Math.floor(now() / 1000);
  const claims = {
    iss: key.client_email,
    scope: SCOPE,
    aud: key.token_uri,
    // 3600 is Google's maximum. Anything larger is rejected outright, which
    // reads as a malformed key rather than as a too-long lifetime.
    exp: iat + 3600,
    iat,
  };
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
  const signature = b64url(createSign('RSA-SHA256').update(unsigned).sign(key.private_key));

  const res = await fetch(key.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Google's error here is genuinely informative — "invalid_grant" means a
    // clock skew or a revoked key, not a typo — so it is surfaced verbatim
    // rather than replaced with a friendlier message that says less.
    throw new Error(`token exchange ${res.status}: ${body.error || ''} ${body.error_description || ''}`.trim());
  }
  return body.access_token;
}

/**
 * One page of search analytics. `siteUrl` is the Search Console property id —
 * for a Domain property that is `sc-domain:example.com`, NOT a URL. Passing
 * `https://example.com/` to a Domain property returns 403, which reads like a
 * permission problem and is actually a naming one.
 */
export async function querySearchAnalytics(token, siteUrl, body) {
  const res = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`searchAnalytics ${res.status}: ${json.error?.message || 'unknown'}`);
  }
  return json.rows || [];
}

/** YYYY-MM-DD, `days` before `end`. Search Console works in whole UTC days. */
export const dayString = (d) => d.toISOString().slice(0, 10);
export function windowEnding(end, days) {
  const start = new Date(end.getTime() - days * 86400000);
  return { startDate: dayString(start), endDate: dayString(end) };
}

/**
 * Everything the three checks need, in two calls per site.
 *
 * DATA IS 2–3 DAYS BEHIND. Search Console finalises slowly, so the window ends
 * three days ago rather than today — otherwise the most recent days read as a
 * traffic collapse every single night, which is the fastest way to make this
 * monitor unreadable.
 */
export async function fetchSearchData(key, siteUrl, { now = () => new Date() } = {}) {
  const token = await getAccessToken(key, { now: () => now().getTime() });
  const end = new Date(now().getTime() - 3 * 86400000);

  const recent = windowEnding(end, 28);
  const prior = windowEnding(new Date(end.getTime() - 28 * 86400000), 28);

  const byQueryAndPage = await querySearchAnalytics(token, siteUrl, {
    ...recent,
    dimensions: ['query', 'page'],
    rowLimit: 500,
  });
  const pagesPrior = await querySearchAnalytics(token, siteUrl, {
    ...prior,
    dimensions: ['page'],
    rowLimit: 500,
  });

  return { siteUrl, recent, prior, byQueryAndPage, pagesPrior };
}

/**
 * Week-over-week totals for the digest.
 *
 * TWO WHOLE WEEKS, ENDING THREE DAYS AGO. Search Console finalises 2–3 days
 * behind, so a window ending today reports a collapse every time; and a
 * part-week compared against a full one reports a collapse once. Both are the
 * same lie told differently.
 *
 * Position is impression-weighted, not a mean of means. Averaging the average
 * positions of 200 rows treats a query with 2 impressions as equal to one with
 * 200, which produces a number that moves for no reason.
 */
export async function fetchWeeklyPerformance(key, siteUrl, { now = () => new Date() } = {}) {
  const token = await getAccessToken(key, { now: () => now().getTime() });
  const end = new Date(now().getTime() - 3 * 86400000);

  const totals = async (window) => {
    const rows = await querySearchAnalytics(token, siteUrl, {
      ...window,
      dimensions: ['query'],
      rowLimit: 500,
    });
    const impressions = rows.reduce((n, r) => n + r.impressions, 0);
    const clicks = rows.reduce((n, r) => n + r.clicks, 0);
    const weighted = rows.reduce((n, r) => n + r.position * r.impressions, 0);
    return {
      impressions,
      clicks,
      queries: rows.length,
      position: impressions ? weighted / impressions : null,
      // Brand vs the rest. The whole question for ARO is whether anyone who
      // was NOT already looking for it ever arrives, and a single total hides
      // that completely.
      brand: split(rows, true),
      nonBrand: split(rows, false),
    };
  };

  const recent = windowEnding(end, 7);
  const prior = windowEnding(new Date(end.getTime() - 7 * 86400000), 7);
  return { siteUrl, recent, prior, thisWeek: await totals(recent), lastWeek: await totals(prior) };
}

/** Rows whose query contains the brand, or the ones that do not. */
function split(rows, wantBrand, brandRe = /action ?recovery|\baro\b|starlight/i) {
  const sel = rows.filter((r) => brandRe.test(r.keys[0]) === wantBrand);
  return {
    impressions: sel.reduce((n, r) => n + r.impressions, 0),
    clicks: sel.reduce((n, r) => n + r.clicks, 0),
  };
}

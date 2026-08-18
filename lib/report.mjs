/**
 * The email.
 *
 * ONE RULE ABOVE ALL: send nothing when nothing changed.
 *
 * A nightly "all clear" trains the reader to archive on sight, and then the one
 * night it says something real, it gets archived too. Silence has to mean
 * "fine", or the alert is decoration. So: only new problems and newly-fixed
 * ones. Long-standing issues are counted, never re-listed.
 */

const SEV_ORDER = { critical: 0, warning: 1, info: 2 };
const DOT = { critical: '🔴', warning: '🟠', info: '⚪' };

export function shouldSend({ opened, resolved }) {
  return opened.length > 0 || resolved.length > 0;
}

export function buildSubject(perSite) {
  const o = perSite.reduce((n, s) => n + s.opened.length, 0);
  const r = perSite.reduce((n, s) => n + s.resolved.length, 0);
  const worst = perSite.flatMap((s) => s.opened).some((x) => x.severity === 'critical');
  const bits = [];
  if (o) bits.push(`${o} new`);
  if (r) bits.push(`${r} fixed`);
  return `${worst ? '🔴 ' : ''}SEO monitor — ${bits.join(', ')}`;
}

const short = (s, n = 150) => (!s ? '' : s.length > n ? `${s.slice(0, n)}…` : s);

export function buildText(perSite) {
  const out = ['SEO MONITOR', ''];

  for (const s of perSite) {
    if (!s.opened.length && !s.resolved.length) continue;
    out.push(`── ${s.company.toUpperCase()} — ${s.domain}`, '');

    const sorted = [...s.opened].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
    for (const x of sorted) {
      out.push(`${DOT[x.severity]} ${x.kind.replace(/_/g, ' ')}`);
      if (x.url) out.push(`   ${x.url}`);
      out.push(`   ${short(x.detail, 220)}`);
      if (x.previous_value && x.current_value) {
        out.push(`   was: ${short(x.previous_value, 80)}`);
        out.push(`   now: ${short(x.current_value, 80)}`);
      }
      out.push('');
    }

    for (const x of s.resolved) {
      out.push(`🟢 FIXED — ${x.kind.replace(/_/g, ' ')}${x.url ? `  ${x.url}` : ''}`);
    }
    if (s.resolved.length) out.push('');

    // Counted, not listed. You already know about these.
    if (s.stillOpen.length) out.push(`(${s.stillOpen.length} known issue(s) still open, unchanged)`, '');

    out.push(`Checked ${s.pagesChecked} pages${s.redirectsChecked ? `, ${s.redirectsChecked} redirects` : ''}.`, '');
  }

  const work = buildWorkText(perSite);
  if (work) out.push(work, '');

  out.push('—', 'Boardroom SEO monitor. Silence means nothing changed.');
  return out.join('\n');
}

/**
 * The layer-2 section: what is worth doing, as opposed to what broke.
 *
 * IT NEVER TRIGGERS AN EMAIL. `shouldSend` deliberately ignores it. An
 * opportunity is a judgement call that is still true tomorrow, so mailing it
 * nightly would put a message in the inbox every single night and destroy the
 * one property that makes this monitor worth reading — that silence means
 * fine. It rides along on a mail that was going out anyway, or on the weekly
 * digest, and otherwise waits.
 */
export function buildWorkText(perSite) {
  const withWork = perSite.filter((s) => s.work && s.work.length);
  if (!withWork.length) return '';

  const out = ['', 'WORTH DOING — ranked, not urgent', ''];
  for (const s of withWork) {
    out.push(`── ${s.company.toUpperCase()}`, '');
    for (const w of s.work) {
      out.push(`[${w.impact}] ${w.title}`);
      out.push(`   ${w.url}`);
      out.push(`   ${short(w.detail, 220)}`);
      out.push(`   → ${w.fix}`);
      out.push('');
    }
  }
  return out.join('\n').trimEnd();
}

export function buildWeeklySubject(perSite) {
  const n = perSite.reduce((t, s) => t + (s.work?.length || 0), 0);
  return `SEO — ${n} thing${n === 1 ? '' : 's'} worth doing`;
}

/**
 * A number with last week's beside it. Percentages on numbers this small
 * mislead — "up 790%" on 59 impressions is noise wearing a suit — so the pair
 * is shown and the reader can judge.
 *
 * `lowerIsBetter` exists because average position runs backwards, and the
 * first draft of this said "avg position 41.1 (up from 50.9)" — which reads
 * as a decline and was in fact the single biggest improvement on the page.
 * Directional words are the whole point of the line, so they say improved and
 * slipped rather than up and down for that one.
 */
function move(now, before, { lowerIsBetter = false } = {}) {
  if (now == null) return '-';
  if (before == null) return fmt(now);
  const n = Number(now), b = Number(before);
  if (b === 0) return `${fmt(n)}  (nothing last week)`;
  if (n === b) return `${fmt(n)}  (unchanged)`;
  const better = lowerIsBetter ? n < b : n > b;
  const word = lowerIsBetter ? (better ? 'improved' : 'slipped') : better ? 'up' : 'down';
  return `${fmt(n)}  (${word} from ${fmt(b)})`;
}
const fmt = (n) => (Number.isInteger(n) ? String(n) : Number(n).toFixed(1));

/**
 * The performance half of the digest.
 *
 * BRAND IS SPLIT OUT DELIBERATELY. A single impressions total on this site
 * would be dominated by people who already knew the name and were going to
 * arrive anyway. The number that says whether any of this is working is the
 * non-brand one, and it has to be impossible to miss.
 */
export function buildPerformanceText(perf) {
  const withData = perf.filter((p) => p && p.thisWeek);
  if (!withData.length) return '';

  const out = ['', 'SEARCH PERFORMANCE — seven days vs the seven before', ''];
  for (const p of withData) {
    // A missing prior week is normal, not exceptional: a property verified
    // this week has no week before it. `move` already prints a bare number
    // when there is nothing to compare against — this just has to not throw
    // on the way there, which the first version did.
    const a = p.thisWeek;
    const b = p.lastWeek ?? {};
    out.push(`── ${p.company.toUpperCase()}   ${p.recent.startDate} to ${p.recent.endDate}`);
    out.push(`   impressions   ${move(a.impressions, b.impressions)}`);
    out.push(`   clicks        ${move(a.clicks, b.clicks)}`);
    out.push(`   avg position  ${move(a.position, b.position, { lowerIsBetter: true })}`);
    out.push('');
    out.push(`   brand         ${a.brand.impressions} impressions, ${a.brand.clicks} clicks`);
    out.push(`   NON-BRAND     ${a.nonBrand.impressions} impressions, ${a.nonBrand.clicks} clicks`);
    out.push('');
    out.push(`   ${nonBrandVerdict(a)}`);
    out.push('');
  }
  return out.join('\n').trimEnd();
}

/** The one sentence worth reading, stated plainly rather than left to inference. */
function nonBrandVerdict(w) {
  const { impressions, clicks } = w.nonBrand;
  if (!impressions) return 'Nobody who was not already looking for you saw the site at all.';
  if (!clicks)
    return `${impressions} people searched for what this business does, saw it, and none clicked.`;
  return `${clicks} of ${impressions} non-brand impressions became a visit.`;
}

export function buildWeeklyText(perSite, perf = []) {
  const body = buildWorkText(perSite);
  const performance = buildPerformanceText(perf);
  return [
    'SEO — THE WEEKLY WORK LIST',
    '',
    'Nothing here is broken. These are ranked improvements, highest impact',
    'first. Ignoring the whole list for a week costs nothing — that is the',
    'difference between this mail and the nightly one.',
    performance,
    body || '\nNothing obvious to improve.',
    '',
    '—',
    'Boardroom SEO monitor.',
  ].join('\n');
}

export async function sendEmail({ apiKey, from, to, subject, text }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: to.split(',').map((s) => s.trim()).filter(Boolean), subject, text }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).id;
}

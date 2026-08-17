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

export function buildWeeklyText(perSite) {
  const body = buildWorkText(perSite);
  return [
    'SEO — THE WEEKLY WORK LIST',
    '',
    'Nothing here is broken. These are ranked improvements, highest impact',
    'first. Ignoring the whole list for a week costs nothing — that is the',
    'difference between this mail and the nightly one.',
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

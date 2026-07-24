// ─────────────────────────────────────────────
// Webmail message-list extraction
// ─────────────────────────────────────────────
// Readability treats an open email as the "article" and drops the surrounding
// inbox list as navigation — so "what OTHER messages do I have?" comes up empty.
// This recovers the message rows that are actually rendered on a mail client's
// page (sender / subject / snippet / date) so they can ride along in ephemeral
// page context. It reads ONLY what's visible in the DOM — no API, no account
// access, nothing stored. Host-gated so ordinary pages are never touched.

/** Mail-client hostnames we attempt to read. Kept conservative on purpose. */
const MAIL_HOST_RE = /(?:^|\.)mail\.google\.|outlook\.|\.live\.com|mail\.yahoo|proton\.me|mail\.proton|fastmail|(?:^|\.)mail\./i;

/** A time/date-ish token — used to tell a message row from a random grid row. */
const TIME_RE = /\b(\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}|(?:mon|tue|wed|thu|fri|sat|sun)|yesterday|today)\b/i;

const MAX_ROWS = 50;
const MAX_CHARS = 5000;
const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();

/** Gmail inbox rows (`tr.zA`) → one formatted line each. Gmail's markup is
 *  stable enough to target precisely; everything else uses the generic path. */
function extractGmail(doc: Document): string[] {
  const out: string[] = [];
  const rows = Array.from(doc.querySelectorAll<HTMLElement>('tr.zA'));
  for (const row of rows) {
    const sender = clean(
      row.querySelector('.yW [email]')?.getAttribute('name') ||
      row.querySelector('.yW [email]')?.textContent ||
      row.querySelector('.yW span')?.textContent ||
      row.querySelector('.zF')?.getAttribute('name') ||
      row.querySelector('.yX, .yW')?.textContent
    );
    const subject = clean(row.querySelector('.y6 span.bog, span.bog')?.textContent);
    const snippet = clean(row.querySelector('.y2')?.textContent).replace(/^[-–—\s]+/, '');
    const date = clean(row.querySelector('.xW span[title]')?.getAttribute('title') || row.querySelector('.xW span, .xW')?.textContent);
    if (!sender && !subject) continue;
    const unread = row.classList.contains('zE') ? ' *(unread)*' : '';
    let line = `- **${sender || 'Unknown sender'}** — ${subject || '(no subject)'}`;
    if (date) line += ` · ${date}`;
    line += unread;
    if (snippet) line += `\n  ${snippet}`;
    out.push(line);
  }
  return out;
}

/** Role-based fallback for non-Gmail clients: message rows are list/grid items
 *  that are short and carry a time token. Deliberately conservative to avoid
 *  slurping unrelated tables. */
function extractGeneric(doc: Document): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const containers = doc.querySelectorAll<HTMLElement>('[role="grid"], [role="list"], [role="main"], table');
  for (const container of Array.from(containers)) {
    const rows = container.querySelectorAll<HTMLElement>('[role="row"], [role="listitem"], tr');
    for (const row of Array.from(rows)) {
      const text = clean(row.innerText || row.textContent);
      // A message row is a short line that mentions a time/date. Skip headers,
      // paragraphs, and rows with nested rows (containers).
      if (text.length < 8 || text.length > 300) continue;
      if (!TIME_RE.test(text)) continue;
      if (row.querySelector('[role="row"], [role="listitem"]')) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      out.push(`- ${text}`);
      if (out.length >= MAX_ROWS) return out;
    }
    if (out.length > 0) break; // first container that yields rows wins
  }
  return out;
}

/**
 * Extract the message rows visible on a webmail page. Returns formatted markdown
 * lines, or `[]` when the page isn't a recognised mail client or has no rows.
 */
export function extractMailboxList(doc: Document, hostname: string): string[] {
  if (!MAIL_HOST_RE.test(hostname || '')) return [];

  let rows = /mail\.google\./i.test(hostname) ? extractGmail(doc) : [];
  if (rows.length === 0) rows = extractGeneric(doc);
  if (rows.length === 0) return [];

  rows = rows.slice(0, MAX_ROWS);
  // Trim to a char budget without cutting a row in half.
  const capped: string[] = [];
  let total = 0;
  for (const r of rows) {
    if (total + r.length > MAX_CHARS) break;
    capped.push(r);
    total += r.length;
  }
  return capped;
}

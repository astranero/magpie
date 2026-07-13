// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { extractMailboxList } from '../mailbox';

describe('extractMailboxList', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('extracts Gmail inbox rows (sender / subject / snippet / date / unread)', () => {
    document.body.innerHTML = `
      <table>
        <tr class="zA zE">
          <td class="yW"><span email="alice@example.com" name="Alice Vanzino">Alice</span></td>
          <td class="y6"><span class="bog">Apartment application</span></td>
          <td class="y2">- Reviewing all applications right now</td>
          <td class="xW"><span title="Jul 13, 2026">2:30 PM</span></td>
        </tr>
        <tr class="zA">
          <td class="yW"><span email="bob@corp.com" name="Bob Lee">Bob</span></td>
          <td class="y6"><span class="bog">Q3 report</span></td>
          <td class="y2">- Numbers are in</td>
          <td class="xW"><span title="Jul 12, 2026">Jul 12</span></td>
        </tr>
      </table>`;

    const rows = extractMailboxList(document, 'mail.google.com');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('**Alice Vanzino**');
    expect(rows[0]).toContain('Apartment application');
    expect(rows[0]).toContain('Jul 13, 2026');
    expect(rows[0]).toContain('*(unread)*');
    expect(rows[0]).toContain('Reviewing all applications');
    expect(rows[1]).toContain('**Bob Lee**');
    expect(rows[1]).not.toContain('*(unread)*'); // second row is read
  });

  it('falls back to role-based rows on non-Gmail mail hosts', () => {
    document.body.innerHTML = `
      <div role="grid">
        <div role="row">Carol Diaz   Lunch tomorrow?   2:45 PM</div>
        <div role="row">Dan Wu   Invoice #204   Yesterday</div>
        <div role="row">Header column that has no time and should be skipped</div>
      </div>`;

    const rows = extractMailboxList(document, 'outlook.live.com');
    expect(rows.length).toBe(2);            // header row (no time token) dropped
    expect(rows[0]).toMatch(/Carol Diaz.*Lunch tomorrow.*2:45 PM/);
    expect(rows[1]).toMatch(/Dan Wu.*Invoice.*Yesterday/i);
  });

  it('returns [] on a non-mail host even if the DOM looks tabular', () => {
    document.body.innerHTML = `<div role="grid"><div role="row">Alice  Something  2:30 PM</div></div>`;
    expect(extractMailboxList(document, 'example.com')).toEqual([]);
    expect(extractMailboxList(document, 'news.ycombinator.com')).toEqual([]);
  });

  it('returns [] on a mail host with no message rows', () => {
    document.body.innerHTML = `<div><p>Loading your inbox…</p></div>`;
    expect(extractMailboxList(document, 'mail.google.com')).toEqual([]);
  });
});

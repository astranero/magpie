// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  assessCoverage, looksLikeChallengePage, approxPageText,
  MIN_COVERAGE, MIN_PAGE_CHARS, demoteRunawayHeadings, sanitizeCaptureDom,
} from '../extraction-quality';

// No heuristic extractor works on every site. What this buys is that a bad
// extraction is DETECTED rather than shipped silently — which is the actual
// complaint: the capture looked fine and was missing the part that mattered.

const filler = (n: number) => 'word '.repeat(Math.ceil(n / 5)).slice(0, n);

describe('assessCoverage', () => {
  it('accepts an ordinary article extraction', () => {
    // Real extraction drops 70-80% of a page as nav/sidebar/footer. That is
    // normal and must never trip the check.
    const v = assessCoverage(filler(6000), filler(24000));
    expect(v.ok).toBe(true);
    expect(v.ratio).toBeCloseTo(0.25, 1);
  });

  it('flags a large page reduced to a sliver', () => {
    const v = assessCoverage(filler(900), filler(40000));
    expect(v.ok).toBe(false);
    expect(v.blocked).toBe(false);
    expect(v.reason).toMatch(/2%|captured/i);
  });

  it('exempts genuinely short pages', () => {
    // A ratio on a tiny page is noise, not signal.
    const v = assessCoverage(filler(200), filler(MIN_PAGE_CHARS - 500));
    expect(v.ok).toBe(true);
  });

  it('flags an extraction that is tiny in absolute terms', () => {
    const v = assessCoverage('short', filler(30000));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/almost nothing/i);
  });

  it('sits the threshold below normal article loss', () => {
    // Guards the constant itself: set too high, every article trips it.
    expect(MIN_COVERAGE).toBeLessThan(0.2);
  });

  it('treats an empty page as fully covered rather than dividing by zero', () => {
    expect(assessCoverage('anything', '').ok).toBe(true);
  });
});

describe('looksLikeChallengePage', () => {
  it('recognises the common interstitials', () => {
    expect(looksLikeChallengePage('Just a moment...\nEnable JavaScript and cookies to continue')).toBe(true);
    expect(looksLikeChallengePage('Attention Required! | Cloudflare')).toBe(true);
    expect(looksLikeChallengePage('Verifying you are human. This may take a few seconds.')).toBe(true);
    expect(looksLikeChallengePage('Pardon Our Interruption')).toBe(true);
  });

  it('does NOT flag a long article that merely mentions the words', () => {
    // A paper about bot detection is not a bot check.
    const article = 'Access denied errors are common. ' + filler(20000);
    expect(looksLikeChallengePage(article)).toBe(false);
  });

  it('handles empty input', () => {
    expect(looksLikeChallengePage('')).toBe(false);
  });
});

describe('blocked verdict', () => {
  it('reports a challenge page as blocked, with advice the user can act on', () => {
    const v = assessCoverage('Just a moment... Enable JavaScript and cookies to continue', filler(2000));
    expect(v.blocked).toBe(true);
    expect(v.ok).toBe(false);
    // The advice must point at the user's own session, not at defeating the check.
    expect(v.reason).toMatch(/browser tab/i);
  });
});

describe('approxPageText', () => {
  it('drops script and style bodies, keeps visible words', () => {
    const html = '<html><head><style>.a{color:red}</style></head><body><script>var x=1;</script><p>Hello world</p></body></html>';
    const out = approxPageText(html);
    expect(out).toContain('Hello world');
    expect(out).not.toContain('color:red');
    expect(out).not.toContain('var x');
  });

  it('collapses entities and whitespace', () => {
    expect(approxPageText('<p>a&nbsp;&amp;   b</p>')).toBe('a b');
  });
});

describe('demoteRunawayHeadings', () => {
  it('keeps a short, real heading', () => {
    expect(demoteRunawayHeadings('## Key findings')).toBe('## Key findings');
    expect(demoteRunawayHeadings('# Introduction')).toBe('# Introduction');
  });

  it('demotes a paragraph that was captured as one giant heading', () => {
    const para = '# ' + 'What can fix this? The fetch agent produced a real grounded summary of the actual discussions and it is now visible in the results file for everyone to read.';
    const out = demoteRunawayHeadings(para);
    expect(out.startsWith('#')).toBe(false);
    expect(out).toContain('What can fix this?');
  });

  it('demotes a multi-sentence heading even when not very long', () => {
    // "hf-notifications: X happened. Y also happened." — two sentences.
    const out = demoteRunawayHeadings('### hf-notifications: the fetch worked. The file did not exist.');
    expect(out.startsWith('#')).toBe(false);
    expect(out).toContain('hf-notifications');
  });

  it('leaves a heading with a trailing question mark alone if it is short', () => {
    expect(demoteRunawayHeadings('## What now?')).toBe('## What now?');
  });

  it('only touches heading lines, not body prose', () => {
    const md = '## Real heading\n\nA normal paragraph that is quite long but is not a heading at all, so it must survive verbatim without any change whatsoever here.';
    expect(demoteRunawayHeadings(md)).toBe(md);
  });

  it('is empty-safe', () => {
    expect(demoteRunawayHeadings('')).toBe('');
  });

  it('demotes the exact reported Gemini paragraph-heading', () => {
    // The line a user saw captured as a giant header, verbatim.
    const reported = '### hf-notifications: the fetch agent produced a real, grounded summary of the actual discussions (#14, #15, #7, #18, #22…) — now visible in RESULTS.md.';
    const out = demoteRunawayHeadings(reported);
    expect(out.startsWith('#')).toBe(false);
    expect(out).toContain('hf-notifications');
  });

  it('keeps a genuinely short heading like "what can fix this?"', () => {
    // If a site marks this as its own <h3>, it IS a heading — do not strip it.
    expect(demoteRunawayHeadings('### what can fix this?')).toBe('### what can fix this?');
  });
});

describe('sanitizeCaptureDom', () => {
  function docFrom(html: string): any {
    const d = document.implementation.createHTMLDocument('t');
    d.body.innerHTML = html;
    return d.body;
  }

  it('removes screen-reader-only labels so they do not leak into the capture', () => {
    const root = docFrom('<div><span class="cdk-visually-hidden">Sinä sanoit</span><p>real text</p></div>');
    sanitizeCaptureDom(root);
    expect(root.textContent).not.toContain('Sinä sanoit');
    expect(root.textContent).toContain('real text');
  });

  it('strips role=heading + aria-level from a non-heading element (Gemini query bubble)', () => {
    const root = docFrom('<div role="heading" aria-level="2" class="query-text"><p>what can fix this?</p></div>');
    sanitizeCaptureDom(root);
    const div = root.querySelector('div.query-text');
    expect(div?.getAttribute('role')).toBe(null);
    expect(div?.getAttribute('aria-level')).toBe(null);
  });

  it('leaves a real heading element untouched', () => {
    const root = docFrom('<h2 role="heading" aria-level="2">Real heading</h2>');
    sanitizeCaptureDom(root);
    // A genuine <h2> keeps its semantics (harmless either way, but not stripped).
    expect(root.querySelector('h2')?.getAttribute('role')).toBe('heading');
  });

  it('is safe on a null / DOM-less input', () => {
    expect(() => sanitizeCaptureDom(null)).not.toThrow();
    expect(() => sanitizeCaptureDom({})).not.toThrow();
  });
});

import { describe, it, expect } from 'vitest';
import {
  assessCoverage, looksLikeChallengePage, approxPageText,
  MIN_COVERAGE, MIN_PAGE_CHARS,
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

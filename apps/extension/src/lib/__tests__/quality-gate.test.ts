import { describe, it, expect } from 'vitest';
import { checkContentQuality, extractDoi, looksLikeOcrGarbage } from '../quality-gate';

const filler = (n: number) =>
  Array.from({ length: n }, (_, i) => `Meaningful research sentence number ${i} about the subject matter.`).join(' ');

describe('checkContentQuality', () => {
  it('rejects empty and thin content', () => {
    expect(checkContentQuality('').reason).toBe('empty-content');
    expect(checkContentQuality('short').reason).toBe('empty-content');
    expect(checkContentQuality('word '.repeat(45) + 'x'.repeat(200)).reason).toBe('thin-content');
  });

  it('rejects Cloudflare anti-bot interstitials', () => {
    const page = 'Just a moment...\n\nChecking your browser before accessing dl.acm.org. ' +
      'This process is automatic. Your browser will redirect shortly. ' +
      'Please allow up to 5 seconds. DDoS protection by Cloudflare. ' + 'padding '.repeat(60);
    const r = checkContentQuality(page, 'Just a moment...');
    expect(r.pass).toBe(false);
    expect(r.reason).toBe('anti-bot');
  });

  it('rejects captcha pages', () => {
    const page = 'Please complete the reCAPTCHA to verify you are a human before continuing to the site. ' + 'pad '.repeat(80);
    expect(checkContentQuality(page).reason).toBe('anti-bot');
  });

  it('rejects paywalls and login walls', () => {
    const paywall = 'You’ve reached your article limit. Subscribe to read the full story and support journalism. ' + 'pad '.repeat(80);
    expect(checkContentQuality(paywall).reason).toBe('paywall');
    const login = 'Sign in to view this content. Access restricted to registered users of the portal. ' + 'pad '.repeat(80);
    expect(checkContentQuality(login).reason).toBe('login-wall');
  });

  it('rejects error/maintenance pages', () => {
    const p404 = 'Page not found. The page you are looking for does not exist or has been moved elsewhere. ' + 'pad '.repeat(80);
    expect(checkContentQuality(p404).reason).toBe('error-page');
    const maint = 'This service is temporarily unavailable due to scheduled maintenance. Check back soon. ' + 'pad '.repeat(80);
    expect(checkContentQuality(maint).reason).toBe('error-page');
  });

  it('passes real articles even when they mention captcha/404', () => {
    const article = filler(60) + ' The study also examined captcha solving and 404 error handling in web crawlers. ' + filler(60);
    expect(checkContentQuality(article, 'Web crawling research').pass).toBe(true);
  });

  it('passes normal content', () => {
    expect(checkContentQuality(filler(40), 'A real paper').pass).toBe(true);
  });
});

describe('checkContentQuality — each anti-bot phrase rejects alone', () => {
  // Redundant patterns must not mask a removed one: every phrase is tested
  // in isolation, surrounded only by neutral padding.
  const phrases = [
    'Just a moment',
    'checking your browser',
    'DDoS protection by Cloudflare',
    'verify you are a human',
    'One more step before you proceed',
    'complete the reCAPTCHA'
  ];
  for (const phrase of phrases) {
    it(`rejects on "${phrase}" alone`, () => {
      const page = `${phrase}. ` + 'neutral padding words here '.repeat(30);
      const r = checkContentQuality(page);
      expect(r.pass).toBe(false);
      expect(r.reason).toBe('anti-bot');
    });
  }
});

describe('extractDoi', () => {
  it('extracts DOI from ACM URLs', () => {
    expect(extractDoi('https://dl.acm.org/doi/10.1145/3583133.3596373')).toBe('10.1145/3583133.3596373');
    expect(extractDoi('https://dl.acm.org/doi/abs/10.1145/3583131.3590481')).toBe('10.1145/3583131.3590481');
  });
  it('extracts DOI from doi.org and trims trailing punctuation', () => {
    expect(extractDoi('https://doi.org/10.1000/xyz123.')).toBe('10.1000/xyz123');
  });
  it('returns null when absent', () => {
    expect(extractDoi('https://arxiv.org/abs/2401.12345')).toBeNull();
    expect(extractDoi('')).toBeNull();
  });
});

describe('looksLikeOcrGarbage', () => {
  it('flags symbol soup', () => {
    expect(looksLikeOcrGarbage('�?~ #@! ()[]{} --- ___ === +++ ||| ^^^ %%% $$$ &&& *** ;;; ::: ,,, ... ??? !!! ~~~ ``` "" \'\' <> // \\\\ '.repeat(3))).toBe(true);
  });
  it('passes real prose and short strings', () => {
    expect(looksLikeOcrGarbage('This is a perfectly ordinary paragraph of extracted PDF text that parsers produce. '.repeat(3))).toBe(false);
    expect(looksLikeOcrGarbage('###')).toBe(false);
  });
});

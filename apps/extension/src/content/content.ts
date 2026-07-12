import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

// ─────────────────────────────────────────────
// Enhanced Content Script — AI Research Assistant
// ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'SCRAPE_PAGE') {
    scrapePage().then(result => {
      sendResponse(result);
    }).catch(_err => {
      sendResponse({
        title: document.title || 'Untitled',
        url: window.location.href,
        favicon: getFavicon(),
        markdown: document.body?.innerText || '',
        wordCount: 0
      });
    });
    return true; // Keep the message channel open for the async response
  }
  return false;
});

function getFavicon(): string {
  const link = document.querySelector<HTMLLinkElement>(
    'link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]'
  );
  if (link?.href) return link.href;
  return `${window.location.origin}/favicon.ico`;
}

// ── YouTube transcript helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Attempt 1: fetch the timedtext caption track from the player response.
 * YouTube increasingly requires a PO token on this endpoint and answers
 * with an empty 200 — callers MUST treat an empty result as failure.
 */
async function fetchTimedtextTranscript(ytResponse: any): Promise<string> {
  const captionTracks = ytResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!captionTracks || captionTracks.length === 0) return '';

  // Prefer English, fallback to first available
  const track = captionTracks.find((t: any) => t.languageCode === 'en' || t.languageCode === 'en-US' || t.languageCode === 'en-GB') || captionTracks[0];

  const jsonUrl = track.baseUrl + (track.baseUrl.includes('fmt=json3') ? '' : '&fmt=json3');
  let transcriptRes = await fetch(jsonUrl, { credentials: 'include' });
  if (!transcriptRes.ok) {
    transcriptRes = await fetch(track.baseUrl, { credentials: 'include' });
  }
  const transcriptTextRaw = await transcriptRes.text();
  if (!transcriptTextRaw.trim()) return '';

  let transcriptText = '';

  try {
    // Try parsing as JSON3
    const data = JSON.parse(transcriptTextRaw);
    if (data.events) {
      for (const event of data.events) {
        if (event.segs && event.segs.length > 0) {
          const startMs = event.tStartMs || 0;
          const mins = Math.floor(startMs / 60000);
          const secs = Math.floor((startMs % 60000) / 1000).toString().padStart(2, '0');
          const textContent = event.segs.map((s: any) => s.utf8).join('').replace(/\n/g, ' ').trim();
          if (textContent && textContent !== '\n') {
            transcriptText += `[${mins}:${secs}] ${textContent}\n`;
          }
        }
      }
    }
  } catch (e) {
    // Fallback to XML parsing if it wasn't JSON
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(transcriptTextRaw, 'text/xml');
    const textNodes = xmlDoc.getElementsByTagName('text');

    for (let i = 0; i < textNodes.length; i++) {
      const start = parseFloat(textNodes[i].getAttribute('start') || '0');
      const mins = Math.floor(start / 60);
      const secs = Math.floor(start % 60).toString().padStart(2, '0');
      const textContent = textNodes[i].textContent?.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&') || '';
      transcriptText += `[${mins}:${secs}] ${textContent}\n`;
    }
  }

  return transcriptText;
}

function readTranscriptSegments(): string {
  const rows = document.querySelectorAll('ytd-transcript-segment-renderer');
  if (rows.length === 0) return '';
  let out = '';
  rows.forEach(row => {
    const ts = row.querySelector('.segment-timestamp')?.textContent?.trim() ?? '';
    const text = row.querySelector('.segment-text')?.textContent?.trim() ?? '';
    if (text) out += ts ? `[${ts}] ${text}\n` : `${text}\n`;
  });
  return out;
}

/**
 * Attempt 2: open YouTube's own transcript panel and read the segments
 * from the DOM. Runs inside the user's player session, so it is immune
 * to the PO-token requirement that breaks direct timedtext fetches.
 */
async function scrapeTranscriptPanel(): Promise<string> {
  // Panel may already be open
  let text = readTranscriptSegments();
  if (text) return text;

  // The "Show transcript" button lives in the description renderer; it is
  // clickable via JS even while the description is collapsed.
  const button =
    document.querySelector<HTMLElement>('ytd-video-description-transcript-section-renderer button') ||
    document.querySelector<HTMLElement>('button[aria-label="Show transcript"]');
  if (!button) return '';
  button.click();

  // Segments render async — poll up to 10s
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    text = readTranscriptSegments();
    if (text) break;
  }

  // Best-effort: close the panel we opened to leave the page as it was
  document.querySelector<HTMLElement>(
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"] #visibility-button button'
  )?.click();

  return text;
}

/**
 * Extract a meaningful title from markdown content by looking for the first heading.
 * Falls back to the provided fallback if no heading is found.
 */
function extractTitleFromMarkdown(markdown: string, fallback: string): string {
  // Try to find the first # heading in the markdown
  const headingMatch = markdown.match(/^#{1,2}\s+(.+)$/m);
  if (headingMatch) {
    const extracted = headingMatch[1].trim();
    // Only use it if it's reasonably long and not a generic section name
    if (extracted.length > 5 && !/^(introduction|overview|table of contents|summary|abstract)$/i.test(extracted)) {
      return extracted;
    }
  }

  // For Gemini/ChatGPT pages: try the first substantial line of content
  const lines = markdown.split('\n').filter(l => l.trim().length > 10);
  if (lines.length > 0) {
    const firstLine = lines[0].replace(/^\*\*|\*\*$/g, '').replace(/^[>#\-*]\s*/, '').trim();
    if (firstLine.length > 10 && firstLine.length < 120) {
      return firstLine;
    }
  }

  return fallback;
}

/**
 * Check if a title looks like a generic site/app name rather than content title.
 * Examples: "Google Gemini", "ChatGPT", "Claude", "Google Docs"
 */
function isGenericTitle(title: string): boolean {
  // Strip invisible unicode characters (e.g. U+200E Left-to-Right Mark from Gemini pages)
  const cleaned = title.trim().replace(/[\u200E\u200F\u200B\u200C\u200D\uFEFF\u00AD]/g, '').trim();
  const genericPatterns = [
    /^google\s*(gemini|docs|sheets|slides|drive|ai|bard)?$/i,
    /^‎?google\s*(gemini)?$/i,   // with LTR mark prefix
    /^chatgpt/i,
    /^claude/i,
    /^perplexity/i,
    /^notion$/i,
    /^untitled$/i,
    /^new\s+(tab|page|document)$/i,
    /^gemini$/i,
  ];
  return genericPatterns.some(p => p.test(cleaned));
}

async function scrapePage(): Promise<{
  title: string;
  url: string;
  favicon: string;
  markdown: string;
  wordCount: number;
  kind?: 'web' | 'youtube';
  author?: string;
}> {
  const url = window.location.href;
  const favicon = getFavicon();
  let title = document.title || 'Untitled';

  // ── YOUTUBE TRANSCRIPT EXTRACTION ──
  if (window.location.hostname.includes('youtube.com') && window.location.pathname === '/watch') {
    try {
      // Read the live player response via the background script (MAIN world)
      const ytResponse = await new Promise<any>((resolve) => {
        chrome.runtime.sendMessage({ action: 'GET_MAIN_WORLD_YT_RESPONSE' }, (response) => {
          resolve(response?.data || null);
        });
      });

      let transcriptText = '';
      if (ytResponse) {
        try {
          transcriptText = await fetchTimedtextTranscript(ytResponse);
        } catch (e) {
          console.warn('YouTube timedtext fetch failed:', e);
        }
      }

      // Timedtext is empty when YouTube demands a PO token — scrape the
      // transcript panel instead.
      if (!transcriptText.trim()) {
        transcriptText = await scrapeTranscriptPanel();
      }

      if (transcriptText.trim()) {
        title = ytResponse?.videoDetails?.title || title.replace(/ - YouTube$/, '');
        const author = ytResponse?.videoDetails?.author || '';
        const description = (ytResponse?.videoDetails?.shortDescription || '').trim();

        const markdown =
          `# ${title}\n\n` +
          (author ? `**Channel:** ${author}\n\n` : '') +
          (description ? `## Description\n\n${description}\n\n` : '') +
          `## Transcript\n\n${transcriptText}`;
        const wordCount = markdown.split(/\s+/).filter(w => w.length > 0).length;

        return { title, url, favicon, markdown, wordCount, kind: 'youtube', author };
      }
      console.warn('YouTube transcript: no captions found via timedtext or panel; falling back to page extraction');
    } catch (err) {
      console.error('Failed to extract YouTube transcript:', err);
      // Fallback to standard extraction
    }
  }

  // ── STANDARD PAGE EXTRACTION ──
  const documentClone = document.cloneNode(true) as Document;
  
  // Remove all scripts and styles from the clone to avoid CSP warnings when Readability/Turndown does innerHTML
  const elementsToRemove = documentClone.querySelectorAll('script, noscript, style, link[rel="stylesheet"]');
  elementsToRemove.forEach(el => el.parentNode?.removeChild(el));

  const reader = new Readability(documentClone, {
    keepClasses: true,
  });
  
  const article = reader.parse();

  const htmlContent: string = (article && article.content) ? article.content : document.body.innerHTML;
  title = (article && article.title) ? article.title : title;

  const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced'
  });

  let markdown = turndownService.turndown(htmlContent);

  // Clean up excessive newlines
  markdown = markdown.replace(/\n{4,}/g, '\n\n\n').trim();

  // Documentation hubs / TOC pages are mostly links — and Readability often
  // strips nav-style link lists, leaving bare titles with no hrefs. Chat's
  // link-expansion step needs real URLs to follow, so when the page's DOM is
  // link-rich but the extracted markdown is link-poor, append the page's
  // links as a markdown list (ephemeral page-context use, not saved content).
  const mdLinkCount = (markdown.match(/\]\(https?:\/\//g) || []).length;
  if (mdLinkCount < 15) {
    const seen = new Set<string>();
    const items: string[] = [];
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 4 || text.length > 120) continue;
      let abs: string;
      try { abs = new URL(a.getAttribute('href')!, window.location.href).href; } catch { continue; }
      if (!/^https?:\/\//.test(abs) || abs.split('#')[0] === url.split('#')[0]) continue;
      if (seen.has(abs)) continue;
      seen.add(abs);
      items.push(`- [${text.replace(/[\[\]]/g, '')}](${abs})`);
      if (items.length >= 150) break;
    }
    if (items.length >= 15) {
      markdown += `\n\n## Links on this page\n\n${items.join('\n')}`;
    }
  }

  // Comments + build info: Readability keeps only the main article, dropping
  // comment threads, asides, and footers — so a question answerable from the
  // discussion or a colophon ("built with X") comes up empty. Recover them
  // from the live DOM. (Cross-origin comment iframes like Disqus can't be read
  // and are silently skipped.)
  const extras: string[] = [];

  const generator = document.querySelector('meta[name="generator"]')?.getAttribute('content')?.trim();
  if (generator) extras.push(`**Site generator:** ${generator}`);

  // Top-level comment/discussion containers only — skip nested items so a
  // container and its children don't both dump the same text.
  const commentSel = '#comments, .comments, #disqus_thread, [id*="comment-list"], [class*="comment-list"], [class*="responses"], [class*="discussion"]';
  const containers: HTMLElement[] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(commentSel))) {
    if (containers.some(c => c.contains(el))) continue;
    containers.push(el);
  }
  const commentText = containers
    .map(el => (el.innerText || '').replace(/\n{3,}/g, '\n\n').trim())
    .filter(t => t.length > 40)
    .join('\n\n---\n\n')
    .slice(0, 3500);
  if (commentText) extras.push(`### Comments / discussion\n\n${commentText}`);

  if (extras.length > 0) {
    markdown += `\n\n## Page extras (comments & build info)\n\n${extras.join('\n\n')}`;
  }

  // If the title looks like a generic site name (e.g. "Google Gemini"),
  // try to extract a real content title from the first markdown heading.
  if (isGenericTitle(title)) {
    title = extractTitleFromMarkdown(markdown, title);
  }

  const wordCount = markdown.split(/\s+/).filter(w => w.length > 0).length;

  return { title, url, favicon, markdown, wordCount, kind: 'web' as const, author: (article as any)?.byline || undefined };
}

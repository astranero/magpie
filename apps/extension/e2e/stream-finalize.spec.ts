import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../dist');

// A streamed answer whose text is UNCHANGED at DONE (last delta already
// delivered the full reply; no citations/footer follow) — exactly the shape of
// a "general knowledge" answer. This regressed once: MessageBody's memo
// comparator ignored `streaming`, so the true→false finalize (with identical
// text) was treated as "no change" and the component never re-rendered off the
// plaintext fast-path. The blinking caret and raw *markdown* stuck forever.
function startMockLLM(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url?.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
      const tokens = ['*No ', 'matching ', 'sources.* ', 'Hello ', 'there ', 'friend.'];
      let i = 0;
      const iv = setInterval(() => {
        if (i < tokens.length) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: tokens[i++] } }] })}\n\n`);
        } else {
          res.write('data: [DONE]\n\n');
          clearInterval(iv);
          res.end();
        }
      }, 12);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as any).port}` });
    });
  });
}

async function configureMockProvider(page: Page, url: string) {
  const deadline = Date.now() + 8000;
  let stableSince = 0;
  while (Date.now() < deadline) {
    const current = await page.evaluate(async () =>
      (globalThis as any).chrome.storage.local.get(['customUrl']).then((s: any) => s.customUrl));
    if (current === url) {
      if (stableSince === 0) stableSince = Date.now();
      if (Date.now() - stableSince >= 800) return;
    } else {
      stableSince = 0;
      // chatWebFallback:false — this spec tests streaming/render, not the web
      // fallback; leaving it on makes an empty-workspace turn run a real ~10s
      // web search first and blow the tight timeouts.
      await page.evaluate((u) => (globalThis as any).chrome.storage.local.set({ customUrl: u, customModel: 'mock-model', customKey: '', chatWebFallback: false }), url);
    }
    await page.waitForTimeout(150);
  }
  throw new Error('mock provider config never stabilized');
}

let context: BrowserContext;
let mock: { server: Server; url: string };

test.beforeAll(async () => {
  mock = await startMockLLM();
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`]
  });
});

test.afterAll(async () => {
  await context?.close();
  await new Promise<void>(r => mock.server.close(() => r()));
});

test('streamed answers finalize their render — caret clears, markdown parses (both turns)', async () => {
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/sidepanel.html`);
  await page.getByRole('button', { name: /chat/i }).click();
  await configureMockProvider(page, mock.url);

  const ask = async (q: string) => {
    const input = page.getByPlaceholder(/Ask a question/i);
    await input.fill(q);
    await input.press('Enter');
    await page.getByText(/there friend/i).last().waitFor({ timeout: 12000 });
    // Poll for the finalized state instead of a fixed sleep — DONE→finalize→
    // re-render can land a few hundred ms after the last token under load, and
    // a fixed wait races it. The message MUST settle to markdown-with-no-caret;
    // if it never does (genuinely stuck), waitForFunction throws → test fails.
    // Interval polling (NOT the default rAF polling, which Playwright throttles
    // when the page is backgrounded / under load — the source of earlier flake).
    await page.waitForFunction(() =>
      !document.querySelector('.animate-pulse') &&
      !!document.querySelector('em') &&
      !(document.body.innerText || '').includes('*No matching'),
      undefined,
      { timeout: 15000, polling: 100 }
    );
    return page.evaluate(() => ({
      caret: !!document.querySelector('.animate-pulse'),
      rawStar: (document.body.innerText || '').includes('*No matching'),
      hasEm: !!document.querySelector('em'),
    }));
  };

  // Second turn is the important one: same-shaped answer, text identical at DONE.
  expect(await ask('hi how is the day')).toEqual({ caret: false, rawStar: false, hasEm: true });
  expect(await ask('what about the weather')).toEqual({ caret: false, rawStar: false, hasEm: true });
  await page.close();
});

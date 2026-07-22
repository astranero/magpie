import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../dist');

// Minimal OpenAI-compatible SSE endpoint so the chat streaming path can be
// exercised end-to-end without a real LLM. Guards chatWithCustomStream, the
// port protocol, and ChatView delta rendering — the busiest shared code the
// service-worker split touches.
function startMockLLM(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url?.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
      const tokens = ['Photosynthesis ', 'converts ', 'light ', 'into ', 'chemical ', 'energy.'];
      let i = 0;
      const iv = setInterval(() => {
        if (i < tokens.length) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: tokens[i++] } }] })}\n\n`);
        } else {
          res.write('data: [DONE]\n\n');
          clearInterval(iv);
          res.end();
        }
      }, 20);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

let context: BrowserContext;
let extensionId: string;
let mock: { server: Server; url: string };

test.beforeAll(async () => {
  mock = await startMockLLM();
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`]
  });
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  extensionId = new URL(sw.url()).host;
});

/**
 * Point the extension at the mock LLM *after* the panel has settled: the app
 * persists default provider settings during first-load init, which can race
 * (and overwrite) config written in beforeAll. Set late, then verify.
 */
async function configureMockProvider(page: import('@playwright/test').Page) {
  // The app's settings auto-save can overwrite injected config at
  // unpredictable points during first-load init. Enforce until the value
  // survives untouched for 800 ms.
  const deadline = Date.now() + 8000;
  let stableSince = 0;
  while (Date.now() < deadline) {
    const current = await page.evaluate(async () => {
      const s = await (globalThis as any).chrome.storage.local.get(['customUrl']);
      return s.customUrl as string | undefined;
    });
    if (current === mock.url) {
      if (stableSince === 0) stableSince = Date.now();
      if (Date.now() - stableSince >= 800) return;
    } else {
      stableSince = 0;
      await page.evaluate(async (base) => {
        await (globalThis as any).chrome.storage.local.set({ customUrl: base, customModel: 'mock-model', customKey: '', chatWebFallback: false });
      }, mock.url);
    }
    await page.waitForTimeout(200);
  }
  throw new Error('mock provider config never stabilized');
}

test.afterAll(async () => {
  await context?.close();
  await new Promise<void>(r => mock.server.close(() => r()));
});

test('chat send streams a reply into the transcript', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByRole('button', { name: /chat/i }).click();
  await configureMockProvider(page);

  const input = page.getByPlaceholder(/Ask a question/i);
  await input.fill('What does photosynthesis do?');
  await input.press('Enter');

  await expect(page.getByText('What does photosynthesis do?')).toBeVisible({ timeout: 8000 });
  // Scope to the transcript paragraph: the aria-live status region announces the
  // same answer text, which makes a bare getByText a strict-mode violation.
  await expect(
    page.getByRole('paragraph').filter({ hasText: /converts light into chemical energy/i }).first()
  ).toBeVisible({ timeout: 15000 });
  await page.close();
});

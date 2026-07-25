import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../dist');

// ─────────────────────────────────────────────
// Error recovery — a failed turn offers a way out
// ─────────────────────────────────────────────
// A provider that rejects the key with 401 must NOT drop a raw
// "Provider error 401" line into the chat. diagnoseError classifies it as an
// auth problem and the view offers "Fix the key" → Settings. Its own spec
// file, own profile, because it points the mock at a failing endpoint.

/** Mock endpoint that answers /models but 401s every completion. */
function startFailingLLM(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url?.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
        return;
      }
      res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided.' } }));
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
  mock = await startFailingLLM();
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  extensionId = new URL(sw.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  await new Promise<void>(r => mock.server.close(() => r()));
});

async function configure(page: Page) {
  const deadline = Date.now() + 8000;
  let stableSince = 0;
  while (Date.now() < deadline) {
    const current = await page.evaluate(async () =>
      (await (globalThis as any).chrome.storage.local.get(['customUrl'])).customUrl as string | undefined);
    if (current === mock.url) {
      if (stableSince === 0) stableSince = Date.now();
      if (Date.now() - stableSince >= 800) return;
    } else {
      stableSince = 0;
      await page.evaluate(async (base) => {
        await (globalThis as any).chrome.storage.local.set({
          customUrl: base, customModel: 'mock-model', customKey: 'sk-bad', chatWebFallback: false,
        });
      }, mock.url);
    }
    await page.waitForTimeout(200);
  }
  throw new Error('mock provider config never stabilized');
}

test('a rejected key surfaces a recovery block with a Settings action, not a raw error', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByRole('button', { name: /chat/i }).click();
  await configure(page);

  const input = page.getByPlaceholder(/Ask a question/i);
  await input.fill('Will this fail?');
  await input.press('Enter');

  // The diagnosed title, not the raw "401" string.
  await expect(page.getByText(/rejected your API key/i)).toBeVisible({ timeout: 15000 });
  // And the actionable button.
  const fix = page.getByRole('button', { name: /fix the key/i });
  await expect(fix).toBeVisible();

  // Clicking it lands on the settings view.
  await fix.click();
  await expect(page.getByText(/AI Provider Configuration/i)).toBeVisible({ timeout: 8000 });
  await page.close();
});

import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../dist');

// ─────────────────────────────────────────────
// Vision routing — the image actually reaches the model, on the vision model
// ─────────────────────────────────────────────
// The UI plumbing (chip, clear-on-send) is covered in chat-controls. This is
// the claim that matters: an attached image is forwarded to the provider as an
// image_url content part, addressed to the configured vision model — not
// dropped, not sent to the text model. The mock records what it received.

interface Captured { model?: string; hasImage?: boolean; textPart?: string }

function startRecordingLLM(): Promise<{ server: Server; url: string; last: () => Captured }> {
  let last: Captured = {};
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url?.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ data: [{ id: 'text-model' }, { id: 'vision-model' }] }));
        return;
      }
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const userMsg = (parsed.messages || []).filter((m: any) => m.role === 'user').pop();
          const parts = Array.isArray(userMsg?.content) ? userMsg.content : [];
          last = {
            model: parsed.model,
            hasImage: parts.some((p: any) => p?.type === 'image_url' && typeof p.image_url?.url === 'string'),
            textPart: parts.find((p: any) => p?.type === 'text')?.text,
          };
        } catch { /* leave last as-is */ }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'I see a red pixel.' } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}`, last: () => last });
    });
  });
}

let context: BrowserContext;
let extensionId: string;
let mock: { server: Server; url: string; last: () => Captured };

test.beforeAll(async () => {
  mock = await startRecordingLLM();
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
    const cur = await page.evaluate(async () =>
      (await (globalThis as any).chrome.storage.local.get(['customUrl', 'visionModel'])));
    if (cur.customUrl === mock.url && cur.visionModel === 'vision-model') {
      if (stableSince === 0) stableSince = Date.now();
      if (Date.now() - stableSince >= 800) return;
    } else {
      stableSince = 0;
      await page.evaluate(async (base) => {
        await (globalThis as any).chrome.storage.local.set({
          customUrl: base, customModel: 'text-model', visionModel: 'vision-model',
          customKey: '', chatWebFallback: false,
        });
      }, mock.url);
    }
    await page.waitForTimeout(200);
  }
  throw new Error('config never stabilized');
}

test('an attached image is forwarded as image_url, to the vision model', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByRole('button', { name: /chat/i }).click();
  await configure(page);

  const px = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await page.getByRole('button', { name: /add files/i }).click();
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: 'shot.png', mimeType: 'image/png', buffer: Buffer.from(px, 'base64'),
  });
  await expect(page.getByText('Image attached')).toBeVisible({ timeout: 8000 });

  const input = page.getByPlaceholder(/Ask a question/i);
  await input.fill('What colour is this?');
  await input.press('Enter');

  await expect(page.getByText('I see a red pixel.')).toBeVisible({ timeout: 15000 });

  const cap = mock.last();
  expect(cap.hasImage, 'the image_url part never reached the provider').toBe(true);
  expect(cap.model, 'the turn did not use the configured vision model').toBe('vision-model');
  expect(cap.textPart).toContain('What colour is this?');
  await page.close();
});

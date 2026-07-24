import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../dist');

// ─────────────────────────────────────────────
// Regenerate & edit-and-re-run
// ─────────────────────────────────────────────
// Both work by TRUNCATING the stored transcript and replaying the turn, so the
// failures that matter are: appending a second answer instead of replacing the
// first, and discarding turns in React state without discarding them in
// storage (they would reappear on the next reload).
//
// Its own spec file, not an addition to chat.spec.ts, because Playwright gives
// each file its own persistent context. These assertions count messages in a
// chat; sharing a profile with another spec means counting whatever that spec
// left behind, and "the last answer" stops meaning anything.

/** Mock OpenAI-compatible SSE endpoint. Serialises every completion. */
function startMockLLM(): Promise<{ server: Server; url: string }> {
  let completions = 0;
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url?.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
      // The serial is what makes "replaced" distinguishable from "did nothing":
      // a regenerated answer is otherwise textually identical to the one it
      // replaced, so no assertion could tell them apart.
      const tokens = ['Photosynthesis ', 'converts ', 'light ', 'into ', 'chemical ', 'energy.', ` [gen ${++completions}]`];
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

test.afterAll(async () => {
  await context?.close();
  await new Promise<void>(r => mock.server.close(() => r()));
});

/** First-load init can overwrite injected config; enforce until it sticks. */
async function configureMockProvider(page: Page) {
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
        await (globalThis as any).chrome.storage.local.set({
          customUrl: base, customModel: 'mock-model', customKey: '', chatWebFallback: false,
        });
      }, mock.url);
    }
    await page.waitForTimeout(200);
  }
  throw new Error('mock provider config never stabilized');
}

/** Open the panel on a settled chat pointed at the mock. */
async function openChat(page: Page) {
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByRole('button', { name: /chat/i }).click();
  await configureMockProvider(page);
}

const answersIn = (page: Page) =>
  page.getByRole('paragraph').filter({ hasText: /converts light into chemical energy/i });

/**
 * Send, and wait until the question is on screen AND its answer has landed.
 *
 * The answer count is checked relative to the count before sending: tests in
 * this file share the profile's default chat, so absolute counts would depend
 * on what the previous test left behind.
 */
async function ask(page: Page, text: string) {
  const before = await answersIn(page).count();
  const input = page.getByPlaceholder(/Ask a question/i);
  await input.fill(text);
  await input.press('Enter');
  await expect(page.getByText(text, { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(answersIn(page)).toHaveCount(before + 1, { timeout: 15000 });
}

test('regenerate replaces the answer instead of appending a second one', async () => {
  const page = await context.newPage();
  await openChat(page);

  await ask(page, 'First question?');
  const answers = answersIn(page);
  const total = await answers.count();
  const before = (await answers.last().innerText()).match(/\[gen \d+\]/)?.[0];
  expect(before, 'mock did not serialise its completions').toBeTruthy();

  await answers.last().hover();
  await page.getByRole('button', { name: /regenerate/i }).last().click();

  // The answer COUNT is unchanged — replaced, not appended…
  await expect(answers).toHaveCount(total, { timeout: 15000 });
  await expect(page.getByText('First question?', { exact: true })).toHaveCount(1);
  // …and it is a genuinely new completion, so the click was not inert.
  await expect(page.getByText(before!, { exact: false })).toHaveCount(0, { timeout: 15000 });
  await page.close();
});

test('editing a message re-runs it and drops the turns that followed — in stored history too', async () => {
  const page = await context.newPage();
  await openChat(page);

  await ask(page, 'Original question?');
  await ask(page, 'Second question, to be discarded?');

  await page.getByText('Original question?', { exact: true }).hover();
  await page.getByRole('button', { name: /^edit$/i }).first().click();
  await page.getByRole('textbox', { name: /edit message/i }).fill('Edited question?');
  // Two-step confirm: arm, then commit. Discarding is permanent.
  await page.getByRole('button', { name: /save & re-run/i }).click();
  await page.getByRole('button', { name: /discard \d+ and re-run/i }).click();

  await expect(page.getByText('Edited question?', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('Second question, to be discarded?', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Original question?', { exact: true })).toHaveCount(0);

  // The discard must have reached STORAGE, not just React state — reloading
  // reads the saved history back, which is where a state-only truncation would
  // show up as the discarded turns returning.
  await page.reload();
  await page.getByRole('button', { name: /chat/i }).click();
  await expect(page.getByText('Edited question?', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('Second question, to be discarded?', { exact: true })).toHaveCount(0);
  await page.close();
});

test('Enter continues a list instead of sending; empty item ends it', async () => {
  const page = await context.newPage();
  await openChat(page);

  const input = page.getByPlaceholder(/Ask a question/i);
  const answersBefore = await answersIn(page).count();

  await input.click();
  await input.type('1. one');
  await input.press('Enter');                       // in a list → continue, not send
  await expect(input).toHaveValue('1. one\n2. ');
  await expect(answersIn(page)).toHaveCount(answersBefore);   // nothing was sent

  await input.type('two');
  await input.press('Enter');
  await expect(input).toHaveValue('1. one\n2. two\n3. ');

  // Enter on the empty "3. " ends the list…
  await input.press('Enter');
  await expect(input).toHaveValue('1. one\n2. two\n');
  await expect(answersIn(page)).toHaveCount(answersBefore);   // still not sent

  // …and the next Enter (not in a list) sends.
  await input.press('Enter');
  await expect(answersIn(page)).toHaveCount(answersBefore + 1, { timeout: 15000 });
  await page.close();
});

test('an attached image shows a chip, rides the send, then clears', async () => {
  const page = await context.newPage();
  await openChat(page);

  const px = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await page.getByRole('button', { name: /add files/i }).click();
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: 'shot.png', mimeType: 'image/png', buffer: Buffer.from(px, 'base64'),
  });
  // Chip appears.
  await expect(page.getByText('Image attached')).toBeVisible({ timeout: 8000 });

  const answersBefore = await answersIn(page).count();
  const input = page.getByPlaceholder(/Ask a question/i);
  await input.fill('What is in this image?');
  await input.press('Enter');

  // The turn goes through (mock answers), and the chip is gone — the image
  // rides one send only.
  await expect(answersIn(page)).toHaveCount(answersBefore + 1, { timeout: 15000 });
  await expect(page.getByText('Image attached')).toHaveCount(0);
  // The user bubble shows the attachment it was sent with.
  await expect(page.getByRole('img', { name: /attached image/i }).first()).toBeVisible();
  await page.close();
});

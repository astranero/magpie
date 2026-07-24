import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../dist');

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`]
  });
  // Extension id comes from the registered MV3 service worker
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  extensionId = new URL(sw.url()).host;
});

test.afterAll(async () => { await context?.close(); });

// These guard the render + wiring surface that unit tests can't reach —
// the class of breakage a big refactor (splitting App.tsx / worker) causes.
test('sidepanel mounts and shows the workspace header', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  // Mount signal: the workspace selector renders the auto-created default
  // workspace (the header no longer carries a "Workspace" label).
  await expect(page.getByText('Default Session').first()).toBeVisible({ timeout: 10000 });
  await page.close();
});

test('chat empty state surfaces starter commands', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByRole('button', { name: /chat/i }).click();
  await expect(page.getByText('START HERE')).toBeVisible({ timeout: 8000 });
  await expect(page.getByText('/research')).toBeVisible();
  await page.close();
});

test('bottom nav switches between Lore, Chat, Config', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByRole('button', { name: /config/i }).click();
  await expect(page.getByText(/AI Provider Configuration/i)).toBeVisible({ timeout: 8000 });
  await page.getByRole('button', { name: /chat/i }).click();
  await expect(page.getByPlaceholder(/Ask a question/i)).toBeVisible();
  await page.close();
});

test('command palette lists slash commands including /recall', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByRole('button', { name: /chat/i }).click();
  const input = page.getByPlaceholder(/Ask a question/i);
  await input.fill('/re');
  // Palette (role=listbox) should surface /recall and /research
  await expect(page.getByRole('listbox', { name: /command suggestions/i }).getByText('/RECALL')).toBeVisible({ timeout: 5000 });
  await page.close();
});

test('ported commands appear in the palette', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByRole('button', { name: /chat/i }).click();
  const input = page.getByPlaceholder(/Ask a question/i);

  await input.fill('/gr');
  await expect(page.getByText('/grill').first()).toBeVisible({ timeout: 8000 });

  await input.fill('/te');
  await expect(page.getByText('/teach').first()).toBeVisible({ timeout: 8000 });
  await page.close();
});

test('provider sections coexist: BYOK model picker searches without touching Copilot config', async () => {
  // Close any pre-existing or restored pages in the persistent context to completely prevent background tab leaks from overwriting our seeded storage.
  const pages = context.pages();
  for (const p of pages) {
    await p.close().catch(() => {});
  }

  // Wait a short moment to let any unmounting panels from closed tabs completely finish their async storage writes.
  await new Promise(resolve => setTimeout(resolve, 1500));

  // Seed BOTH catalogs via the service worker context to guarantee no unmount/save React race conditions can overwrite the seed.
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  // Snapshot whatever the shared persistent context already had, so this test
  // can restore it — clear() wiped storage for every OTHER test sharing this
  // context/worker, which made the palette test's slash-command state (and
  // anything after this one in file order) flake depending on run order.
  const priorStorage = await sw.evaluate(() => chrome.storage.local.get(null));
  await sw.evaluate(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      byokModels: ['google/gemini-2.5-pro', 'google/gemini-2.5-flash', 'meta-llama/llama-3.3-70b-test-specific-model'],
      byokUrl: 'http://127.0.0.1:9999/api/v1', byokKey: 'sk-or-test',
      copilotModels: ['gpt-4o', 'claude-sonnet-4'],
      customModels: ['google/gemini-2.5-pro'],
      customUrl: 'http://127.0.0.1:9999/api/v1', customKey: 'sk-or-test', customModel: 'google/gemini-2.5-pro',
      activeProvider: 'byok',
    });
  });

  const page = await context.newPage();
  // Now load the actual sidepanel with the pre-seeded storage.
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByRole('button', { name: /config/i }).click();

  // Both sections render side by side.
  await expect(page.getByText(/GitHub Copilot/i).first()).toBeVisible({ timeout: 8000 });
  await expect(page.getByText(/AI Provider Configuration/i)).toBeVisible();

  // The BYOK picker opens with a search box and filters ITS catalog.
  await page.getByRole('button', { name: 'AI provider model' }).click();
  const search = page.getByRole('textbox', { name: /search models/i });
  await expect(search).toBeVisible({ timeout: 5000 });
  await search.fill('llama');
  await expect(page.getByRole('option', { name: /llama-3\.3-70b-test-specific-model/i })).toBeVisible();
  // Copilot's models are NOT in the BYOK list — distinct views.
  await expect(page.getByRole('option', { name: /gpt-4o/i })).toHaveCount(0);

  // Select it: BYOK becomes active with that model; Copilot catalog untouched.
  await page.getByRole('option', { name: /llama-3\.3-70b-test-specific-model/i }).click();
  await expect.poll(async () => {
    return await page.evaluate(() => (globalThis as any).chrome.storage.local.get(
      ['customModel', 'activeProvider', 'copilotModels']
    ));
  }).toEqual({
    customModel: 'meta-llama/llama-3.3-70b-test-specific-model',
    activeProvider: 'byok',
    copilotModels: ['gpt-4o', 'claude-sonnet-4']
  });
  await page.close();

  // Restore — tests after this one in file order share this context/worker
  // and must not see this test's seeded (or now-cleared) storage.
  await sw.evaluate(async (prior) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set(prior);
  }, priorStorage);
});

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

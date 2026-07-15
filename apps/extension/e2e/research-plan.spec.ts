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
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  extensionId = new URL(sw.url()).host;
});

test.afterAll(async () => { await context?.close(); });

// /research posts an interactive plan card INTO the chat (no modal). Without
// an LLM key the preview falls back to the raw topic — the card must still
// reach 'draft' and stay actionable. Guards the negotiation surface.
test('research command renders an in-chat plan card that can be cancelled', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByRole('button', { name: /chat/i }).click();

  const input = page.locator('#chat-input');
  await input.fill('/research solid state batteries');
  await input.press('Enter');

  // Command echoes as a user message + the plan card appears
  await expect(page.getByText('/research solid state batteries')).toBeVisible({ timeout: 8000 });
  await expect(page.getByText(/Research\s*·\s*Plan/i)).toBeVisible({ timeout: 15000 });

  // Preview (no LLM key in CI) falls back to draft with the raw topic
  const startBtn = page.getByRole('button', { name: /start research/i });
  await expect(startBtn).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('solid state batteries').last()).toBeVisible();

  // Input is NOT disabled while the plan is pending — chat stays usable
  await expect(input).toBeEnabled();

  // Cancel flips the card to its terminal state and removes the buttons
  await page.getByRole('button', { name: /^cancel$/i }).click();
  await expect(page.getByText('Cancelled')).toBeVisible({ timeout: 5000 });
  await expect(startBtn).not.toBeVisible();

  await page.close();
});

// /academic shares the plan-card negotiation surface but must announce its own
// mode — papers-only — in the card label and button. Guards the third mode's
// UI wiring (command routing → plan.sourceMode → PlanCard).
test('academic command renders an Academic Research plan card', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByRole('button', { name: /chat/i }).click();

  const input = page.locator('#chat-input');
  await input.fill('/academic transformer interpretability');
  await input.press('Enter');

  await expect(page.getByText('/academic transformer interpretability')).toBeVisible({ timeout: 8000 });
  await expect(page.getByText(/Academic Research\s*·\s*Plan/i)).toBeVisible({ timeout: 15000 });

  const startBtn = page.getByRole('button', { name: /start academic research/i });
  await expect(startBtn).toBeVisible({ timeout: 15000 });

  await page.getByRole('button', { name: /^cancel$/i }).click();
  await expect(page.getByText('Cancelled')).toBeVisible({ timeout: 5000 });
  await expect(startBtn).not.toBeVisible();

  await page.close();
});

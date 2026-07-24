import { test, expect, type BrowserContext } from '@playwright/test';
import {
  loadApiKey, launchExtension, openPanel, configureProvider, sendChat,
  OPENROUTER_URL, TEXT_MODEL, VISION_MODEL,
} from './live-helpers';

// ─────────────────────────────────────────────
// Live DEEP RESEARCH end-to-end — the full pipeline, real model + real web
// ─────────────────────────────────────────────
// Runs an actual research run: plan → gather (web scrape + embed + rerank) →
// brief → synthesis → report saved to chat + library. This exercises the whole
// stack the crash logs came from (offscreen workers, vector store, queue), so
// it is the true integration test — but it takes minutes, costs tokens, and
// depends on live search. Opt-in on top of the key:
//   RUN_LIVE_RESEARCH=1 npx playwright test e2e/live-research.spec.ts
// 'standard' depth keeps it to 2 rounds / 40-source cap.

const KEY = loadApiKey();
test.skip(!KEY, 'No OpenRouter key (env OPENROUTER_API_KEY or e2e/.openrouter-key)');
test.skip(process.env.RUN_LIVE_RESEARCH !== '1', 'Set RUN_LIVE_RESEARCH=1 to run the full live research e2e');

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  ({ context, extensionId } = await launchExtension());
});
test.afterAll(async () => { await context?.close(); });

test('full /research run: process indication at every stage, report lands in chat', async () => {
  test.setTimeout(15 * 60 * 1000); // real web + real model — minutes, not seconds

  const page = await openPanel(context, extensionId);
  await page.getByRole('button', { name: /chat/i }).click();
  await configureProvider(page, { url: OPENROUTER_URL, key: KEY!, model: TEXT_MODEL, visionModel: VISION_MODEL });
  // Cheapest tier: 2 rounds, 40-source cap (research-limits.ts 'standard').
  await page.evaluate(() => (globalThis as any).chrome.storage.local.set({ researchDepth: 'standard' }));

  await sendChat(page, '/research what is the capital of Finland and its population');

  // The plan card previews first — start the run.
  const start = page.getByRole('button', { name: /start/i }).first();
  await start.waitFor({ timeout: 90000 });
  await start.click();

  // PROCESS INDICATION: the field log must show live pipeline stages.
  await expect(page.getByText(/Searching:/i).first()).toBeVisible({ timeout: 3 * 60 * 1000 });
  await expect(page.getByText(/Reading|Captured/i).first()).toBeVisible({ timeout: 5 * 60 * 1000 });

  // Completion: success toast/log line, then the report lands as a message.
  await expect(
    page.getByText(/Deep research complete|research complete/i).first()
  ).toBeVisible({ timeout: 12 * 60 * 1000 });
  await page.waitForFunction(() => {
    const text = document.body.innerText || '';
    return /Helsinki/i.test(text);   // the one fact the topic guarantees
  }, undefined, { timeout: 60000, polling: 500 });

  await page.close();
});

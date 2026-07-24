// ─────────────────────────────────────────────
// Live-model E2E helpers — OpenRouter-backed tests
// ─────────────────────────────────────────────
// The live suites exercise every model-dependent surface (chat, commands,
// research planning, vision import) against a REAL provider. They need a key:
//   1. env  OPENROUTER_API_KEY=sk-or-...      (CI / one-off runs)
//   2. file e2e/.openrouter-key (gitignored)  (local dev)
// No key → suites skip cleanly (test.skip), so `npm run test:e2e` stays green
// on machines without credentials.

import { chromium, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const EXT_PATH = path.resolve(__dirname, '../dist');

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1';
export const TEXT_MODEL = 'google/gemini-3.1-flash-lite';
export const VISION_MODEL = 'google/gemini-3.1-flash-image-preview';

export function loadApiKey(): string | null {
  if (process.env.OPENROUTER_API_KEY?.startsWith('sk-')) return process.env.OPENROUTER_API_KEY;
  try {
    const k = fs.readFileSync(path.join(__dirname, '.openrouter-key'), 'utf8').trim();
    return k.startsWith('sk-') ? k : null;
  } catch { return null; }
}

export async function launchExtension(): Promise<{ context: BrowserContext; extensionId: string }> {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  return { context, extensionId: new URL(sw.url()).host };
}

/** Open the sidepanel page and wait for the app to mount. */
export async function openPanel(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByText('Default Session').first().waitFor({ timeout: 15000 });
  return page;
}

/**
 * Point the extension at a provider and wait until the settings stick.
 * (App.tsx loads settings on mount and can overwrite a too-early write —
 * same stabilization loop the mock-provider e2e uses.)
 */
export async function configureProvider(page: Page, cfg: {
  url: string; key: string; model: string; visionModel?: string; webFallback?: boolean;
}): Promise<void> {
  const deadline = Date.now() + 10000;
  let stableSince = 0;
  while (Date.now() < deadline) {
    const current = await page.evaluate(async () =>
      (globalThis as any).chrome.storage.local.get(['customUrl', 'customKey']).then((s: any) => `${s.customUrl}|${s.customKey}`));
    if (current === `${cfg.url}|${cfg.key}`) {
      if (stableSince === 0) stableSince = Date.now();
      if (Date.now() - stableSince >= 800) return;
    } else {
      stableSince = 0;
      await page.evaluate((c) => (globalThis as any).chrome.storage.local.set({
        customUrl: c.url, customKey: c.key, customModel: c.model,
        visionModel: c.visionModel ?? '', chatWebFallback: c.webFallback ?? false,
      }), cfg);
    }
    await page.waitForTimeout(150);
  }
  throw new Error('provider config never stabilized');
}

/** The active project id (the auto-created Default Session). */
export async function activeProjectId(page: Page): Promise<string> {
  return await page.evaluate(async () => {
    const res: any = await (globalThis as any).chrome.runtime.sendMessage({ action: 'LIST_PROJECTS' });
    const projects = res?.projects ?? [];
    return projects[0]?.id ?? '';
  });
}

/** Send a chat message through the real input. */
export async function sendChat(page: Page, text: string): Promise<void> {
  const input = page.getByPlaceholder(/Ask a question/i);
  await input.fill(text);
  await input.press('Enter');
}

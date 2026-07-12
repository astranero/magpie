import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../dist');

let context: BrowserContext;
let extensionId: string;

// Send a message to the extension's service worker from a page context and
// await the response. Used to seed a document without a browser tab or the
// File System Access picker (handleImportLocalMd takes raw content).
async function sendMessage(page: Page, action: string, data: Record<string, unknown>) {
  return page.evaluate(([a, d]) => {
    return new Promise((resolve) => {
      (globalThis as any).chrome.runtime.sendMessage({ action: a, ...(d as object) }, (res: unknown) => resolve(res));
    });
  }, [action, data] as const);
}

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

// The full storage → chunk → index → search → open → highlight surface —
// the coordinate-space class of bug that has broken twice and is invisible to
// unit tests. Runs BM25-lexical when the offscreen embedding model is
// unavailable (offline CI), which is deterministic and sufficient here.
test('imported document is searchable and opens at the matched passage', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  // Mount signal: the workspace selector shows the auto-created default
  await expect(page.getByText('Default Session').first()).toBeVisible({ timeout: 10000 });

  // Seed a project + a document with a distinctive phrase
  const proj: any = await sendMessage(page, 'CREATE_PROJECT', { title: 'E2E Project' });
  const projectId = proj?.project?.id || proj?.id;
  expect(projectId).toBeTruthy();

  const marker = 'quokkas are exceptionally photogenic marsupials';
  await sendMessage(page, 'IMPORT_LOCAL_MD', {
    projectId,
    files: [{
      name: 'quokka-facts.md',
      content: `# Quokka Facts\n\nThe ${marker}. They live on Rottnest Island and are known for their cheerful expressions. Quokkas are herbivores that feed on native grasses and shrubs.`
    }]
  });

  // Reload so the sidepanel picks up the new project + document
  await page.reload();
  await page.getByRole('button', { name: /lore/i }).first().click().catch(() => {});

  // Library search finds the doc by content
  const search = page.getByPlaceholder(/Search your lore/i);
  await expect(search).toBeVisible({ timeout: 8000 });
  await search.fill('photogenic marsupials');
  await expect(page.getByText(/quokka-facts/i).first()).toBeVisible({ timeout: 10000 });

  // Opening the hit lands in DocumentView showing the matched text
  await page.getByText(/quokka-facts/i).first().click();
  await expect(page.getByRole('paragraph').filter({ hasText: new RegExp(marker, 'i') }).first()).toBeVisible({ timeout: 10000 });
  await page.close();
});

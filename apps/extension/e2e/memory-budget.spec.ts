import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────
// Memory budget E2E — the real-browser guard the unit tests can't be
// ─────────────────────────────────────────────
// document-list-payload.test.ts checks the strip at the handler boundary. This
// exercises the WHOLE path in a live extension: seed a heavy corpus into the real
// IndexedDB, ask the real service worker for the global list over the real
// message channel, and assert the payload comes back stripped. Without the strip,
// LIST_DOCUMENTS ships every full body and the sidepanel heap ratchets into the
// GBs on panel open (measured 328 MB → 2 GB). This fails if that regresses.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../dist');

const SEED_DOCS = 60;
const BODY_BYTES = 200_000;           // ~200 KB body each → ~12 MB raw corpus
const RAW_TOTAL = SEED_DOCS * BODY_BYTES;

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--enable-precise-memory-info',   // makes performance.memory usable
    ],
  });
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  extensionId = new URL(sw.url()).host;
});

test.afterAll(async () => { await context?.close(); });

test('global LIST_DOCUMENTS ships a stripped payload even with a heavy corpus', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(page.getByText('Default Session').first()).toBeVisible({ timeout: 10000 });

  // Seed a heavy corpus straight into the extension's IndexedDB (same origin as
  // the SW, so its getAll() sees these). Each doc carries a real frontmatter tag.
  const seeded = await page.evaluate(async ({ n, bodyBytes }) => {
    const body = 'x'.repeat(bodyBytes);
    const open = (name: string) => new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const dbs = (await (indexedDB as any).databases?.()) ?? [{ name: 'MagpieDB' }];
    for (const { name } of dbs) {
      if (!name) continue;
      const db = await open(name);
      if (!db.objectStoreNames.contains('documents')) { db.close(); continue; }
      const tx = db.transaction('documents', 'readwrite');
      const store = tx.objectStore('documents');
      for (let i = 0; i < n; i++) {
        store.put({
          id: `seed-${i}`, title: `Seed ${i}`, url: `https://seed.test/${i}`,
          content: `---\ntitle: Seed ${i}\ntags: [research-source]\n---\n\n${body}`,
          capturedAt: new Date().toISOString(), wordCount: 5, enabled: true, syncedToDrive: false,
        });
      }
      await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
      db.close();
      return n;
    }
    return 0;
  }, { n: SEED_DOCS, bodyBytes: BODY_BYTES });
  expect(seeded).toBe(SEED_DOCS);

  // Ask the REAL service worker for the global list (no projectId).
  const { bytes, count, taggedAll, anyFullBody } = await page.evaluate(async () => {
    const res: any = await chrome.runtime.sendMessage({ action: 'LIST_DOCUMENTS' });
    const docs: Array<{ content: string }> = res?.documents ?? [];
    const seeds = docs.filter((d: any) => String((d as any).id).startsWith('seed-'));
    return {
      bytes: JSON.stringify(res).length,
      count: seeds.length,
      taggedAll: seeds.every(d => d.content.includes('research-source')),
      anyFullBody: seeds.some(d => d.content.length > 5_000),
    };
  });

  expect(count).toBe(SEED_DOCS);
  // Frontmatter (and its tag) survives the strip → isResearchSource still works.
  expect(taggedAll).toBe(true);
  // No doc ships its full body…
  expect(anyFullBody).toBe(false);
  // …and the whole payload is a tiny fraction of the ~12 MB raw corpus.
  expect(bytes).toBeLessThan(RAW_TOTAL / 15);

  await page.close();
});

test('GET_DOCUMENT still returns the full body (the doc-open path)', async () => {
  // The strip is only for the LIST — opening a doc must still get its full text,
  // else DocumentView renders a stub. This guards the openDocById fetch path.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(page.getByText('Default Session').first()).toBeVisible({ timeout: 10000 });

  const fullLen = await page.evaluate(async () => {
    const res: any = await chrome.runtime.sendMessage({ action: 'GET_DOCUMENT', docId: 'seed-0' });
    return res?.document?.content?.length ?? 0;
  });
  expect(fullLen).toBeGreaterThan(150_000); // full ~200 KB body, not the stripped stub

  await page.close();
});

test('sidepanel heap stays bounded after loading the library (informational + catastrophic guard)', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(page.getByText('Default Session').first()).toBeVisible({ timeout: 10000 });
  // Lore view triggers loadDocuments (global list) — the panel-open path that blew up.
  await page.getByRole('button', { name: /lore/i }).click().catch(() => {});
  await page.waitForTimeout(1500);

  const heapMB = await page.evaluate(() => {
    const m = (performance as any).memory;
    return m ? Math.round(m.usedJSHeapSize / 1048576) : -1;
  });
  // Informational — precise-memory is quantized and varies. This only trips on a
  // catastrophic blowup (the 2 GB class), not normal variance. If it ever fires,
  // the global list is shipping full bodies again.
  test.info().annotations.push({ type: 'sidepanel-heapMB', description: String(heapMB) });
  if (heapMB > 0) expect(heapMB).toBeLessThan(900);

  await page.close();
});

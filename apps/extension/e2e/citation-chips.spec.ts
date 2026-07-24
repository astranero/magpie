import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../dist');

let context: BrowserContext;
let extensionId: string;

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

// Imports run the cold ONNX embedder (~30-40s for the first document in a
// fresh headless profile) — the work here is real, not stuck.
test.setTimeout(240000);

// ─────────────────────────────────────────────
// Citation-chip integrity — REAL data, end to end
// ─────────────────────────────────────────────
// The user-visible promise: a [anchor] chip in a research report opens the
// SOURCE document at the passage the claim came from. Every test here uses
// anchors harvested from the live chunk store (via SEARCH_LIBRARY), never
// hand-built ones, so what's verified is the store's actual state.

const SOURCE_A = `# Vitest Module Mocking

## Factory replacement semantics

When a test uses vi.mock with a factory, the quandong framework replaces the
entire module namespace with the factory's return object, and the original
module never executes at all.

## Partial mocks

An async factory that awaits importOriginal and spreads the result guarantees
every export stays defined while overriding only the tested surface.`;

const SOURCE_B = `# Nginx Streaming Configuration

## Proxy buffering

The bilberry directive proxy_buffering accumulates upstream bytes until the
buffer fills, which turns an SSE token stream into one terminal burst.

## Disabling per response

Setting the X-Accel-Buffering header to no lets an application opt a single
response out of buffering without touching global config.`;

/**
 * Import a doc and harvest a REAL anchor for a distinctive phrase in it.
 * The phrase is salted per test: local imports carry no URL, so the same
 * content imported by an earlier test in this profile is a separate document —
 * an unsalted search can harvest THAT copy's anchor and poison the assertions
 * with cross-test state.
 */
async function importAndHarvest(page: Page, projectId: string, name: string, content: string, phrase: string, salt: string) {
  const salted = content.replace(phrase, `${phrase} ${salt}`);
  await sendMessage(page, 'IMPORT_LOCAL_MD', { projectId, files: [{ name, content: salted }] });
  const search: any = await sendMessage(page, 'SEARCH_LIBRARY', { query: `${phrase} ${salt}` });
  const hit = (search?.results || []).find((r: any) => r.anchorId);
  expect(hit, `no anchored hit for "${phrase} ${salt}" — store returned ${JSON.stringify(search).slice(0, 200)}`).toBeTruthy();
  return hit as { id: string; title: string; anchorId: string };
}

test('harvested anchors resolve to chunks of the CORRECT document with text present in it', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(page.getByRole('button', { name: /chat/i }).first()).toBeVisible({ timeout: 10000 });
  const proj: any = await sendMessage(page, 'CREATE_PROJECT', { title: 'Cite Int A' });
  const projectId = proj?.project?.id || proj?.id;

  const a = await importAndHarvest(page, projectId, 'vitest-mocking.md', SOURCE_A, 'quandong framework replaces', 'alpha');
  const b = await importAndHarvest(page, projectId, 'nginx-streaming.md', SOURCE_B, 'bilberry directive', 'alpha');

  // Round-trip each anchor through the store and hold it to the verifier bar:
  // (1) resolves; (2) chunk text really occurs in ITS OWN doc's content;
  // (3) never occurs in the OTHER doc (correct-source, not just some-source).
  const docs: any = await sendMessage(page, 'LIST_DOCUMENTS', { projectId });
  const contentById = new Map((docs?.documents || []).map((d: any) => [d.id, d.content as string]));

  for (const [hit, otherId] of [[a, b.id], [b, a.id]] as const) {
    const res: any = await sendMessage(page, 'GET_CHUNK_BY_ANCHOR', { anchorId: hit.anchorId });
    expect(res?.success, `anchor ${hit.anchorId} did not resolve`).toBe(true);
    const chunkText: string = res.chunk.text;
    expect(chunkText.length).toBeGreaterThan(30);

    const own = (contentById.get(hit.id) || '').replace(/\s+/g, ' ');
    const other = (contentById.get(otherId) || '').replace(/\s+/g, ' ');
    const probe = chunkText.replace(/\s+/g, ' ').slice(0, 100);
    expect(own.includes(probe), `chunk text for ${hit.anchorId} not found in its own doc`).toBe(true);
    expect(other.includes(probe), `chunk text for ${hit.anchorId} ALSO in the other doc — ambiguous source`).toBe(false);

    // Anchor prefix must be derived from the chunk's real docId.
    expect(hit.anchorId.startsWith('d' + hit.id.slice(0, 6) + '.')).toBe(true);
  }
  await page.close();
});

test('RESOLVE_CITATIONS maps report anchors to the right docs; stale anchors resolve to nothing (not wrongly)', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(page.getByRole('button', { name: /chat/i }).first()).toBeVisible({ timeout: 10000 });
  const proj: any = await sendMessage(page, 'CREATE_PROJECT', { title: 'Cite Int B' });
  const projectId = proj?.project?.id || proj?.id;

  const a = await importAndHarvest(page, projectId, 'vitest-mocking.md', SOURCE_A, 'quandong framework replaces', 'bravo');
  const b = await importAndHarvest(page, projectId, 'nginx-streaming.md', SOURCE_B, 'bilberry directive', 'bravo');

  const reportText =
    `Factories replace the whole namespace [${a.anchorId}], while proxy buffering ` +
    `bursts streams [${b.anchorId}]. An orphaned claim [dzzzzzz.s0.p0] has no source.`;
  const res: any = await sendMessage(page, 'RESOLVE_CITATIONS', { text: reportText });
  const byAnchor = new Map((res?.citations || []).map((c: any) => [c.anchorId, c]));

  const ca: any = byAnchor.get(a.anchorId);
  const cb: any = byAnchor.get(b.anchorId);
  expect(ca, 'anchor A unresolved').toBeTruthy();
  expect(cb, 'anchor B unresolved').toBeTruthy();
  // The property the user doubts: chip → CORRECT source.
  expect(ca.docId).toBe(a.id);
  expect(cb.docId).toBe(b.id);
  expect(ca.docTitle).toMatch(/vitest-mocking/i);
  expect(cb.docTitle).toMatch(/nginx-streaming/i);
  expect(ca.chunkText).toMatch(/quandong/);
  expect(cb.chunkText).toMatch(/bilberry/);
  // Stale anchor: absent from the map — never mapped to a wrong doc.
  expect(byAnchor.has('dzzzzzz.s0.p0')).toBe(false);
  await page.close();
});

/**
 * Put the panel on the workspace this test created, then open the Lore list.
 *
 * `CREATE_PROJECT` is a background message: it creates the project and returns
 * its id, and that is ALL it does. It does not touch the panel's active
 * workspace, which is UI state the user drives. These tests used to import into
 * a fresh project and then reload, hoping the panel would be showing it — the
 * panel kept whatever workspace it had (usually "Default Session"), the
 * imported doc was in a workspace nobody was looking at, and the click waited
 * out the full 240s timeout.
 *
 * Selecting the workspace the way a user does makes it deterministic and
 * exercises the real path. The old `.catch(() => {})` around the Lore click is
 * gone with it: it swallowed exactly the failure that would have named this.
 */
async function openWorkspaceLore(page: Page, workspaceTitle: string) {
  await page.reload();
  await expect(page.getByRole('button', { name: /chat/i }).first()).toBeVisible({ timeout: 15000 });
  const picker = page.getByRole('combobox').first();
  await picker.click();
  await page.getByRole('option', { name: workspaceTitle, exact: true }).click();
  await expect(picker).toContainText(workspaceTitle, { timeout: 10000 });
  await page.getByRole('button', { name: /lore/i }).first().click();
}

test('UI click-through: chip in a saved report opens the source doc at the cited passage', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(page.getByRole('button', { name: /chat/i }).first()).toBeVisible({ timeout: 10000 });
  const proj: any = await sendMessage(page, 'CREATE_PROJECT', { title: 'Cite Int C' });
  const projectId = proj?.project?.id || proj?.id;

  const a = await importAndHarvest(page, projectId, 'vitest-mocking.md', SOURCE_A, 'quandong framework replaces', 'charlie');

  // A report document whose body carries a REAL raw anchor.
  await sendMessage(page, 'IMPORT_LOCAL_MD', {
    projectId,
    files: [{
      name: 'research-report.md',
      content: `# Findings\n\nModule factories replace the entire namespace [${a.anchorId}], so partial mocks must spread the original exports.`
    }]
  });

  await openWorkspaceLore(page, 'Cite Int C');
  await page.getByText(/research-report/i).first().click();

  // The chip renders as a button whose title names the SOURCE doc.
  const chip = page.getByRole('button', { name: /citation .*vitest-mocking/i }).first();
  await expect(chip, 'citation chip did not render or does not name its source').toBeVisible({ timeout: 10000 });
  await chip.click();

  // Landed in the source document: its heading is visible (a bare getByText
  // matches the HIDDEN Lore-list entry behind the view), the cited passage is
  // on screen, and the [CITED] marker sits at the passage.
  await expect(page.getByRole('heading', { name: 'vitest-mocking' })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText(/quandong framework replaces charlie/i).first()).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('[CITED]').first()).toBeVisible({ timeout: 5000 });
  await page.close();
});

test('pre-linkified [[n](#cite:anchor)] report (the shape research saves) resolves and click-throughs', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(page.getByRole('button', { name: /chat/i }).first()).toBeVisible({ timeout: 10000 });
  const proj: any = await sendMessage(page, 'CREATE_PROJECT', { title: 'Cite Int D' });
  const projectId = proj?.project?.id || proj?.id;

  const a = await importAndHarvest(page, projectId, 'vitest-mocking.md', SOURCE_A, 'quandong framework replaces', 'delta');

  // Exactly what linkifyReportCitations now writes for a known source.
  await sendMessage(page, 'IMPORT_LOCAL_MD', {
    projectId,
    files: [{
      name: 'linked-report.md',
      content: `# Findings\n\nModule factories replace the entire namespace [[1](#cite:${a.anchorId})], so partial mocks must spread the original exports.\n\n## Sources\n\n1. [Vitest docs](https://vitest.dev)`
    }]
  });

  await openWorkspaceLore(page, 'Cite Int D');
  await page.getByText(/linked-report/i).first().click();

  const chip = page.getByRole('button', { name: /citation .*vitest-mocking/i }).first();
  await expect(chip, 'pre-linkified citation did not resolve into a chip naming its source').toBeVisible({ timeout: 10000 });
  await chip.click();

  await expect(page.getByRole('heading', { name: 'vitest-mocking' })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText(/quandong framework replaces delta/i).first()).toBeVisible({ timeout: 10000 });
  await page.close();
});

test('numbered chips [1] and [2] open the docs their Sources entries name — never crossed', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(page.getByRole('button', { name: /chat/i }).first()).toBeVisible({ timeout: 10000 });
  const proj: any = await sendMessage(page, 'CREATE_PROJECT', { title: 'Cite Int E' });
  const projectId = proj?.project?.id || proj?.id;

  const a = await importAndHarvest(page, projectId, 'vitest-mocking.md', SOURCE_A, 'quandong framework replaces', 'echo');
  const b = await importAndHarvest(page, projectId, 'nginx-streaming.md', SOURCE_B, 'bilberry directive', 'echo');

  // Assembled exactly as saveSynthesisReport writes it: [[n](#cite:anchor)]
  // inline, Sources numbered in citation order (A cited first → 1).
  await sendMessage(page, 'IMPORT_LOCAL_MD', {
    projectId,
    files: [{
      name: 'numbered-report.md',
      content:
        `# Findings\n\nFactories replace the namespace [[1](#cite:${a.anchorId})], while proxy buffering ` +
        `bursts streams [[2](#cite:${b.anchorId})].\n\n## Sources\n1. [vitest-mocking](file://a)\n2. [nginx-streaming](file://b)`
    }]
  });

  await openWorkspaceLore(page, 'Cite Int E');
  await page.getByText(/numbered-report/i).first().click();

  // Chip [1]'s accessible name must carry SOURCE A's title, [2] SOURCE B's —
  // a crossed pairing here is the "wrong source" failure this suite exists for.
  const chip1 = page.getByRole('button', { name: /citation 1.*vitest-mocking/i }).first();
  const chip2 = page.getByRole('button', { name: /citation 2.*nginx-streaming/i }).first();
  await expect(chip1, 'chip [1] not labeled with Sources entry 1 doc').toBeVisible({ timeout: 10000 });
  await expect(chip2, 'chip [2] not labeled with Sources entry 2 doc').toBeVisible({ timeout: 10000 });

  // Click [2]: must land in nginx-streaming at its cited passage.
  await chip2.click();
  await expect(page.getByRole('heading', { name: 'nginx-streaming' })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText(/bilberry directive echo/i).first()).toBeVisible({ timeout: 10000 });

  // Back to the report, then click [1]: vitest-mocking.
  await page.getByRole('button', { name: /back/i }).click();
  await page.getByText(/numbered-report/i).first().click();
  await page.getByRole('button', { name: /citation 1.*vitest-mocking/i }).first().click();
  await expect(page.getByRole('heading', { name: 'vitest-mocking' })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText(/quandong framework replaces echo/i).first()).toBeVisible({ timeout: 10000 });
  await page.close();
});

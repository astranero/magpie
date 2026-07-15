import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
  loadApiKey, launchExtension, openPanel, configureProvider, activeProjectId, sendChat,
  OPENROUTER_URL, TEXT_MODEL, VISION_MODEL,
} from './live-helpers';

// ─────────────────────────────────────────────
// Live-model E2E — every model-dependent surface, against real OpenRouter
// ─────────────────────────────────────────────
// Wide coverage of the config matrix + command flows + their PROCESS INDICATION
// (thinking status line, streaming caret, plan-card status chip):
//   1. provider config round-trip: FETCH_CUSTOM_MODELS validates URL+key live
//   2. chat turn: streams, shows indication while running, finalizes clean
//   3. markdown rendering from a real model
//   4. /analyze command: expands + runs through the same status pipeline
//   5. /deepresearch: plan preview card (Planning… → draft → cancel)
//   6. vision config: IMPORT_LOCAL_IMAGES describes an image via visionModel
//   7. negative config: a bad key surfaces an error, never a silent hang
// Skips (not fails) when no key is configured — see live-helpers.ts.
//
// ISOLATION: every test gets a FRESH browser context/profile. Tests sharing a
// profile share the persisted active chat — a turn left streaming by a failed
// test makes the next test's send silently QUEUE behind it (observed live:
// the "queued" chip, no answer). Fresh profile per test kills that class.

const KEY = loadApiKey();
test.skip(!KEY, 'No OpenRouter key (env OPENROUTER_API_KEY or e2e/.openrouter-key)');

let context: BrowserContext;
let extensionId: string;

test.beforeEach(async () => {
  test.setTimeout(150000); // real provider: TTFT + full generations
  ({ context, extensionId } = await launchExtension());
});
test.afterEach(async () => { await context?.close(); });

async function chatPage(overrides?: { key?: string }): Promise<Page> {
  const page = await openPanel(context, extensionId);
  await page.getByRole('button', { name: /chat/i }).click();
  await configureProvider(page, {
    url: OPENROUTER_URL, key: overrides?.key ?? KEY!, model: TEXT_MODEL, visionModel: VISION_MODEL,
  });
  return page;
}

/** True once any process indication for an in-flight turn is on screen. */
async function sawProcessIndication(page: Page): Promise<boolean> {
  return await Promise.race([
    page.getByText(/Thinking…|Understanding the question|Searching your sources|Writing the answer/i).first()
      .waitFor({ timeout: 25000 }).then(() => true).catch(() => false),
    page.locator('.animate-pulse').first().waitFor({ timeout: 25000 }).then(() => true).catch(() => false),
  ]);
}

test('config: FETCH_CUSTOM_MODELS lists models from OpenRouter (validates URL + key)', async () => {
  const page = await openPanel(context, extensionId);
  const res = await page.evaluate(async ({ url, key }) => {
    return await (globalThis as any).chrome.runtime.sendMessage({ action: 'FETCH_CUSTOM_MODELS', url, apiKey: key });
  }, { url: OPENROUTER_URL, key: KEY! });
  const models: string[] = (res?.models ?? []).map((m: any) => typeof m === 'string' ? m : m.id);
  expect(models.length).toBeGreaterThan(10);
  expect(models.some(id => /gemini/i.test(id))).toBe(true);
});

test('chat: streams a real answer with process indication, finalizes clean', async () => {
  const page = await chatPage();

  await sendChat(page, 'Reply with exactly one word: PONG');
  expect(await sawProcessIndication(page)).toBe(true);

  // The ANSWER lands in an assistant bubble (.prose renders assistant/system
  // markdown; the user bubble is plain text) — case-insensitive, models vary.
  await expect(page.locator('.prose', { hasText: /pong/i }).last()).toBeVisible({ timeout: 60000 });
  // ...and the indication clears.
  await page.waitForFunction(() => !document.querySelector('.animate-pulse'), undefined, { timeout: 20000, polling: 100 });
});

test('chat: markdown from the live model renders (no raw ** leaks)', async () => {
  const page = await chatPage();

  await sendChat(page, 'Write the word ready in bold markdown and nothing else.');
  await expect(page.locator('strong', { hasText: /ready/i }).last()).toBeVisible({ timeout: 60000 });
  const raw = await page.evaluate(() => (document.body.innerText || '').includes('**'));
  expect(raw).toBe(false);
});

test('command: /analyze runs through the status pipeline and answers', async () => {
  const page = await chatPage();

  await sendChat(page, '/analyze what documents do I have?');
  // Command flows share the chat STATUS pipeline — indication must show.
  expect(await sawProcessIndication(page)).toBe(true);

  // An assistant reply lands (workspace may be empty — any coherent answer is fine).
  await page.waitForFunction(() => {
    const bubbles = document.querySelectorAll('.prose');
    const last = bubbles[bubbles.length - 1];
    return !!last && (last.textContent || '').trim().length > 20 && !document.querySelector('.animate-pulse');
  }, undefined, { timeout: 90000, polling: 200 });
});

test('command: /deepresearch previews a plan card with sub-questions, cancellable', async () => {
  const page = await chatPage();

  await sendChat(page, '/deepresearch health effects of coffee');

  // The plan card's PROCESS INDICATION is its status chip: 'Planning…' while
  // the model drafts, then the draft state with actionable Start/Cancel.
  await page.getByText(/Planning…|Deep Research/i).first().waitFor({ timeout: 30000 });
  const cancel = page.getByRole('button', { name: /cancel/i }).first();
  await cancel.waitFor({ timeout: 90000 });
  await cancel.click();
  await expect(page.getByText(/Cancelled/i).first()).toBeVisible({ timeout: 10000 });
});

test('vision config: IMPORT_LOCAL_IMAGES describes an image via the vision model', async () => {
  const page = await chatPage();
  const projectId = await activeProjectId(page);
  expect(projectId).toBeTruthy();

  // 1x1 red PNG — the vision model returns SOME description, which the importer
  // saves as a document. NOTE: the doc's title is AI-GENERATED (not the file
  // name), so we find it by its frontmatter source marker instead.
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const title = await page.evaluate(async ({ projectId, dataUrl }) => {
    const send = (m: any) => (globalThis as any).chrome.runtime.sendMessage(m);
    // The import runs async in the SW and reports progress/errors over this
    // channel — capture them so a failure names its real cause.
    const events: string[] = [];
    const ch = new BroadcastChannel('ai_research_assistant_import');
    ch.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === 'image-progress') events.push(`${d.status}${d.error ? `: ${d.error}` : ''}`);
    };
    const kick: any = await send({ action: 'IMPORT_LOCAL_IMAGES', projectId, files: [{ name: 'e2e-red-pixel.png', dataUrl }] });
    if (kick?.error) return `IMPORT ERROR: ${kick.error}`;
    // Poll until the image doc lands (embedder model download can take a while
    // on a cold profile — give it 2 minutes).
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 120; i++) {
      if (events.some(s => s.startsWith('error'))) return `IMPORT ERROR: ${events.join(' | ')}`;
      const res: any = await send({ action: 'LIST_DOCUMENTS', projectId });
      // Frontmatter values may be YAML-quoted (source: "local-image") — match loosely.
      const doc = (res?.documents ?? []).find((d: any) => (d.content || '').includes('local-image'));
      if (doc && (doc.wordCount ?? 0) > 0) return doc.title as string;
      await sleep(1000);
    }
    return `TIMEOUT — progress events: [${events.join(' | ')}]`;
  }, { projectId, dataUrl });

  expect(title, `image import failed (got: ${JSON.stringify(title)})`).toBeTruthy();
  expect(title).not.toMatch(/^IMPORT ERROR|^TIMEOUT/);
});

test('negative config: a bad API key surfaces an error, not a silent hang', async () => {
  // The turn walks the full context pipeline BEFORE the LLM call that 401s —
  // on this test's cold profile that includes the embedder's one-time ONNX
  // model download (~1-2 min). The error still must surface; give it room.
  test.setTimeout(240000);
  const page = await chatPage({ key: 'sk-or-v1-invalid-key-for-test' });

  await sendChat(page, 'hello');

  // The panel must settle into a visible error state — busy indication gone,
  // error text present (system message or toast).
  await page.waitForFunction(() => {
    const text = document.body.innerText || '';
    const busy = !!document.querySelector('.animate-pulse');
    return !busy && /error|failed|401|unauthorized|invalid|check settings|credentials|no auth/i.test(text);
  }, undefined, { timeout: 200000, polling: 250 });
});

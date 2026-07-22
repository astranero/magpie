import { test, expect, type BrowserContext } from '@playwright/test';
import {
  loadApiKey, launchExtension, openPanel, configureProvider, activeProjectId, sendChat,
  OPENROUTER_URL, TEXT_MODEL,
} from './live-helpers';

// ─────────────────────────────────────────────
// Live-model E2E — /teach against a real provider
// ─────────────────────────────────────────────
// The unit tests mock the LLM away, so they prove the sequencing logic but not
// the thing /teach actually promises: that a lesson SURVIVES the chat. This
// exercises the real round-trip — mission written into project.rules, lesson
// saved as a document, second run numbered 2 and aware of lesson 1.

const KEY = loadApiKey();
test.skip(!KEY, 'No OpenRouter key (env OPENROUTER_API_KEY or e2e/.openrouter-key)');

let context: BrowserContext;
let extensionId: string;

test.beforeEach(async () => {
  test.setTimeout(180000);
  ({ context, extensionId } = await launchExtension());
});
test.afterEach(async () => { await context?.close(); });

test('/teach writes a mission, saves a lesson, and sequences the next one', async () => {
  const page = await openPanel(context, extensionId);
  await page.getByRole('button', { name: /chat/i }).click();
  await configureProvider(page, { url: OPENROUTER_URL, key: KEY!, model: TEXT_MODEL });
  const projectId = await activeProjectId(page);

  // ── First run: no mission yet, so it establishes one and teaches lesson 1
  const first = await page.evaluate(async (pid) => {
    return await (globalThis as any).chrome.runtime.sendMessage({
      action: 'TEACH', projectId: pid, topic: 'spaced repetition for learning Finnish vocabulary',
    });
  }, projectId);

  expect(first?.success, `TEACH failed: ${first?.error}`).not.toBe(false);
  expect(first.missionCreated).toBe(true);
  expect(first.lessonNumber).toBe(1);
  expect(String(first.mission).length).toBeGreaterThan(40);

  // The mission must be in project.rules — that's what makes every later turn
  // in this workspace mission-grounded, not just the /teach ones.
  const rules = await page.evaluate(async (pid) => {
    const r = await (globalThis as any).chrome.runtime.sendMessage({ action: 'GET_PROJECT', id: pid });
    return r?.project?.rules ?? '';
  }, projectId);
  expect(rules).toContain('magpie:mission');

  // The lesson must exist as a real document, not just a chat message.
  const docs = await page.evaluate(async (pid) => {
    const r = await (globalThis as any).chrome.runtime.sendMessage({ action: 'LIST_DOCUMENTS', projectId: pid });
    return (r?.documents ?? []).map((d: any) => ({ title: d.title, content: d.content }));
  }, projectId);
  const lesson1 = docs.find((d: any) => /^Lesson 1:/.test(d.title));
  expect(lesson1, `no lesson doc among: ${docs.map((d: any) => d.title).join(', ')}`).toBeTruthy();
  expect(lesson1.content).toMatch(/^type: lesson$/m);
  expect(lesson1.content).toMatch(/^lesson: 1$/m);
  expect(lesson1.content.length).toBeGreaterThan(400);

  // ── Second run: reuses the mission and numbers the lesson 2
  const second = await page.evaluate(async (pid) => {
    return await (globalThis as any).chrome.runtime.sendMessage({
      action: 'TEACH', projectId: pid, topic: '',
    });
  }, projectId);
  expect(second?.success).not.toBe(false);
  expect(second.missionCreated).toBe(false);
  expect(second.lessonNumber).toBe(2);
  expect(second.title).not.toBe(first.title);
});

test('/grill asks one question at a time instead of a batch', async () => {
  const page = await openPanel(context, extensionId);
  await page.getByRole('button', { name: /chat/i }).click();
  await configureProvider(page, { url: OPENROUTER_URL, key: KEY!, model: TEXT_MODEL });

  await sendChat(page, '/grill I want to rewrite our billing service in Rust over one quarter');

  const transcript = page.locator('[data-role="assistant"], .prose').last();
  await expect(transcript).toBeVisible({ timeout: 60000 });
  await page.waitForTimeout(6000);
  const text = (await transcript.innerText()).trim();

  // One question per reply is the whole point — a batch is the failure mode.
  const questionMarks = (text.match(/\?/g) || []).length;
  expect(questionMarks, `expected a single question, got:\n${text.slice(0, 600)}`).toBeLessThanOrEqual(2);
  expect(text.length).toBeGreaterThan(40);
});

import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../dist');

let context: BrowserContext;
let extensionId: string;

async function sendMessage(page: Page, action: string, data: Record<string, unknown>) {
  return page.evaluate(([a, d]) => new Promise((resolve) => {
    (globalThis as any).chrome.runtime.sendMessage({ action: a, ...(d as object) }, (res: unknown) => resolve(res));
  }), [action, data] as const);
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

// Structural render check for the markdown pipeline (ReactMarkdown + remark-gfm
// + remark-math + rehype-katex + our prose CSS). Not a pixel diff — asserts the
// risky elements actually became rendered DOM, so a broken plugin/CSS or a
// regression that leaks raw markdown ($$, | tables |, ```) is caught.
const KITCHEN_SINK = `# Render Check

Intro with **bold**, *italic*, \`inline code\`, and a [link](https://example.com).

| Feature | Status |
|---|---|
| Tables | render |
| Math | katex |

\`\`\`ts
function greet(name: string) { return "hi " + name; }
\`\`\`

Inline math $E = mc^2$ and display:

$$\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}$$

> A blockquote line.
`;

test('markdown renders tables, code, and KaTeX math (no raw markup leaks)', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(page.getByText('Default Session').first()).toBeVisible({ timeout: 10000 });

  const proj: any = await sendMessage(page, 'CREATE_PROJECT', { title: 'Render' });
  const projectId = proj?.project?.id || proj?.id;
  expect(projectId).toBeTruthy();
  await sendMessage(page, 'IMPORT_LOCAL_MD', {
    projectId,
    files: [{ name: 'render-check.md', content: KITCHEN_SINK }]
  });

  await page.reload();
  await page.getByRole('button', { name: /lore/i }).first().click().catch(() => {});
  await page.getByText(/render-check/i).first().click({ timeout: 10000 });

  // Table became a real <table> with the expected cell.
  const doc = page.locator('.prose').first();
  await expect(doc.locator('table')).toBeVisible({ timeout: 10000 });
  await expect(doc.getByRole('cell', { name: 'katex' })).toBeVisible();

  // Fenced code became a <pre><code> block.
  await expect(doc.locator('pre code')).toContainText('function greet');

  // KaTeX actually rendered (rehype-katex emits .katex), inline + display.
  await expect(doc.locator('.katex').first()).toBeVisible();
  expect(await doc.locator('.katex').count()).toBeGreaterThanOrEqual(2);

  // Blockquote element exists.
  await expect(doc.locator('blockquote')).toBeVisible();

  // No raw markdown leaked into visible text.
  const text = (await doc.innerText()) || '';
  expect(text).not.toContain('$$');
  expect(text).not.toContain('```');
  expect(text).not.toMatch(/\|\s*Feature\s*\|/);   // raw table pipe row

  await page.close();
});

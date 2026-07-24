import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../dist');

// A local article page for the link-follow flow. Long enough to clear the
// content quality gate (≥200 chars / ≥50 words) and give Readability a
// real article body to extract.
const ARTICLE_HTML = `<!doctype html>
<html><head><title>The Winter Habits of Magpies</title></head>
<body>
<article>
  <h1>The Winter Habits of Magpies</h1>
  <p>Magpies are among the most intelligent birds known to science, and their
  winter behavior shows a remarkable capacity for planning. Through the cold
  months they maintain and revisit dozens of food caches, remembering not just
  where each cache is but what it contains and how quickly it will spoil.</p>
  <p>Researchers observing wild flocks have documented magpies moving a cache
  when another bird watched them hide it, an act that implies something like
  a theory of mind. The birds prioritize perishable items first and return to
  durable seeds weeks later, an ordering that mirrors optimal inventory
  management strategies used in warehouse logistics.</p>
  <p>Their famous attraction to shiny objects is largely myth, but their
  collecting instinct is real: nesting pairs gather hundreds of distinct
  materials, evaluating each twig and fiber for structural quality before
  weaving it into a domed nest that can outlast a decade of storms.</p>
</article>
</body></html>`;

function startArticleServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(ARTICLE_HTML);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({ server, url: `http://127.0.0.1:${port}/article` });
    });
  });
}

let context: BrowserContext;
let extensionId: string;
let article: { server: Server; url: string };

test.beforeAll(async () => {
  article = await startArticleServer();
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`]
  });
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  extensionId = new URL(sw.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  article?.server.close();
});

// /follow fetches a URL through the scrape pipeline and previews it INSIDE
// the panel; Capture saves it into the workspace. Guards the whole
// link-follow loop: command routing → FETCH_URL_PREVIEW (Jina fails for
// 127.0.0.1, so this also exercises the local offscreen-parse fallback) →
// overlay render → CAPTURE_URL → Lore listing.
test('/follow previews a link in-panel and captures it to the workspace', async () => {
  test.setTimeout(90_000); // Jina fallback path can take ~20s before local parse
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByRole('button', { name: /chat/i }).click();

  const input = page.locator('#chat-input');
  await input.fill(`/follow ${article.url}`);
  await input.press('Enter');

  // Preview overlay appears and renders the fetched article
  await expect(page.getByText('Link preview — not saved')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('capacity for planning', { exact: false })).toBeVisible({ timeout: 45_000 });

  // Capture into the workspace
  await page.getByRole('button', { name: /capture to workspace/i }).click();
  await expect(page.getByText('Captured to workspace')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: /^close$/i }).click();

  // The captured page is now a workspace document in Lore
  await page.getByRole('button', { name: /lore/i }).click();
  await expect(page.getByText('The Winter Habits of Magpies').first()).toBeVisible({ timeout: 10_000 });

  await page.close();
});

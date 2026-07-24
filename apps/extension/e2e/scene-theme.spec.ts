import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Own spec file, own persistent profile: theme lives in localStorage, so a
// shared context would leak the choice into other specs.
const EXT = path.resolve(__dirname, '../dist');
let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  extensionId = sw.url().split('/')[2];
});
test.afterAll(async () => { await context?.close(); });

async function panel(theme: string) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.evaluate(t => localStorage.setItem('magpie-theme', t), theme);
  await page.reload();
  return page;
}

test('each scene puts exactly one palette class on <html>', async () => {
  for (const [theme, cls] of [['ghibli', 'ghibli'], ['village', 'village'], ['dark', 'dark']] as const) {
    const page = await panel(theme);
    const classes = await page.evaluate(() => [...document.documentElement.classList]);
    const palettes = classes.filter(c => ['dark', 'village', 'ghibli'].includes(c));
    expect(palettes, `theme=${theme} put ${palettes.join('+')} on <html>`).toEqual([cls]);
    await page.close();
  }
});

test('ghibli actually repaints the panel — tokens differ from light', async () => {
  const read = async (theme: string) => {
    const page = await panel(theme);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.close();
    return bg;
  };
  // A palette that does not change the rendered background is a palette that
  // was never wired up, which is how the theme preference shipped dead once.
  expect(await read('ghibli')).not.toBe(await read('light'));
});

test('the picker offers Ghibli and switching it takes effect immediately', async () => {
  const page = await panel('light');
  await page.getByRole('button', { name: /config/i }).click();
  // The picker renders role="radio" buttons, not plain buttons.
  const ghibli = page.getByRole('radio', { name: /Ghibli/i }).first();
  await ghibli.scrollIntoViewIfNeeded();
  await expect(ghibli).toBeVisible({ timeout: 8000 });
  await ghibli.click();
  // No reload: the applier listens for the change event.
  await expect.poll(() =>
    page.evaluate(() => document.documentElement.classList.contains('ghibli'))
  ).toBe(true);
  await page.close();
});

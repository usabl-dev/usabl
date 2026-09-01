import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { checkPage } from '../../src/surfaces/playwright-helper.js';

// A minimal accessible page: titled, one landmark, one h1, one named control, high contrast.
// axe finds no violations and no incompletes here, so a full page check should be verified.
const CLEAN_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Reports</title>
  </head>
  <body>
    <main>
      <h1>Reports</h1>
      <button type="button">Run report</button>
    </main>
  </body>
</html>`;

// A page with a guaranteed deterministic failure: an image with no alt text. image-alt is a
// hard axe violation (never incomplete), so this must gate to a regression.
const IMAGE_ALT_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Broken</title>
  </head>
  <body>
    <main>
      <h1>Dashboard</h1>
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" />
    </main>
  </body>
</html>`;

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('checkPage on a live Playwright page', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  // Real Playwright suites hand checkPage a page from the @playwright/test `page` fixture, which is
  // created from a per-test browser.newContext(). Mirror that here (not the browser.newPage()
  // shortcut) because @axe-core/playwright only runs on context-owned pages.
  async function openPage(html: string): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    return { context, page };
  }

  it('returns verified for an accessible page', async () => {
    const { context, page } = await openPage(CLEAN_HTML);
    try {
      const result = await checkPage(page, { tabCap: 10 });

      expect(result.failures).toEqual([]);
      expect(result.verdict).toBe('verified');
    } finally {
      await context.close();
    }
  });

  it('returns regression for a page with a missing image alt', async () => {
    const { context, page } = await openPage(IMAGE_ALT_HTML);
    try {
      const result = await checkPage(page, { tabCap: 10 });

      expect(result.verdict).toBe('regression');
      expect(result.failures.some((f) => f.rule === 'image-alt')).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('leaves the caller-supplied page open and usable', async () => {
    const { context, page } = await openPage(CLEAN_HTML);
    try {
      await checkPage(page, { tabCap: 5 });

      // adoptPage must never close a page or context it did not create.
      expect(page.isClosed()).toBe(false);
      await expect(page.title()).resolves.toBe('Reports');
    } finally {
      await context.close();
    }
  });
});

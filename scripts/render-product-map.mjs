#!/usr/bin/env node
/**
 * Renders docs/demo/usabl-product-map.png from docs/demo/usabl-product-map.html.
 *
 * The demo script brings the PNG up on camera, so the PNG must match the HTML source.
 * Run this after editing the HTML, then commit both files:
 *
 *   npm run render:product-map
 *
 * The page opens in a 1340 pixel wide viewport at device scale factor 2. At that width the
 * page wrap lays the SVG out at 1292 by 716 CSS pixels, so the PNG comes out at 2584 by 1432
 * pixels, the geometry the demo was framed on. The browser is the Playwright Chromium already
 * pinned by this repository, loaded the same way scripts/check-docs-a11y.mjs loads it.
 */
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const VIEWPORT = { width: 1340, height: 900 };
const DEVICE_SCALE_FACTOR = 2;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'docs', 'demo', 'usabl-product-map.html');
const target = join(root, 'docs', 'demo', 'usabl-product-map.png');

// Width and height live in the IHDR chunk, which always follows the 8 byte PNG signature.
async function pngDimensions(path) {
  const bytes = await readFile(path);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function render() {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
    });
    const page = await context.newPage();
    await page.goto(pathToFileURL(source).href, { waitUntil: 'load' });
    // Fonts arrive after load. A screenshot taken before they settle can differ between runs.
    await page.evaluate(() => document.fonts.ready);
    await page.locator('svg').first().screenshot({
      path: target,
      animations: 'disabled',
      caret: 'hide',
      scale: 'device',
    });
  } finally {
    await browser.close();
  }
}

await render();
const { width, height } = await pngDimensions(target);
process.stdout.write(
  `rendered ${relative(root, target)} from ${relative(root, source)}: ${width} x ${height} pixels\n`,
);

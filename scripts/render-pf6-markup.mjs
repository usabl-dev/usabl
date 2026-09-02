/**
 * Regenerates fixtures/pf6/rendered-markup.html from an installed PatternFly 6.
 *
 * Why this exists: a selector that only matches a hand written fixture proves nothing,
 * because the fixture gets written to match the selector. This script bundles
 * scripts/pf6-markup-entry.jsx against a real @patternfly/react-core install, renders it
 * in Chromium, and writes the resulting DOM out. The committed fixture is therefore
 * library output, and a selector test against it is a real check.
 *
 * usabl does not depend on React or PatternFly, so this needs a host project that does.
 * Point PF_APP at its root:
 *
 *   PF_APP=/path/to/a/patternfly6/app node scripts/render-pf6-markup.mjs
 *
 * The script records the resolved @patternfly/react-core version in the fixture header so
 * the fixture always says which library version it came from.
 */
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const entry = join(scriptDir, 'pf6-markup-entry.jsx');
const outFile = join(repoRoot, 'fixtures', 'pf6', 'rendered-markup.html');

const appRoot = process.env.PF_APP;
if (!appRoot) {
  console.error('Set PF_APP to the root of a project that has @patternfly/react-core installed.');
  process.exit(1);
}

const appRequire = createRequire(join(resolve(appRoot), 'package.json'));
const pfVersion = JSON.parse(
  await readFile(appRequire.resolve('@patternfly/react-core/package.json'), 'utf8'),
).version;
const tableVersion = JSON.parse(
  await readFile(appRequire.resolve('@patternfly/react-table/package.json'), 'utf8'),
).version;

const bundle = await build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  // React and PatternFly resolve out of the host project, not out of usabl.
  nodePaths: [join(resolve(appRoot), 'node_modules')],
  absWorkingDir: resolve(appRoot),
  define: { 'process.env.NODE_ENV': '"production"' },
  // Only the markup matters here, so PatternFly's stylesheets are dropped rather than bundled.
  loader: { '.css': 'empty' },
});

const script = bundle.outputFiles[0].text;

const browser = await chromium.launch({ headless: true });
try {
  // ToolbarToggleGroup only renders its popup toggle below the lg breakpoint (992px), so a
  // narrow viewport is what puts its aria-haspopup="true" markup in the fixture.
  const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.setContent('<!doctype html><html lang="en"><head><title>PatternFly 6</title></head><body><div id="root"></div></body></html>');
  await page.addScriptTag({ content: script });
  await page.waitForSelector('#root main', { timeout: 10_000 });
  // PatternFly's focus trap and Popper both settle after paint, so give them a frame.
  await page.waitForTimeout(500);
  if (errors.length > 0) {
    throw new Error(`render failed: ${errors.join(' | ')}`);
  }
  const body = await page.evaluate(() => document.body.innerHTML);
  const header = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<title>PatternFly 6 rendered markup</title>',
    '<!--',
    '  Generated file. Do not edit by hand.',
    '  Source: scripts/pf6-markup-entry.jsx rendered in Chromium by scripts/render-pf6-markup.mjs.',
    '  The page is rendered with a modal open, so PatternFly has set aria-hidden on the app root',
    '  and moved the modal and every popup to the end of body. That is real PatternFly behavior.',
    '  Use this file for selector checks, not as an example of an accessible page.',
    `  @patternfly/react-core ${pfVersion}`,
    `  @patternfly/react-table ${tableVersion}`,
    '-->',
    '</head>',
    '<body>',
  ].join('\n');
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, `${header}\n${body}\n</body>\n</html>\n`, 'utf8');
  console.log(`wrote ${outFile} from @patternfly/react-core ${pfVersion}`);
} finally {
  await browser.close();
}

import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Self-gate: usabl holds other products to WCAG 2.2 AA, so it holds its own
// shipped HTML docs to the same bar. This scanner walks every `.html` file under
// docs/, renders it in headless Chromium, and runs axe-core against it. A doc
// that self-navigates one view at a time (the product deck shows one `.slide`
// per hash) is scanned once per view, because axe only sees what is visible.
//
// The view list is read from the live DOM, never hardcoded. An earlier harness
// hardcoded a slide list, drifted out of date, and reported a false "clean"
// while a real contrast defect sat on the slides it never visited. Enumerating
// from the DOM is the fix for that class of mistake.
//
// Scope boundary, stated so a green run is not mistaken for total coverage:
// this walks static pages and every `.slide` view. It does not yet drive
// interactive states such as open dialogs or expanded menus; if a doc grows
// such a state, its contents are not covered here.

// Load the repo-pinned playwright + axe-core through the repo's own package.json
// so the gate uses the exact versions the engine ships against, not whatever a
// global install happens to provide.
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const axeMod = require('@axe-core/playwright');
const AxeBuilder = axeMod.default ?? axeMod.AxeBuilder ?? axeMod;

// WCAG 2.2, Levels A and AA. This is the standard usabl markets and enforces on
// the products it scans, so it is the standard its own docs must clear. The tag
// set is cumulative across WCAG 2.0 / 2.1 / 2.2; it deliberately omits AAA and
// axe "best-practice" rules, which are not WCAG A/AA failures.
const WCAG_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const VIEW_TIMEOUT_MS = 5000;

async function findHtmlDocs(root) {
  const found = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.html') {
        found.push(full);
      }
    }
  }

  await walk(join(root, 'docs'));
  return found.sort();
}

// Bring one self-navigated view into the foreground and wait until it is
// actually visible. Uses the same `location.hash` path a real reader uses, so
// the gate exercises the shipped navigation rather than forcing styles. It waits
// on computed visibility rather than any single toggle mechanism, so it works
// whether a doc reveals views through CSS `:target` rules or a script.
async function showView(page, id) {
  await page.evaluate((slideId) => {
    location.hash = `#${slideId}`;
  }, id);
  await page.waitForFunction(
    (slideId) => {
      const el = document.getElementById(slideId);
      return el !== null && getComputedStyle(el).display !== 'none';
    },
    id,
    { timeout: VIEW_TIMEOUT_MS },
  );
}

function recordsFrom(view, axeResult) {
  const records = [];
  const push = (kind, issues) => {
    for (const issue of issues) {
      for (const node of issue.nodes) {
        records.push({
          view,
          kind,
          ruleId: issue.id,
          impact: issue.impact ?? '',
          helpUrl: issue.helpUrl ?? '',
          target: node.target.join(' '),
          detail: (node.failureSummary ?? '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .join(' '),
        });
      }
    }
  };
  // Violations fail the gate. Incomplete items are surfaced for review (axe could
  // not decide, for example contrast over a gradient) but do not fail on their
  // own, so an "undecidable" is never silently treated as a pass.
  push('violation', axeResult.violations);
  push('incomplete', axeResult.incomplete);
  return records;
}

// Scan the page currently loaded in `page`. Exported so a test can plant a
// fixture with a known defect and confirm the gate actually catches it.
async function collectViolations(page) {
  const viewIds = await page.$$eval('.slide[id]', (els) => els.map((el) => el.id));
  const records = [];
  if (viewIds.length > 0) {
    for (const id of viewIds) {
      await showView(page, id);
      const axeResult = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze();
      records.push(...recordsFrom(id, axeResult));
    }
  } else {
    const axeResult = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze();
    records.push(...recordsFrom('(page)', axeResult));
  }
  return records;
}

async function scanFile(browser, root, file) {
  const rel = relative(root, file).split('\\').join('/');
  const context = await browser.newContext({
    bypassCSP: true,
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  try {
    await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
    const records = await collectViolations(page);
    return records.map((record) => ({ file: rel, ...record }));
  } finally {
    await context.close();
  }
}

async function scanDocs(root) {
  const files = await findHtmlDocs(root);
  const browser = await chromium.launch({ headless: true });
  const records = [];
  let viewCount = 0;
  try {
    for (const file of files) {
      const fileRecords = await scanFile(browser, root, file);
      records.push(...fileRecords);
      viewCount += new Set(fileRecords.map((record) => record.view)).size || 1;
    }
  } finally {
    await browser.close();
  }
  return { files, records, viewCount };
}

function report(files, records) {
  const violations = records.filter((record) => record.kind === 'violation');
  const incomplete = records.filter((record) => record.kind === 'incomplete');

  const write = (line) => process.stdout.write(`${line}\n`);

  // Confirmed WCAG A/AA failures, printed in full. These fail the gate.
  if (violations.length > 0) {
    write('WCAG A/AA violations:');
    for (const record of violations) {
      write(`  ${record.file} [${record.view}] ${record.ruleId} (${record.impact || 'n/a'}): ${record.target}`);
      if (record.detail) write(`      ${record.detail}`);
      if (record.helpUrl) write(`      ${record.helpUrl}`);
    }
  }

  // Undecidable items, summarized per file and rule so they stay disclosed
  // without burying the failures above. axe returns these when it cannot resolve
  // an effective background (SVG text, or text over a decorative gradient); they
  // are not confirmed failures and do not fail the gate, but they are never
  // silently dropped. Set USABL_A11Y_VERBOSE=1 to list every node.
  if (incomplete.length > 0) {
    write('');
    write('Needs review (axe could not decide; not counted as failures):');
    const byFile = new Map();
    for (const record of incomplete) {
      if (!byFile.has(record.file)) byFile.set(record.file, new Map());
      const rules = byFile.get(record.file);
      rules.set(record.ruleId, (rules.get(record.ruleId) ?? 0) + 1);
    }
    for (const [file, rules] of byFile) {
      const parts = [...rules].map(([rule, count]) => `${rule} x${count}`).join(', ');
      write(`  ${file}: ${parts}`);
    }
    if (process.env.USABL_A11Y_VERBOSE === '1') {
      write('');
      for (const record of incomplete) {
        write(`  ${record.file} [${record.view}] ${record.ruleId}: ${record.target}`);
      }
    }
  }

  write('');
  write(
    `Scanned ${files.length} HTML doc(s): ${violations.length} WCAG A/AA violation(s), ` +
      `${incomplete.length} needs-review.`,
  );
  return violations.length;
}

async function main() {
  const root = resolve(process.argv[2] ?? process.cwd());
  const { files, records } = await scanDocs(root);
  const violationCount = report(files, records);
  process.exit(violationCount > 0 ? 1 : 0);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`check-docs-a11y failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  });
}

export { collectViolations, findHtmlDocs, scanDocs, WCAG_AA_TAGS };

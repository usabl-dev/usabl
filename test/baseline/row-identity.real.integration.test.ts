/**
 * Real Chromium: row keys that must never let two rows, or two tables, share one identity.
 *
 * Gated behind USABL_INTEGRATION=1 like the other browser tests, because it launches Chromium.
 *
 * Each case is a swap: a baseline over one page, then a run over the same page with one barrier
 * fixed in one row and the same barrier added in another. Two rows with one identity would leave
 * the count where it was and the run verified. A run must never be verified here: it is a
 * regression when the two rows can be told apart, and a not-covered gap that names the screen and
 * the rule when they cannot.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import type { Deps, Result, UsablConfig } from '../../src/contracts/index.js';
import { runBaseline } from '../../src/baseline/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeRealBrowserDriver } from '../../src/deps/real.js';
import { makeCheckRunner } from '../../src/providers/check-runner.js';
import { makeCoreProviders } from '../../src/providers/core-stack.js';
import { makeStepRunner } from '../../src/providers/keyboard-walk/steps.js';
import { run } from '../../src/run.js';
import { checkPage } from '../../src/surfaces/playwright-helper.js';

const BROKEN = '<button type="button"><svg aria-hidden="true" width="12" height="12"></svg></button>';
const NAMED = '<button type="button" aria-label="Open actions">Actions</button>';

function page(body: string): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Rows</title></head>
  <body><main><h1>Rows</h1>${body}</main></body>
</html>`;
}

function table(rows: string, attrs = '', caption = ''): string {
  return `<table${attrs}>${caption === '' ? '' : `<caption>${caption}</caption>`}<thead><tr><th scope="col">Name</th><th scope="col">Actions</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const keyedRow = (key: string, broken: boolean): string =>
  `<tr data-row-key="${key}"><td>job</td><td>${broken ? BROKEN : NAMED}</td></tr>`;
const headerRow = (name: string, broken: boolean): string =>
  `<tr><th scope="row">${name}</th><td>${broken ? BROKEN : NAMED}</td></tr>`;

interface Fixture {
  origin: string;
  set(path: string, html: string): string;
  close(): Promise<void>;
}

function makeServer(): Promise<Fixture> {
  const pages = new Map<string, string>();
  const server: Server = createServer((req, res) => {
    // The query string is not part of the page's name, so a test can load a page with one.
    const html = pages.get((req.url ?? '').split('?')[0] ?? '');
    if (html === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const origin = `http://127.0.0.1:${port}`;
      resolve({
        origin,
        set: (path, html) => {
          pages.set(path, html);
          return `${origin}${path}`;
        },
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

const PAGE_FILE = 'src/RowsPage.tsx';

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('row identity edge cases on real Chromium', () => {
  let fixture: Fixture;
  const driver = makeRealBrowserDriver({ readyTimeoutMs: 20_000 });

  beforeAll(async () => {
    fixture = await makeServer();
  });

  afterAll(async () => {
    await driver.close();
    await fixture.close();
  });

  function configFor(url: string): UsablConfig {
    return {
      appBaseUrl: fixture.origin,
      uiFileGlobs: ['src/**'],
      discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
      surfaces: [{ id: 'rows', url, files: [PAGE_FILE] }],
      guardedPaths: ['usabl.config.json'],
    };
  }

  function depsFor(config: UsablConfig, floorJson: string | null): Deps {
    const files: Record<string, string> = { 'usabl.config.json': '{}', [PAGE_FILE]: 'export {};\n' };
    if (floorJson !== null) files['.usabl-evidence.json'] = floorJson;
    const base = makeFakeDeps({ files, headContents: files, writeTree: 'tree-rows', changed: [{ code: 'M', path: PAGE_FILE }] });
    return {
      ...base,
      checkRunner: makeCheckRunner({
        browser: driver,
        providers: makeCoreProviders({ keyboardWalk: false }),
        config,
        allowedCapabilities: ['live'],
        stepRunner: makeStepRunner(),
        transcriptTabCap: 8,
      }),
    };
  }

  /** A baseline over `before`, then a run over `after` at the same address. */
  async function swap(path: string, before: string, after: string): Promise<{ baselineFloor: string | null; baselineExit: number; result: Result }> {
    const url = fixture.set(path, page(before));
    const config = configFor(url);
    let floorJson: string | null = null;
    const outcome = await runBaseline(depsFor(config, null), config, {
      writeFile: async (_path, contents) => {
        floorJson = contents;
      },
    });
    fixture.set(path, page(after));
    const result = await run(depsFor(config, floorJson), config);
    return { baselineFloor: floorJson, baselineExit: outcome.exitCode, result };
  }

  it('keeps row keys that differ only in case apart', async () => {
    const out = await swap(
      '/case',
      table(keyedRow('Job-A', true) + keyedRow('job-a', false)),
      table(keyedRow('Job-A', false) + keyedRow('job-a', true)),
    );
    expect(out.baselineExit).toBe(0);
    expect(out.result.verdict).toBe('regression');
  }, 120_000);

  it('keeps long row keys that share a long prefix apart', async () => {
    const prefix = 'k'.repeat(5000);
    const out = await swap(
      '/prefix',
      table(keyedRow(`${prefix}A`, true) + keyedRow(`${prefix}B`, false)),
      table(keyedRow(`${prefix}A`, false) + keyedRow(`${prefix}B`, true)),
    );
    expect(out.baselineExit).toBe(0);
    expect(out.result.verdict).toBe('regression');
    expect(out.baselineFloor).not.toContain(prefix);
  }, 120_000);

  it('never verifies a swap between two rows with the same row header, and names the screen and rule', async () => {
    const out = await swap(
      '/dup-header',
      table(headerRow('Alice', true) + headerRow('Alice', false)),
      table(headerRow('Alice', false) + headerRow('Alice', true)),
    );
    // Two rows nobody can tell apart are not keyed, so the baseline will not accept them.
    expect(out.baselineExit).toBe(3);
    expect(out.result.verdict).not.toBe('verified');
    expect(out.result.verdict).toBe('not_covered');
    const gap = out.result.coverage.gaps.find((g) => g.reason.includes('rule button-name'));
    expect(gap?.reason).toContain('screen rows');
    expect(gap?.reason).not.toContain('Alice');
  }, 120_000);

  it('never verifies a barrier moved between two sibling tables that cannot be told apart', async () => {
    const out = await swap(
      '/siblings',
      table(headerRow('Alice', true)) + table(headerRow('Alice', false)),
      table(headerRow('Alice', false)) + table(headerRow('Alice', true)),
    );
    expect(out.result.verdict).toBe('not_covered');
    expect(out.result.coverage.gaps.some((g) => g.reason.includes('rule button-name'))).toBe(true);
  }, 120_000);

  it('blocks a barrier moved between two sibling tables that have their own captions', async () => {
    const out = await swap(
      '/captioned',
      table(headerRow('Alice', true), '', 'Team one') + table(headerRow('Alice', false), '', 'Team two'),
      table(headerRow('Alice', false), '', 'Team one') + table(headerRow('Alice', true), '', 'Team two'),
    );
    expect(out.baselineExit).toBe(0);
    expect(out.result.verdict).toBe('regression');
  }, 120_000);

  it('keeps an outer row key when a row is added to a table nested in another row', async () => {
    const inner = (rows: string) => `<table aria-label="Steps"><tbody>${rows}</tbody></table>`;
    // The outer rows are keyed by data-row-key. A nested row holding the same key value is not one
    // of the outer table's rows, so it does not make the outer key a duplicate.
    const outer = (innerRows: string) =>
      table(
        `<tr data-row-key="r1"><td>${inner(innerRows)}</td><td>${BROKEN}</td></tr>` +
          `<tr data-row-key="r2"><td>plain</td><td>${NAMED}</td></tr>`,
        ' id="jobs"',
      );
    const out = await swap(
      '/nested',
      outer('<tr data-row-key="s1"><td>one</td></tr>'),
      outer('<tr data-row-key="s1"><td>one</td></tr><tr data-row-key="r1"><td>two</td></tr>'),
    );
    expect(out.baselineExit).toBe(0);
    expect(out.result.verdict).toBe('verified');
    expect(out.result.findings.filter((f) => f.status === 'new')).toEqual([]);
  }, 120_000);

  it('never writes a container id that holds page text into the floor, the receipt, or the Result', async () => {
    const secret = 'customer-private-name';
    const nested = table(
      `<tr id="${secret}"><td><table aria-label="Hosts"><tbody>` +
        `<tr data-row-key="h1"><td>one</td><td>${BROKEN}</td></tr>` +
        `<tr data-row-key="h2"><td>two</td><td>${NAMED}</td></tr>` +
        '</tbody></table></td></tr>',
    );
    const out = await swap('/private', nested, nested);
    expect(out.baselineExit).toBe(0);
    expect(out.baselineFloor).not.toBeNull();
    expect(out.baselineFloor).not.toContain(secret);
    expect(out.result.verdict).toBe('verified');
    expect(JSON.stringify(out.result.receipt)).not.toContain(secret);
    // The identity a finding carries, its element key and its row scope, holds no page text. The
    // element path is the scanner's selector, which tells a developer where the element is; it is
    // printed only through the scrubber and is not part of the identity.
    expect(JSON.stringify(out.result.findings.map((f) => [f.elementKey, f.evidence.extra?.['rowScope'] ?? null]))).not.toContain(secret);
    // The barrier itself was found and keyed by row, so the check above is not vacuous.
    expect(out.result.findings.some((f) => f.identityBasis === 'row' && f.rule === 'button-name')).toBe(true);
  }, 120_000);

  it('returns no query string, fragment, or credential from checkPage, in gap refs or anywhere else', async () => {
    const dupRows = table(keyedRow('same', true) + keyedRow('same', true));
    fixture.set('/page-check', page(dupRows));
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const pw = await context.newPage();
      await pw.goto(`${fixture.origin}/page-check?token=SECRETPOISON#FRAGPOISON`);
      const result = await checkPage(pw, { keyboardWalk: false });
      const text = JSON.stringify(result);
      // Not vacuous: the duplicate rows raise a gap whose ref is the page address.
      expect(result.gaps.some((g) => g.ref.includes('/page-check'))).toBe(true);
      expect(text).not.toContain('SECRETPOISON');
      expect(text).not.toContain('FRAGPOISON');
      await context.close();
    } finally {
      await browser.close();
    }
  }, 120_000);
});


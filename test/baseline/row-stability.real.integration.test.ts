/**
 * Real Chromium: a table whose rows change between loads, from baseline through ten later runs.
 *
 * Gated behind USABL_INTEGRATION=1 like the other browser tests, because it launches Chromium.
 *
 * The page lists jobs. Each row has a row header with the job name and an actions button. In the
 * broken rows the button is an unnamed icon, which axe reports as button-name. The rows change on
 * every load, the way a live list does:
 *   - load 1, the first baseline scan, also shows a broken row, delta, that never comes back;
 *   - load 2, the second baseline scan, shows only the three broken core rows;
 *   - every later load drops charlie on some loads, adds one or two rows whose buttons are named,
 *     and reverses the order on others, so the row count runs from two to five.
 *
 * Before row keys, every unnamed button on the screen shared one identity whose count followed the
 * rows. A one-scan baseline that saw delta would record four, and every later run would show
 * headroom a new barrier could fill. Now each row keys on its own, baseline records the three rows
 * both scans saw, lists delta as intermittent, and ten later runs on the same tree give one verdict.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Deps, UsablConfig } from '../../src/contracts/index.js';
import { runBaseline } from '../../src/baseline/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeRealBrowserDriver } from '../../src/deps/real.js';
import { parseEvidenceFloor } from '../../src/evidence/floor.js';
import { makeCheckRunner } from '../../src/providers/check-runner.js';
import { makeCoreProviders } from '../../src/providers/core-stack.js';
import { makeStepRunner } from '../../src/providers/keyboard-walk/steps.js';
import { run } from '../../src/run.js';

interface Row {
  name: string;
  broken: boolean;
}

const ALPHA: Row = { name: 'nightly-backup alpha', broken: true };
const BRAVO: Row = { name: 'nightly-backup bravo', broken: true };
const CHARLIE: Row = { name: 'nightly-backup charlie', broken: true };
const DELTA: Row = { name: 'nightly-backup delta', broken: true };
const ECHO: Row = { name: 'report echo', broken: false };
const FOXTROT: Row = { name: 'report foxtrot', broken: false };

/** The rows the page shows on its nth load, counting from zero. */
function rowsForLoad(load: number): Row[] {
  if (load === 0) return [ALPHA, BRAVO, CHARLIE, DELTA];
  if (load === 1) return [ALPHA, BRAVO, CHARLIE];
  const rows = [ALPHA, BRAVO];
  if (load % 3 !== 0) rows.push(CHARLIE);
  if (load % 2 === 0) rows.push(ECHO);
  if (load % 4 === 0) rows.push(FOXTROT);
  return load % 2 === 1 ? rows.reverse() : rows;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function rowHtml(row: Row): string {
  const name = escapeHtml(row.name);
  const button = row.broken
    ? '<button type="button" class="kebab"><svg aria-hidden="true" width="12" height="12"><circle cx="6" cy="6" r="2"></circle></svg></button>'
    : `<button type="button" aria-label="Actions for ${name}">Actions</button>`;
  return `<tr><th scope="row">${name}</th><td>Running</td><td>${button}</td></tr>`;
}

function pageHtml(rows: Row[]): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Jobs</title></head>
  <body>
    <main>
      <h1>Jobs</h1>
      <table>
        <caption>Scheduled jobs</caption>
        <thead><tr><th scope="col">Name</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
        <tbody>${rows.map(rowHtml).join('')}</tbody>
      </table>
    </main>
  </body>
</html>`;
}

interface Fixture {
  url: string;
  loads: () => number;
  close: () => Promise<void>;
}

// Rows keyed each way rowContext reads, and rows it must not key.
const ROW_SHAPES_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Rows</title></head>
  <body>
    <main>
      <table id="hosts">
        <thead><tr><th scope="col">Host</th><th scope="col"><button id="sort" type="button">Sort</button></th></tr></thead>
        <tbody>
          <tr data-row-key="host-17"><td>db-1.example.com</td><td><span><button id="by-attr" type="button"></button></span></td></tr>
          <tr data-row-key="same"><td>web-1.example.com</td><td><button id="dup-a" type="button"></button></td></tr>
          <tr data-row-key="same"><td>web-2.example.com</td><td><button id="dup-b" type="button"></button></td></tr>
          <tr><td>no key here</td><td><a id="no-key" href="#x"></a></td></tr>
        </tbody>
      </table>
      <table aria-label="Services">
        <tbody>
          <tr id="pf-random-id-:r4:"><th>web-1.example.com</th><td><button id="by-header" type="button"></button></td></tr>
          <tr><td>plain</td><td>no header</td></tr>
        </tbody>
      </table>
      <table aria-label="Plain">
        <tbody><tr><td>one</td><td><button id="plain-table" type="button"></button></td></tr></tbody>
      </table>
      <div role="grid" aria-label="Users">
        <div role="row" data-ouia-component-id="OUIA-Generated-Row-3">
          <div role="rowheader">Ada Lovelace</div><div role="gridcell"><div role="menuitem" id="grid-item" tabindex="0">Edit</div></div>
        </div>
      </div>
      <p><button id="outside" type="button">Not in a row</button></p>
    </main>
  </body>
</html>`;

function makeServer(): Promise<Fixture> {
  let loads = 0;
  const server: Server = createServer((req, res) => {
    if (req.url === '/rows') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(ROW_SHAPES_HTML);
      return;
    }
    if (req.url !== '/jobs') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const rows = rowsForLoad(loads);
    loads += 1;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(pageHtml(rows));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/jobs`,
        loads: () => loads,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

const PAGE_FILE = 'src/JobsPage.tsx';

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('row keys and the baseline stability pass on real Chromium', () => {
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
      appBaseUrl: new URL(url).origin,
      uiFileGlobs: ['src/**'],
      discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
      surfaces: [{ id: 'jobs', url, files: [PAGE_FILE] }],
      guardedPaths: ['usabl.config.json'],
    };
  }

  function depsFor(config: UsablConfig, floorJson: string | null): Deps {
    const files: Record<string, string> = { 'usabl.config.json': '{}', [PAGE_FILE]: 'export {};\n' };
    if (floorJson !== null) files['.usabl-evidence.json'] = floorJson;
    const base = makeFakeDeps({
      files,
      headContents: files,
      writeTree: 'tree-unchanged',
      changed: [{ code: 'M', path: PAGE_FILE }],
    });
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

  it('records the rows both scans saw, lists the one that came and went, and gives ten later runs one verdict', async () => {
    const config = configFor(fixture.url);
    const writes = new Map<string, string>();

    const outcome = await runBaseline(depsFor(config, null), config, {
      writeFile: async (path, contents) => {
        writes.set(path, contents);
      },
    });

    expect(fixture.loads()).toBe(2);
    expect(outcome.exitCode).toBe(0);
    const floorJson = writes.get('.usabl-evidence.json') ?? '';
    const floor = parseEvidenceFloor(JSON.parse(floorJson));
    expect(floor.version).toBe(3);
    const buttonEntries = floor.entries.filter((entry) => entry.rule === 'button-name');
    // Three broken rows both scans saw, each its own identity with a count of one.
    expect(buttonEntries).toHaveLength(3);
    expect(buttonEntries.every((entry) => entry.identityBasis === 'row' && entry.count === 1)).toBe(true);
    // Delta came and went, so it is listed by screen and rule and not recorded.
    expect(outcome.message).toContain('screen jobs, rule button-name: 1');
    // No row text reaches the floor or the report.
    expect(floorJson).not.toContain('nightly');
    expect(floorJson).not.toContain('alpha');
    expect(outcome.message).not.toContain('nightly');

    const verdicts: Array<string | null> = [];
    const rowCounts = new Set<number>();
    for (let index = 0; index < 10; index += 1) {
      rowCounts.add(rowsForLoad(fixture.loads()).length);
      const result = await run(depsFor(config, floorJson), config);
      verdicts.push(result.verdict);
      expect(result.findings.filter((finding) => finding.status === 'new')).toEqual([]);
    }

    // The row count really did change across the ten runs.
    expect(rowCounts.size).toBeGreaterThan(1);
    expect(new Set(verdicts)).toEqual(new Set(['verified']));
  }, 240_000);

  it('reads the row an element sits in from a key attribute or a row header, and nothing else', async () => {
    const page = await driver.open(fixture.url.replace('/jobs', '/rows'));
    try {
      await page.gotoReady();

      // A key attribute held by one row only. The table is named by its id, never by its place.
      const byAttr = await page.rowContext('#by-attr');
      expect(byAttr).toMatchObject({ kind: 'keyed', source: 'attr:data-row-key', key: 'host-17', role: 'button', path: 'td:nth-child(2) > span:nth-child(1) > button:nth-child(1)' });
      expect(byAttr.kind === 'keyed' ? byAttr.table : null).toBe('[["attr:id","hosts"]]');

      // The table keys its rows by data-row-key, so a key two rows share, or a row without one,
      // cannot be told apart. That is not the same as outside a row.
      expect(await page.rowContext('#dup-a')).toEqual({ kind: 'ambiguous', reason: 'row-key-duplicate' });
      expect(await page.rowContext('#no-key')).toEqual({ kind: 'ambiguous', reason: 'row-key-missing' });

      // A generated id is not a key, so this table keys its rows by row header. The table is named
      // by its accessible name.
      const byHeader = await page.rowContext('#by-header');
      expect(byHeader).toMatchObject({ kind: 'keyed', source: 'header', key: 'web-1.example.com', role: 'button', path: 'td:nth-child(2) > button:nth-child(1)' });

      // A table none of whose rows has a key keys nothing, so its controls key as they did before.
      expect(await page.rowContext('#plain-table')).toEqual({ kind: 'none' });
      // A header row is not a body row.
      expect(await page.rowContext('#sort')).toEqual({ kind: 'none' });
      // Not in a row at all.
      expect(await page.rowContext('#outside')).toEqual({ kind: 'none' });

      // An ARIA grid row with a generated OUIA id falls back to its row header, and an explicit
      // role wins over the tag.
      const grid = await page.rowContext('#grid-item');
      expect(grid).toMatchObject({ kind: 'keyed', source: 'header', key: 'Ada Lovelace', role: 'menuitem' });
    } finally {
      await page.close();
    }
  }, 60_000);
});

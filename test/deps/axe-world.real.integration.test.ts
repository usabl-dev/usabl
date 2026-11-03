/**
 * Real Chromium: axe runs in usabl's isolated world, so page script cannot change what it reports,
 * and a frame axe cannot check is a gap rather than a silent drop.
 *
 * Gated behind USABL_INTEGRATION=1 like the other browser tests, because it launches Chromium.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import type { Deps, Page, UsablConfig } from '../../src/contracts/index.js';
import { runBaseline } from '../../src/baseline/index.js';
import { internalsRecord, runAxeInIsolatedWorld } from '../../src/deps/axe-world.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeRealBrowserDriver } from '../../src/deps/real.js';
import { makeCheckRunner } from '../../src/providers/check-runner.js';
import { axeProvider, type AxeRunResult } from '../../src/providers/axe/index.js';
import { makeStepRunner } from '../../src/providers/keyboard-walk/steps.js';
import { run } from '../../src/run.js';
import { STATE_CASES, STATE_GROUPS, X_ARIA_SCRIPT, stateGroupBody, type TreeStates } from '../support/internals-states.js';

const BUDGET_MS = 180_000;
const PAGE_FILE = 'src/RowsPage.tsx';

function page(body: string, headScript = ''): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Rows</title>${headScript === '' ? '' : `<script>${headScript}</script>`}</head>
  <body><main><h1>Rows</h1>${body}</main></body>
</html>`;
}

const UNNAMED = (id: string): string =>
  `<button id="${id}" type="button"><svg aria-hidden="true" width="12" height="12"></svg></button>`;
const NAMED = (id: string, name: string): string => `<button id="${id}" type="button" aria-label="${name}">Open</button>`;

// Two keyed rows. Each row's button is either unnamed or has a name of its own.
function rows(aBroken: boolean, bBroken: boolean): string {
  const cell = (key: string, broken: boolean): string =>
    broken ? UNNAMED(`btn-${key}`) : NAMED(`btn-${key}`, `Open job ${key}`);
  return (
    '<table id="jobs"><thead><tr><th scope="col">Name</th><th scope="col">Actions</th></tr></thead><tbody>' +
    `<tr data-row-key="a"><td>job a</td><td>${cell('a', aBroken)}</td></tr>` +
    `<tr data-row-key="b"><td>job b</td><td>${cell('b', bBroken)}</td></tr>` +
    '</tbody></table>'
  );
}

// Page script that makes the id of btn-b read as btn-a, to every caller in the page's world.
const ID_PATCH =
  'const read = Element.prototype.getAttribute;' +
  'Element.prototype.getAttribute = function (name) {' +
  '  const value = read.call(this, name);' +
  '  return name === "id" && value === "btn-b" ? "btn-a" : value;' +
  '};';

// Page script that answers for axe: whatever is loaded as window.axe, the page hands back its own
// object, which reports a clean page.
const FAKE_AXE =
  'const clean = { violations: [], incomplete: [], passes: [], inapplicable: [] };' +
  'const fake = {' +
  '  run: async () => clean,' +
  '  runPartial: async () => ({ results: [], frames: [], environmentData: {} }),' +
  '  finishRun: async () => clean,' +
  '  configure: () => undefined,' +
  '  utils: { getFrameContexts: () => [], shadowSelect: () => null },' +
  '};' +
  'Object.defineProperty(window, "axe", { configurable: false, get: () => fake, set: () => undefined });';

interface Fixture {
  origin: string;
  other: string;
  set(path: string, html: string): string;
  close(): Promise<void>;
}

function makeServer(): Promise<Fixture> {
  const pages = new Map<string, string>();
  const server: Server = createServer((req, res) => {
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
        other: `http://localhost:${port}`,
        set: (path, html) => {
          pages.set(path, html);
          return `${origin}${path}`;
        },
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function runAxeOn(p: Page): Promise<AxeRunResult> {
  return (p as Page & { runAxe: () => Promise<AxeRunResult> }).runAxe();
}

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('axe in an isolated world on real Chromium', () => {
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
      surfaces: [{ id: 'rows', url, files: [PAGE_FILE], reachedWhen: { selector: '#jobs' } }],
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
        providers: [axeProvider],
        config,
        allowedCapabilities: ['live'],
        stepRunner: makeStepRunner(),
        transcriptTabCap: 4,
      }),
    };
  }

  it(
    'names each unnamed button by its own id when page script makes one id read as another',
    async () => {
      const url = fixture.set('/patched-id', page(rows(true, true), ID_PATCH));
      const p = await driver.open(url);
      try {
        await p.gotoReady();
        const result = await runAxeOn(p);
        const targets = result.violations.filter((issue) => issue.id === 'button-name').flatMap((issue) => issue.nodes.map((node) => node.target));
        expect(targets.sort()).toEqual([['#btn-a'], ['#btn-b']]);
      } finally {
        await p.close();
      }
    },
    BUDGET_MS,
  );

  it(
    'never verifies a barrier moved to another row on a page that makes one id read as another',
    async () => {
      // The baseline accepts the unnamed button in row a. Then row a is fixed, row b breaks, and the
      // page makes btn-b read as btn-a. Read through the page, the new barrier is named #btn-a and
      // keyed to row a, so it reads as the barrier the floor already accepted.
      const url = fixture.set('/moved', page(rows(true, false)));
      const config = configFor(url);
      let floorJson: string | null = null;
      const baseline = await runBaseline(depsFor(config, null), config, {
        writeFile: async (_path, contents) => {
          floorJson = contents;
        },
      });
      expect(baseline.exitCode).toBe(0);
      fixture.set('/moved', page(rows(false, true), ID_PATCH));
      const result = await run(depsFor(config, floorJson), config);
      expect(result.verdict).not.toBe('verified');
      expect(result.verdict).toBe('regression');
      expect(result.receipt).toBeNull();
    },
    BUDGET_MS,
  );

  it(
    'reports what axe finds when page script defines a window.axe that reports a clean page',
    async () => {
      const url = fixture.set('/fake-axe', page(rows(true, false), FAKE_AXE));
      const p = await driver.open(url);
      try {
        await p.gotoReady();
        const result = await runAxeOn(p);
        const buttonName = result.violations.find((issue) => issue.id === 'button-name');
        expect(buttonName?.nodes.map((node) => node.target)).toEqual([['#btn-a']]);
        expect(result.passes.length).toBeGreaterThan(0);
      } finally {
        await p.close();
      }
    },
    BUDGET_MS,
  );

  it(
    'discloses a frame axe cannot run in as a gap that names only its origin',
    async () => {
      fixture.set('/inner', page(UNNAMED('inner-button')));
      const url = fixture.set(
        '/sandboxed',
        page(`${NAMED('outer', 'Open')}<iframe title="Report" sandbox="" src="/inner?token=abc123"></iframe>`),
      );
      const runner = makeCheckRunner({
        browser: driver,
        providers: [axeProvider],
        config: configFor(url),
        allowedCapabilities: ['live'],
        stepRunner: makeStepRunner(),
        transcriptTabCap: 2,
      });
      const scan = await runner.scan({ id: 'sandboxed', url });
      const frameGaps = scan.gaps.filter((gap) => gap.reason.includes('could not check a frame'));
      expect(frameGaps).toEqual([
        {
          ref: 'provider:axe-core',
          state: 'not-covered',
          reason:
            `provider axe-core could not check a frame from ${fixture.origin}: it is sandboxed without scripts, ` +
            'so axe cannot run in it. Its findings are not in this result.',
        },
      ]);
      expect(JSON.stringify(scan.gaps)).not.toContain('token');
      expect(JSON.stringify(scan.gaps)).not.toContain('/inner');
    },
    BUDGET_MS,
  );

  describe('frames in other processes', () => {
    let browser: Browser;

    beforeAll(async () => {
      // Every cross-site frame in a process of its own, the way a caller's browser may run.
      browser = await chromium.launch({ headless: true, args: ['--site-per-process'] });
    });

    afterAll(async () => {
      await browser?.close();
    });

    it(
      'checks a frame in another process and names its elements through the frame',
      async () => {
        fixture.set('/other-inner', page(UNNAMED('far-button')));
        const url = fixture.set('/other', page(`<iframe id="far" title="Far" src="${fixture.other}/other-inner"></iframe>`));
        const context = await browser.newContext();
        try {
          const pw = await context.newPage();
          await pw.goto(url, { waitUntil: 'load' });
          const cdp = await context.newCDPSession(pw);
          const result = await runAxeInIsolatedWorld(pw, cdp, {});
          const violations = (result.results as { violations: Array<{ id: string; nodes: Array<{ target: unknown }> }> }).violations;
          expect(violations.find((issue) => issue.id === 'button-name')?.nodes.map((node) => node.target)).toEqual([
            ['#far', '#far-button'],
          ]);
          expect(result.uncheckedFrames).toEqual([]);
        } finally {
          await context.close();
        }
      },
      BUDGET_MS,
    );

    it(
      'discloses a frame that stops answering, and keeps the findings of the rest of the page',
      async () => {
        // The frame's process is busy forever once it has loaded, so loading axe there never ends.
        fixture.set('/busy', page(UNNAMED('busy-button'), 'addEventListener("load", () => setTimeout(() => { for (;;) {} }, 200));'));
        const url = fixture.set('/busy-top', page(`${UNNAMED('top-button')}<iframe title="Busy" src="${fixture.other}/busy?session=s1"></iframe>`));
        const context = await browser.newContext();
        try {
          const pw = await context.newPage();
          await pw.goto(url, { waitUntil: 'load' });
          await pw.waitForTimeout(1_000);
          const cdp = await context.newCDPSession(pw);
          const result = await runAxeInIsolatedWorld(pw, cdp, {}, { stepTimeoutMs: 3_000 });
          expect(result.uncheckedFrames).toHaveLength(1);
          expect(result.uncheckedFrames[0]?.origin).toBe(fixture.other);
          expect(result.uncheckedFrames[0]?.why).toMatch(/ took longer than 3000 ms$/);
          const violations = (result.results as { violations: Array<{ id: string; nodes: Array<{ target: unknown }> }> }).violations;
          expect(violations.find((issue) => issue.id === 'button-name')?.nodes.map((node) => node.target)).toEqual([['#top-button']]);
        } finally {
          await context.close();
        }
      },
      BUDGET_MS,
    );
  });

  describe('ARIA states set through ElementInternals', () => {
    let browser: Browser;

    beforeAll(async () => {
      browser = await chromium.launch({ headless: true });
    });

    afterAll(async () => {
      await browser?.close();
    });

    // What the tree reports for one element, and what internalsRecord makes of it. The tree is
    // read the way the isolated run reads it: one full tree, matched to the element by backend id.
    async function readStates(url: string, ids: string[]): Promise<Record<string, { tree: TreeStates; record: unknown }>> {
      const context = await browser.newContext();
      try {
        const pw = await context.newPage();
        await pw.goto(url, { waitUntil: 'load' });
        const cdp = await context.newCDPSession(pw);
        const tree = await cdp.send('Accessibility.getFullAXTree');
        const document = await cdp.send('DOM.getDocument', { depth: 0 });
        const read: Record<string, { tree: TreeStates; record: unknown }> = {};
        for (const id of ids) {
          const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: `#${id}` });
          const { node } = await cdp.send('DOM.describeNode', { nodeId });
          const axNode = tree.nodes.find((entry) => entry.backendDOMNodeId === node.backendNodeId);
          const attributes = new Map<string, string>();
          const flat = node.attributes ?? [];
          for (let index = 0; index + 1 < flat.length; index += 2) attributes.set(flat[index] ?? '', flat[index + 1] ?? '');
          const states: TreeStates = {};
          const properties = axNode?.properties ?? [];
          for (const name of ['checked', 'expanded', 'level', 'valuemin', 'valuemax'] as const) {
            const property = properties.find((entry) => entry.name === name);
            if (property !== undefined) states[name] = property.value.value as unknown;
          }
          const value: unknown = axNode?.value?.value;
          if (value !== undefined) states.value = value;
          read[id] = { tree: states, record: internalsRecord(axNode, attributes) };
        }
        return read;
      } finally {
        await context.close();
      }
    }

    it(
      'reports the default each carried state assumes when the element sets none, and carries only set values',
      async () => {
        const measured: Record<string, { tree: TreeStates; record: unknown }> = {};
        for (const group of STATE_GROUPS) {
          const url = fixture.set(`/states-${group}`, page(stateGroupBody(group), X_ARIA_SCRIPT));
          const ids = STATE_CASES.filter((entry) => entry.group === group).map((entry) => entry.id);
          Object.assign(measured, await readStates(url, ids));
        }
        // For an element that sets no state, the tree's default is pinned exactly. For one that
        // sets a state, only what internalsRecord hands axe is pinned.
        const shown = Object.fromEntries(
          Object.entries(measured).map(([id, read]) => {
            const entry = STATE_CASES.find((candidate) => candidate.id === id);
            return [id, entry?.defaults === null ? { record: read.record } : read];
          }),
        );
        const expected = Object.fromEntries(
          STATE_CASES.map((entry) => [entry.id, entry.defaults === null ? { record: entry.record } : { tree: entry.defaults, record: entry.record }]),
        );
        expect(shown).toEqual(expected);
      },
      BUDGET_MS,
    );
  });
});

/**
 * The comparison harness for moving axe into an isolated world.
 *
 * It runs axe in the page's own world, the way usabl ran it before, and in usabl's isolated world,
 * over the fixture pages the tests use, with no page script that tampers with either run. For every
 * element axe reports it compares the result category, the rule id, the target selector, the
 * impact, and the usabl identity key. Every page without ElementInternals must compare equal, and
 * every frame must be checked. Pages whose custom elements set their semantics through
 * ElementInternals are measured and their differences are recorded exactly, so any change shows.
 *
 * Opt in with USABL_AXE_COMPARE=1. It launches Chromium twice, once with every cross-site frame in
 * a process of its own. Set USABL_AXE_COMPARE_OUT to a file path to write the per-page results, and
 * USABL_AXE_COMPARE_PROGRESS=1 to print each page as it is compared.
 *
 * Pages other tests build inline are compared by the sweep, which runs those tests with every axe
 * run doubled (vitest.axe-sweep.config.ts). scripts/axe-compare-summary.ts combines both into
 * test/deps/axe-world-compare.summary.json:
 *
 *   USABL_AXE_COMPARE=1 USABL_AXE_COMPARE_OUT=harness.json npx vitest run test/deps/axe-world-compare.harness.test.ts
 *   USABL_INTEGRATION=1 USABL_AXE_SWEEP_LOG=$PWD/sweep.jsonl npx vitest run --config vitest.axe-sweep.config.ts
 *   npx vite-node scripts/axe-compare-summary.ts -- --out test/deps/axe-world-compare.summary.json --sweep sweep.jsonl harness.json
 */
import { createServer, type Server } from 'node:http';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page as PwPage } from 'playwright';
import { DOCS_AXE_TAGS } from '../../src/providers/axe/index.js';
import { compareAxeWorlds, type Comparison, type Difference } from '../support/axe-worlds.js';

const ENABLED = process.env.USABL_AXE_COMPARE === '1';
const BUDGET_MS = 600_000;

function page(body: string, head = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title>${head}</head><body><main><h1>Fixture</h1>${body}</main></body></html>`;
}

const BROKEN = '<button type="button"><svg aria-hidden="true" width="12" height="12"></svg></button>';
const NAMED = '<button type="button" aria-label="Open actions">Actions</button>';
const table = (rows: string, attrs = '', caption = ''): string =>
  `<table${attrs}>${caption === '' ? '' : `<caption>${caption}</caption>`}<thead><tr><th scope="col">Name</th><th scope="col">Actions</th></tr></thead><tbody>${rows}</tbody></table>`;
const keyedRow = (key: string, broken: boolean): string =>
  `<tr data-row-key="${key}"><td>job</td><td>${broken ? BROKEN : NAMED}</td></tr>`;
const headerRow = (name: string, broken: boolean): string =>
  `<tr><th scope="row">${name}</th><td>${broken ? BROKEN : NAMED}</td></tr>`;

// A web component whose button lives in its shadow root, as the row identity tests use it.
const SHADOW_BUTTON =
  "<script>customElements.define('x-act', class extends HTMLElement { connectedCallback() {" +
  " const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });" +
  " root.innerHTML = this.hasAttribute('broken')" +
  " ? '<button type=\"button\"><svg aria-hidden=\"true\" width=\"12\" height=\"12\"></svg></button>'" +
  " : '<button type=\"button\" aria-label=\"Open actions\">Actions</button>'; } });</script>";
const shadowRow = (key: string, broken: boolean): string =>
  `<tr data-row-key="${key}"><td>job</td><td><x-act${broken ? ' broken' : ''}></x-act></td></tr>`;

// Custom elements that set their role and name through ElementInternals, the way design systems
// built on web components do.
const INTERNALS = `<script>
class Base extends HTMLElement { constructor() { super(); this._internals = this.attachInternals(); } }
customElements.define('x-li', class extends Base { connectedCallback() { this._internals.role = 'listitem'; } });
customElements.define('x-li-private', class extends HTMLElement { #i; constructor() { super(); this.#i = this.attachInternals(); this.#i.role = 'listitem'; } });
customElements.define('x-btn', class extends Base { connectedCallback() { this._internals.role = 'button'; if (this.hasAttribute('label')) this._internals.ariaLabel = this.getAttribute('label'); this.tabIndex = 0; } });
customElements.define('x-tablist', class extends Base { connectedCallback() { this._internals.role = 'tablist'; } });
customElements.define('x-tab', class extends Base { connectedCallback() { this._internals.role = 'tab'; this._internals.ariaSelected = this.hasAttribute('sel') ? 'true' : 'false'; } });
customElements.define('x-h', class extends Base { connectedCallback() { this._internals.role = 'heading'; this._internals.ariaLevel = '2'; } });
customElements.define('x-check', class extends Base { static formAssociated = true; connectedCallback() { this._internals.role = 'checkbox'; if (!this.hasAttribute('nostate')) this._internals.ariaChecked = 'true'; this.tabIndex = 0; } });
customElements.define('x-state', class extends Base { connectedCallback() { this._internals.ariaChecked = 'true'; this.tabIndex = 0; } });
customElements.define('x-img', class extends Base { connectedCallback() { this._internals.role = 'img'; } });
customElements.define('x-host', class extends HTMLElement { connectedCallback() { const r = this.attachShadow({ mode: 'open' }); r.innerHTML = '<div role="list"><x-li>a</x-li><x-li>b</x-li></div>'; } });
customElements.define('x-plain', class extends HTMLElement {});
</script>`;

interface Fixture {
  name: string;
  path: string;
  html?: string;
  // Measured against ElementInternals. Its differences are recorded, not required to be empty.
  internals?: boolean;
  // Load it in the browser that puts every cross-site frame in a process of its own.
  isolatedSites?: boolean;
  tags?: readonly string[];
  // The frames the isolated run is expected to report as unchecked, by reason. The page-world run
  // drops the same frames without saying so.
  unchecked?: string[];
  // A page that never stops changing has its own timers cleared before the comparison, so both
  // runs read the same DOM. This changes the page's input, never either axe run.
  freeze?: boolean;
}

interface Outcome {
  fixture: string;
  internals: boolean;
  counts: Comparison['counts'];
  differences: Difference[];
  uncheckedFrames: Comparison['isolated']['uncheckedFrames'];
  unstable: boolean;
}

const LIVE_DIR = fileURLToPath(new URL('../../fixtures/live/', import.meta.url));
const PF6 = fileURLToPath(new URL('../../fixtures/pf6/rendered-markup.html', import.meta.url));
const SHELLS = [
  fileURLToPath(new URL('../../fixtures/webpack-app/src/index.html', import.meta.url)),
  fileURLToPath(new URL('../../fixtures/init/pf-seed/src/index.html', import.meta.url)),
  fileURLToPath(new URL('../../fixtures/init/monorepo/packages/admin/index.html', import.meta.url)),
];

// Answers the data calls the live fixtures make, so each renders its screen rather than an error.
const API_ANSWERS: Record<string, string> = {
  '/api/data/orders': '["A-100","A-101","A-102"]',
  '/api/data/late-orders': '["A-100","A-101"]',
  '/spa/api/orders': '["A-100"]',
};

function serve(pages: Map<string, string>): Promise<{ origin: string; other: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const html = pages.get(path);
    if (html !== undefined) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (path.startsWith('/api/') || path.startsWith('/spa/api/') || path.startsWith('/wall/') || path === '/hang') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(API_ANSWERS[path] ?? '{}');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        other: `http://localhost:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

// Waits until the element count holds still for three seconds, within a bound. Three seconds
// outlasts the longest pause a live fixture takes before it mounts its content.
async function settle(pw: PwPage): Promise<void> {
  let last = -1;
  let same = 0;
  for (let tries = 0; tries < 80 && same < 12; tries += 1) {
    const count = await pw.evaluate(() => document.getElementsByTagName('*').length).catch(() => -1);
    same = count === last ? same + 1 : 0;
    last = count;
    await pw.waitForTimeout(250);
  }
}

function fixtures(other: string): Fixture[] {
  const list: Fixture[] = [];
  // Rows, the way the row identity tests build them.
  list.push(
    { name: 'rows: keyed rows', path: '/rows-keyed', html: page(table(keyedRow('r1', true) + keyedRow('r2', false) + keyedRow('r3', true), ' id="jobs"')) },
    { name: 'rows: row headers', path: '/rows-headers', html: page(table(headerRow('alpha', true) + headerRow('beta', true))) },
    { name: 'rows: keys that differ in case', path: '/rows-case', html: page(table(keyedRow('Job-A', true) + keyedRow('job-a', false))) },
    { name: 'rows: sibling tables with captions', path: '/rows-captions', html: page(table(keyedRow('r1', true), '', 'One') + table(keyedRow('r1', true), '', 'Two')) },
    {
      name: 'rows: nested table in a keyed row',
      path: '/rows-nested',
      html: page(table(`<tr data-row-key="outer"><td>job</td><td>${table(keyedRow('inner', true), ' id="inner"')}</td></tr>`, ' id="outer"')),
    },
    {
      name: 'rows: data table in a layout table',
      path: '/rows-layout',
      html: page(`<table role="presentation"><tbody><tr><td>${table(keyedRow('r1', true) + keyedRow('r2', false), ' id="jobs"')}</td><td>side</td></tr></tbody></table>`),
    },
    { name: 'rows: role grid', path: '/rows-grid', html: page(`<div role="grid" aria-label="Jobs"><div role="row" data-row-key="g1"><div role="gridcell">${BROKEN}</div></div><div role="row" data-row-key="g2"><div role="gridcell">${NAMED}</div></div></div>`) },
    { name: 'rows: buttons in shadow roots', path: '/rows-shadow', html: page('<p><button type="button">Add job</button></p>' + table(shadowRow('r1', true) + shadowRow('r2', false), ' id="jobs"'), SHADOW_BUTTON) },
    { name: 'rows: same-origin frame with rows', path: '/rows-frame', html: page('<iframe title="Jobs" src="/rows-keyed"></iframe>') },
    {
      name: 'rows: frames inside rows',
      path: '/rows-frame-cells',
      html: page(table('<tr data-row-key="r1"><td>job</td><td><iframe title="Actions r1" src="/cell-broken"></iframe></td></tr><tr data-row-key="r2"><td>job</td><td><iframe title="Actions r2" src="/cell-named"></iframe></td></tr>', ' id="jobs"')),
    },
    { name: 'cell: broken', path: '/cell-broken', html: page(BROKEN) },
    { name: 'cell: named', path: '/cell-named', html: page(NAMED) },
  );
  // Shadow DOM.
  list.push(
    {
      name: 'shadow: nested open roots with slots',
      path: '/shadow-nested',
      html: page(
        '<x-outer><span slot="label">Slotted</span><img src="a.png"></x-outer><x-closed></x-closed>',
        "<script>customElements.define('x-inner', class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<a href=\"#\"></a><input type=\"text\">'; } });" +
          "customElements.define('x-outer', class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<section><slot name=\"label\"></slot><slot></slot><x-inner></x-inner><button></button></section>'; } });" +
          "customElements.define('x-closed', class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: 'closed' }).innerHTML = '<button></button>'; } });</script>",
      ),
    },
    {
      name: 'shadow: frame inside a shadow root',
      path: '/shadow-frame',
      html: page('<div id="host"></div>', "<script>addEventListener('DOMContentLoaded', () => { document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<iframe title=\"Inner\" src=\"/frame-inner\"></iframe>'; });</script>"),
    },
  );
  // Frames.
  const frameInner = page('<button></button><img src="x.png"><a href="#"></a><input type="text"><div style="color:#777;background:#888">low contrast</div>');
  list.push(
    { name: 'frame: inner page', path: '/frame-inner', html: frameInner },
    { name: 'frame: nested inner page', path: '/frame-nested-inner', html: page('<button></button><iframe title="Deepest" src="/frame-inner"></iframe>') },
    { name: 'frame: same origin', path: '/frame-same', html: page('<button></button><iframe title="Same" src="/frame-inner"></iframe>') },
    { name: 'frame: cross origin', path: '/frame-cross', html: page(`<iframe title="Other" src="${other}/frame-inner"></iframe><iframe src="${other}/frame-inner"></iframe>`) },
    { name: 'frame: cross origin, own process', path: '/frame-cross', isolatedSites: true },
    { name: 'frame: three deep, mixed origins', path: '/frame-deep', html: page(`<iframe title="One" src="/frame-nested-inner"></iframe><iframe title="Two" src="${other}/frame-nested-inner"></iframe>`) },
    { name: 'frame: three deep, mixed origins, own process', path: '/frame-deep', isolatedSites: true },
    { name: 'frame: srcdoc and blank', path: '/frame-srcdoc', html: page(`<iframe title="Doc" srcdoc="<main><button></button></main>"></iframe><iframe title="Blank"></iframe>`) },
    {
      name: 'frame: sandboxed without scripts',
      path: '/frame-sandbox',
      html: page('<iframe title="Sandboxed" sandbox="" src="/frame-inner"></iframe><iframe title="Scripts" sandbox="allow-scripts" src="/frame-inner"></iframe>'),
      unchecked: ['it is sandboxed without scripts, so axe cannot run in it'],
    },
    { name: 'frame: hidden and lazy', path: '/frame-hidden', html: page('<iframe title="Hidden" style="display:none" src="/frame-inner"></iframe><div style="height:4000px"></div><iframe title="Lazy" loading="lazy" src="/frame-inner"></iframe>') },
    { name: 'frame: frameset', path: '/frameset', html: '<!doctype html><html lang="en"><head><title>Frames</title></head><frameset cols="50%,50%"><frame src="/frame-inner" title="Left"><frame src="/cell-broken"></frameset></html>' },
  );
  // Pages other tests build inline, where a sweep run could not record them. The gradient page
  // runs into its five second test budget when the sweep doubles its axe run.
  list.push({
    name: 'inline: gradient background',
    path: '/inline-gradient',
    html:
      '<!doctype html><html lang="en"><head><title>Gradient</title></head><body><main>' +
      '<button id="gradient" style="background: linear-gradient(90deg, #0066cc, #004080); color: #fff">Save</button>' +
      '<button id="flat" style="background: #fff; color: #999999">Cancel</button>' +
      '</main></body></html>',
  });
  // ElementInternals.
  list.push(
    { name: 'internals: listitem role in a list', path: '/int-list', internals: true, html: page('<div role="list"><x-li>One</x-li><x-li>Two</x-li></div>', INTERNALS) },
    { name: 'internals: role in a private field', path: '/int-private', internals: true, html: page('<div role="list"><x-li-private>One</x-li-private><x-li-private>Two</x-li-private></div>', INTERNALS) },
    { name: 'internals: buttons named and unnamed', path: '/int-buttons', internals: true, html: page('<x-btn label="Save">S</x-btn><x-btn></x-btn><button><x-btn label="Inner">i</x-btn></button>', INTERNALS) },
    { name: 'internals: tabs', path: '/int-tabs', internals: true, html: page('<x-tablist><x-tab sel>A</x-tab><x-tab>B</x-tab></x-tablist>', INTERNALS) },
    { name: 'internals: heading', path: '/int-heading', internals: true, html: page('<x-h>Section</x-h>', INTERNALS) },
    { name: 'internals: labelled checkbox', path: '/int-check', internals: true, html: page('<label for="c1">Agree</label><x-check id="c1"></x-check><label for="c2">Other</label><x-check id="c2" nostate></x-check>', INTERNALS) },
    { name: 'internals: state on a role attribute', path: '/int-state', internals: true, html: page('<x-state role="checkbox" aria-label="Agree"></x-state>', INTERNALS) },
    { name: 'internals: image role', path: '/int-img', internals: true, html: page('<x-img></x-img>', INTERNALS) },
    { name: 'internals: hidden items', path: '/int-hidden', internals: true, html: page('<div role="list"><x-li aria-hidden="true">One</x-li><x-li style="display:none">Two</x-li><x-li>Three</x-li></div>', INTERNALS) },
    { name: 'internals: role attribute over internals', path: '/int-role-attr', internals: true, html: page('<div role="list"><x-li role="presentation">One</x-li><x-li role="bogus">Two</x-li></div>', INTERNALS) },
    { name: 'internals: list in a shadow root', path: '/int-shadow', internals: true, html: page('<x-host></x-host>', INTERNALS) },
    { name: 'internals: custom elements without internals', path: '/int-none', internals: true, html: page('<x-plain>text</x-plain><div role="list"><x-plain>bad</x-plain></div><x-plain contenteditable>e</x-plain><x-plain tabindex="0" title="T">f</x-plain><ul><x-plain>a</x-plain><li>b</li></ul><div role="list"><x-nope>c</x-nope></div>', INTERNALS) },
  );
  return list;
}

describe.skipIf(!ENABLED)('axe in the page world and in the isolated world', () => {
  let browser: Browser;
  let siteBrowser: Browser;
  let server: Awaited<ReturnType<typeof serve>>;
  const pages = new Map<string, string>();
  const outcomes: Outcome[] = [];
  let list: Fixture[] = [];

  beforeAll(async () => {
    server = await serve(pages);
    list = fixtures(server.other);
    for (const name of (await readdir(LIVE_DIR)).filter((file) => file.endsWith('.html')).sort()) {
      list.push({
        name: `live: ${name}`,
        path: `/live/${name}`,
        html: await readFile(`${LIVE_DIR}${name}`, 'utf8'),
        ...(name === 'never-settles.html' ? { freeze: true } : {}),
      });
    }
    const pf6 = await readFile(PF6, 'utf8');
    list.push({ name: 'pf6: rendered markup', path: '/pf6', html: pf6 }, { name: 'pf6: rendered markup, docs tags', path: '/pf6', tags: DOCS_AXE_TAGS });
    list.push({ name: 'live: labelledby.html, docs tags', path: '/live/labelledby.html', tags: DOCS_AXE_TAGS });
    for (const [index, file] of SHELLS.entries()) {
      list.push({ name: `shell: ${file.split('/fixtures/')[1] ?? file}`, path: `/shell-${index}`, html: await readFile(file, 'utf8') });
    }
    for (const fixture of list) {
      if (fixture.html !== undefined) pages.set(fixture.path, fixture.html);
    }
    // USABL_AXE_COMPARE_GROUPS limits a run to the fixtures whose names start with one of its
    // comma-separated prefixes, so the harness can run in parts on a busy machine.
    const groups = (process.env.USABL_AXE_COMPARE_GROUPS ?? '').split(',').filter((group) => group !== '');
    if (groups.length > 0) list = list.filter((fixture) => groups.some((group) => fixture.name.startsWith(group)));
    browser = await chromium.launch({ headless: true });
    siteBrowser = await chromium.launch({ headless: true, args: ['--site-per-process'] });
  }, BUDGET_MS);

  afterAll(async () => {
    await browser?.close();
    await siteBrowser?.close();
    await server?.close();
    const out = process.env.USABL_AXE_COMPARE_OUT;
    if (out !== undefined && out !== '') {
      await writeFile(out, `${JSON.stringify(outcomes, null, 2)}\n`);
    }
  }, BUDGET_MS);

  async function compare(fixture: Fixture): Promise<Outcome> {
    const context = await (fixture.isolatedSites === true ? siteBrowser : browser).newContext();
    try {
      const pw = await context.newPage();
      await pw.goto(`${server.origin}${fixture.path}`, { waitUntil: 'load' });
      await settle(pw);
      if (fixture.freeze === true) {
        await pw.evaluate(() => {
          const last = window.setTimeout(() => undefined, 0);
          for (let id = 0; id <= last; id += 1) {
            window.clearInterval(id);
            window.clearTimeout(id);
          }
        });
      }
      const started = Date.now();
      const result = await compareAxeWorlds(pw, fixture.tags === undefined ? {} : { tags: fixture.tags });
      if (process.env.USABL_AXE_COMPARE_PROGRESS === '1') {
        process.stderr.write(`${fixture.name}: ${result.differences.length} differences, ${Date.now() - started} ms\n`);
      }
      const outcome: Outcome = {
        fixture: fixture.name,
        internals: fixture.internals === true,
        counts: result.counts,
        differences: result.differences,
        uncheckedFrames: result.isolated.uncheckedFrames,
        unstable: result.unstable,
      };
      outcomes.push(outcome);
      return outcome;
    } finally {
      await context.close();
    }
  }

  it(
    'finds no difference on any fixture without ElementInternals, and checks every frame',
    async () => {
      const failures: Outcome[] = [];
      for (const fixture of list.filter((entry) => entry.internals !== true)) {
        const outcome = await compare(fixture);
        const unchecked = outcome.uncheckedFrames.map((frame) => frame.why);
        if (outcome.differences.length > 0 || JSON.stringify(unchecked) !== JSON.stringify(fixture.unchecked ?? [])) {
          failures.push(outcome);
        }
      }
      expect(failures).toEqual([]);
    },
    BUDGET_MS * 4,
  );

  it(
    'records every difference on the ElementInternals fixtures',
    async () => {
      const measured: Record<string, string[]> = {};
      for (const fixture of list.filter((entry) => entry.internals === true)) {
        const outcome = await compare(fixture);
        expect(outcome.uncheckedFrames).toEqual([]);
        measured[fixture.name] = outcome.differences.map(
          (d) => `${d.entry.category} ${d.entry.rule} ${d.entry.target ?? ''}: page world ${d.pageWorld}, isolated ${d.isolated}`,
        );
      }
      // Each entry is a measured difference, kept here so a change in either world shows.
      const expected = Object.fromEntries(Object.entries(EXPECTED_INTERNALS_DIFFERENCES).filter(([name]) => name in measured));
      expect(measured).toEqual(expected);
    },
    BUDGET_MS * 2,
  );
});

// The ElementInternals differences, as measured. The isolated world reads the role, the
// aria-label name, and the required ARIA states a custom element set through internals from the
// browser's accessibility tree, which matches the page world on every fixture not listed with a
// difference here. Two differ. A role attribute of presentation, or one that is not a role,
// overrides the internals role in Chrome, which then exposes no list items. The isolated run
// reports the list as missing its items, which is what assistive technology meets. The page world
// read the internals role instead and passed the list, a false pass. A role kept in a private
// field is invisible to axe in the page world, which then reports a list with no items. The
// browser exposes those items, and so does the isolated run.
const EXPECTED_INTERNALS_DIFFERENCES: Record<string, string[]> = {
  'internals: buttons named and unnamed': [],
  'internals: custom elements without internals': [],
  'internals: heading': [],
  'internals: hidden items': [],
  'internals: image role': [],
  'internals: labelled checkbox': [],
  'internals: list in a shadow root': [],
  'internals: listitem role in a list': [],
  'internals: role attribute over internals': [
    'inapplicable presentation-role-conflict : page world 0, isolated 1',
    'pass aria-required-children ["div"]: page world 1, isolated 0',
    'pass presentation-role-conflict ["x-li[role=\\"presentation\\"]"]: page world 1, isolated 0',
    'violation aria-required-children ["div"]: page world 0, isolated 1',
  ],
  'internals: role in a private field': [
    'pass aria-required-children ["div"]: page world 0, isolated 1',
    'violation aria-required-children ["div"]: page world 1, isolated 0',
  ],
  'internals: state on a role attribute': [],
  'internals: tabs': [],
};

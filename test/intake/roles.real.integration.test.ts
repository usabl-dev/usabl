/**
 * The design checks in real Chromium. Each check finds its element by role and accessible name, so
 * this file first proves what the accessibility tree reports for the elements designers annotate:
 * the role strings, the heading levels, and the size the bounding box read returns. Then it proves
 * that the role search reads every candidate on a plain page, and refuses on a page whose
 * candidates sit inside a shadow root, because the docs claim both only because this test holds it.
 */
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserDriver, Draft, Page, Requirement, TargetRole } from '../../src/contracts/index.js';
import { makeRealBrowserDriver } from '../../src/deps/real.js';
import { findByRole, resolveTarget, ROLE_CANDIDATES } from '../../src/intake/resolve-target.js';
import { designCheckProvider } from '../../src/intake/structure-providers.js';
import { draftsOf, testConfig } from '../helpers.js';
import { REAL_PROCESS_BUDGET_MS } from '../support/timing.js';

const SHADOW_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shadow</title></head><body>
  <main><h1>Users</h1><button type="button">Refresh</button><x-toolbar></x-toolbar></main>
  <script>
    customElements.define('x-toolbar', class extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: 'open' }).innerHTML = '<button type="button">Refresh</button>';
      }
    });
  </script>
</body></html>`;

// One plain Refresh button and a second one the document search cannot read as a plain candidate:
// inside a closed shadow root, with a role attribute of two tokens, or with a role set through
// ElementInternals.
const SECOND_MATCH_PAGES: Readonly<Record<string, string>> = {
  '/closed-shadow.html': `<x-closed></x-closed><script>
    customElements.define('x-closed', class extends HTMLElement {
      constructor() { super(); this.attachShadow({ mode: 'closed' }).innerHTML = '<button type="button">Refresh</button>'; }
    });
  </script>`,
  '/two-tokens.html': `<div role="button menuitem" tabindex="0">Refresh</div>`,
  '/internals.html': `<x-internals tabindex="0"></x-internals><script>
    customElements.define('x-internals', class extends HTMLElement {
      constructor() { super(); const internals = this.attachInternals(); internals.role = 'button'; internals.ariaLabel = 'Refresh'; }
    });
  </script>`,
};

function secondMatchPage(path: string): string | null {
  const extra = SECOND_MATCH_PAGES[path];
  return extra === undefined
    ? null
    : `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Two</title></head><body><main><button type="button">Refresh</button>${extra}</main></body></html>`;
}

// A link that wraps onto two lines, a 44 pixel button inside a 12 pixel box that hides its
// overflow, a button inside a box that scrolls and holds it in full, and the shapes usabl does not
// measure: a rotated button, a button cut by clip-path, a masked button, a button in a 12 pixel box
// that scrolls, and a fixed button partly below the viewport. The moved and scaled buttons are
// measured.
const BUTTON = 'width:44px;height:44px;padding:0;border:0';
const SHAPES_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shapes</title></head><body><main>
  <p style="width:80px;font:16px/20px monospace">Go <a id="wraps" href="#x">to the user list now</a></p>
  <div style="height:12px;overflow:hidden"><button id="clipped" style="${BUTTON}">Save</button></div>
  <div style="height:100px;overflow:auto"><button id="scrolls" style="${BUTTON}">Edit</button></div>
  <button id="rotated" style="width:20px;height:20px;padding:0;border:0;transform:rotate(45deg)">Turn</button>
  <div style="transform:skewX(20deg)"><button id="skewed-inside" style="${BUTTON}">Lean</button></div>
  <button id="clip-path" style="${BUTTON};clip-path:inset(0 0 30px 0)">Cut</button>
  <button id="masked" style="${BUTTON};mask-image:linear-gradient(black, transparent)">Fade</button>
  <div style="height:12px;overflow:auto"><button id="short-scroll" style="${BUTTON}">Scroll</button></div>
  <button id="moved" style="${BUTTON};transform:translate(5px, 5px)">Move</button>
  <button id="scaled" style="width:22px;height:22px;padding:0;border:0;transform:scale(2)">Grow</button>
  <button id="fixed-off" style="${BUTTON};position:fixed;bottom:-30px;left:0">Low</button>
</main></body></html>`;

// Three buttons in order. On the blur page, the second one drops focus when it gets it, so a Tab
// walk falls to the body in the middle of the page.
function focusPage(blurSecond: boolean): string {
  const handler = blurSecond ? `<script>document.getElementById('second').addEventListener('focus', (event) => event.target.blur());</script>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Focus</title></head><body>
  <main><button type="button">Create user</button><button type="button" id="second">Refresh</button><button type="button">Actions for alice</button></main>
  ${handler}
</body></html>`;
}

const FOCUS_ORDER: Requirement = {
  id: 'users-focus',
  kind: 'focus-order',
  surface: 'users',
  description: 'Focus order of the users toolbar',
  assertion: { type: 'focus-order', sequence: ['Create user', 'Refresh', 'Actions for alice'] },
  approved: true,
};

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('design checks in Chromium', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  let driver: BrowserDriver;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    driver = makeRealBrowserDriver();
    const roles = await readFile(fileURLToPath(new URL('../../fixtures/live/roles.html', import.meta.url)), 'utf8');
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      const path = (req.url ?? '').split('?')[0] ?? '';
      const pages: Readonly<Record<string, string>> = {
        '/shapes.html': SHAPES_PAGE,
        '/shadow.html': SHADOW_PAGE,
        '/focus-blur.html': focusPage(true),
        '/focus.html': focusPage(false),
      };
      res.end(secondMatchPage(path) ?? pages[path] ?? roles);
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('test server has no port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await driver.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  async function withPage<T>(path: string, use: (page: Page) => Promise<T>): Promise<T> {
    const page = await driver.open(`${baseUrl}${path}`);
    try {
      await page.gotoReady();
      return await use(page);
    } finally {
      await page.close();
    }
  }

  it('reads the roles designers annotate, under the names the role search accepts', async () => {
    await withPage('/roles.html', async (page) => {
      const role = async (selector: string) => (await page.axAt(selector))?.role;
      expect(await role('main')).toBe('main');
      expect(await role('nav')).toBe('navigation');
      expect(await role('header')).toBe('banner');
      expect(await role('footer')).toBe('contentinfo');
      expect(await role('aside')).toBe('complementary');
      expect(await role('section')).toBe('region');
      expect(await role('form')).toBe('form');
      expect(await role('search')).toBe('search');
      expect(await role('#refresh')).toBe('button');
      expect(await role('a')).toBe('link');
      expect(await role('input[type="checkbox"]')).toBe('checkbox');
      expect(['img', 'image']).toContain(await role('img'));
      expect(['textbox', 'searchbox']).toContain(await role('input[type="search"]'));
      expect(await role('input[aria-label="Email"]')).toBe('textbox');
    });
  });

  it('reads heading levels as whole numbers', async () => {
    await withPage('/roles.html', async (page) => {
      expect((await page.axAt('h1'))?.states['level']).toBe(1);
      expect((await page.axAt('#h2'))?.states['level']).toBe(2);
      expect((await page.axAt('[role="heading"]'))?.states['level']).toBe(3);
    });
  });

  it('reads the laid-out size of an element in CSS pixels', async () => {
    await withPage('/roles.html', async (page) => {
      expect(await page.boundingBox('#refresh')).toEqual({ width: 32, height: 32, fragments: 1, unmeasurable: [] });
      expect(await page.boundingBox('#tiny')).toEqual({ width: 16, height: 16, fragments: 1, unmeasurable: [] });
      expect(await page.boundingBox('#nothing-here')).toBeNull();
    });
  });

  it('reads a box that wraps onto two lines and a box an element above clips', async () => {
    await withPage('/shapes.html', async (page) => {
      expect((await page.boundingBox('#wraps'))?.fragments ?? 0).toBeGreaterThan(1);
      expect(await page.boundingBox('#clipped')).toMatchObject({ width: 44, height: 44, fragments: 1, unmeasurable: ['overflow-clipped'] });
      expect(await page.boundingBox('#scrolls')).toMatchObject({ fragments: 1, unmeasurable: [] });
    });
  });

  it('names each shape it does not measure, and measures a moved or scaled box', async () => {
    await withPage('/shapes.html', async (page) => {
      const limits = async (selector: string) => (await page.boundingBox(selector))?.unmeasurable;
      expect(await limits('#rotated')).toEqual(['rotated-or-skewed']);
      expect(await limits('#skewed-inside')).toEqual(['rotated-or-skewed']);
      expect(await limits('#clip-path')).toEqual(['clip-path']);
      expect(await limits('#masked')).toEqual(['mask']);
      expect(await limits('#short-scroll')).toEqual(['overflow-clipped']);
      expect(await limits('#fixed-off')).toEqual(['outside-viewport']);
      expect(await page.boundingBox('#moved')).toEqual({ width: 44, height: 44, fragments: 1, unmeasurable: [] });
      expect(await page.boundingBox('#scaled')).toEqual({ width: 44, height: 44, fragments: 1, unmeasurable: [] });
    });
  });

  it('asks for review of a rotated, a clip-path, and a scrolled button, never a pass', async () => {
    await withPage('/shapes.html', async (page) => {
      for (const name of ['Turn', 'Cut', 'Scroll']) {
        const provider = designCheckProvider({
          id: `size-${name.toLowerCase()}`,
          kind: 'target-size',
          surface: 'users',
          description: `The ${name} button is at least 24 CSS pixels`,
          assertion: { type: 'target-size', target: { role: 'button', name }, minCssPx: 24 },
          approved: true,
        });
        if (provider === null) throw new Error('no target size provider');
        const output = await provider.run({ page, screen: { id: 'users', url: `${baseUrl}/shapes.html` }, config: testConfig() });
        expect({ name, confidence: draftsOf(output).map((draft) => draft.confidence) }).toEqual({ name, confidence: ['unverified'] });
      }
    });
  });

  it('reads every candidate of every role on a plain page, so nothing is out of reach', async () => {
    await withPage('/roles.html', async (page) => {
      for (const role of Object.keys(ROLE_CANDIDATES) as TargetRole[]) {
        expect({ role, outOfReach: (await findByRole(page, role)).outOfReach }).toEqual({ role, outOfReach: 0 });
      }
      expect((await resolveTarget(page, { role: 'button', name: 'Refresh' })).kind).toBe('one');
      expect((await resolveTarget(page, { role: 'img', name: 'Team photo' })).kind).toBe('one');
      expect((await resolveTarget(page, { role: 'textbox', name: 'Filter users' })).kind).toBe('one');
      expect((await resolveTarget(page, { role: 'navigation', name: 'Primary' })).kind).toBe('one');
      expect((await resolveTarget(page, { role: 'heading', name: 'Pending' })).kind).toBe('one');
      expect((await resolveTarget(page, { role: 'button', name: 'Delete' })).kind).toBe('none');
    });
  });

  it('refuses to pick when a candidate sits in a shadow root it cannot read', async () => {
    await withPage('/shadow.html', async (page) => {
      expect(await resolveTarget(page, { role: 'button', name: 'Refresh' })).toEqual({
        kind: 'out-of-reach',
        found: 1,
        outOfReach: 1,
      });
      // A role with no candidate in the shadow root is still read in full.
      expect((await resolveTarget(page, { role: 'heading', name: 'Users' })).kind).toBe('one');
    });
  });

  for (const path of Object.keys(SECOND_MATCH_PAGES)) {
    it(`never reads one match when a second element has the name (${path})`, async () => {
      await withPage(path, async (page) => {
        const found = await resolveTarget(page, { role: 'button', name: 'Refresh' });
        expect(['many', 'cannot-tell', 'out-of-reach']).toContain(found.kind);
      });
    });
  }

  async function focusOrderDrafts(page: Page): Promise<Draft[]> {
    const provider = designCheckProvider(FOCUS_ORDER);
    if (provider === null) {
      throw new Error('no focus order provider');
    }
    const output = await provider.run({ page, screen: { id: 'users', url: `${baseUrl}/focus.html` }, config: testConfig() });
    return draftsOf(output);
  }

  it('confirms the end of a focus order walk and passes a page built to the design', async () => {
    await withPage('/focus.html', async (page) => {
      expect(await focusOrderDrafts(page)).toEqual([]);
      // The walk leaves focus on the body, as it found it.
      expect(await page.activeElementIs('body')).toBe(true);
    });
  });

  it('reads a focus order walk cut short by a control that blurs itself as needs review, never a failure', async () => {
    await withPage('/focus-blur.html', async (page) => {
      const drafts = await focusOrderDrafts(page);
      expect(drafts.map((draft) => draft.confidence)).toEqual(['unverified']);
      expect(drafts[0]?.why).toContain('one more Tab did not go back to a control the walk had already reached');
    });
  });
});

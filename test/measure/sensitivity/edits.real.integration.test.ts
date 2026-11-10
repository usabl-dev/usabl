/**
 * Every edit kind in real Chromium: the target finder picks the element through the engine's own
 * reads, the real editor changes it in the scan browser, and the change is read back through the
 * same Page reads the checks use. Gated behind USABL_INTEGRATION=1 because it launches Chromium.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserDriver, Page } from '../../../src/contracts/index.js';
import { makeRealBrowserDriver } from '../../../src/deps/real.js';
import type { Edit, TargetFinder } from '../../../src/measure/sensitivity/catalog.js';
import type { Page as PwPage } from 'playwright';
import { playwrightPageOf } from '../../../src/providers/engines/shared.js';
import { locateInPage, type AppliedEdit } from '../../../src/measure/sensitivity/edits.js';
import { makeRealMutationEditor } from '../../../src/measure/sensitivity/real-editor.js';
import { findTargets } from '../../../src/measure/sensitivity/targets.js';
import { REAL_PROCESS_BUDGET_MS } from '../../support/timing.js';

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Edits</title></head><body><main id="main">
<h1>Edits</h1>
<p id="intro">Some text to read.</p>
<button type="button" id="first">First</button>
<button type="button" id="second"><span>Second</span></button>
<label for="email">Email</label><input id="email" type="email">
<label id="wrap">Name <input id="name" type="text"></label>
<img id="logo" alt="Company logo" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
<div id="dialog" role="dialog" aria-label="Settings" hidden><button type="button" id="inside">Inside</button></div>
<button type="button" id="last">Last</button>
<button type="button" id="jump">Jump</button>
<button type="button" id="doc-handled">Handled by the document</button>
<button type="button" id="open-lazy">Open the lazy dialog</button>
<div id="lazy-dialog" role="dialog" aria-label="Lazy" hidden></div>
<button type="button" id="sticky" aria-label="Sticky">S</button>
<x-host></x-host>
</main>
<script>
  customElements.define('x-host', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<button type="button">In the shadow</button>'; }
  });
  document.getElementById('first').addEventListener('click', () => { document.body.dataset.clicked = 'yes'; });
  document.getElementById('jump').addEventListener('click', () => { document.getElementById('last').focus(); });
  // A document listener in the capture phase runs before any listener on the element.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.id === 'doc-handled') {
      event.stopPropagation();
      document.body.dataset.documentHandled = 'yes';
    }
  }, true);
  // The dialog renders its content when it opens, so the content is new and its focus() works.
  document.getElementById('open-lazy').addEventListener('click', () => {
    const dialog = document.getElementById('lazy-dialog');
    dialog.hidden = false;
    dialog.innerHTML = '<button type="button" id="lazy-inside">OK</button>';
    dialog.querySelector('button').focus();
  });
  // Puts the label back whenever something removes it, as a page that renders again would.
  const sticky = document.getElementById('sticky');
  new MutationObserver(() => {
    if (!sticky.hasAttribute('aria-label')) sticky.setAttribute('aria-label', 'Sticky');
  }).observe(sticky, { attributes: true });
</script>
</body></html>`;

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('sensitivity edits in Chromium', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  let server: Server;
  let url: string;
  let driver: BrowserDriver;
  const editor = makeRealMutationEditor();

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('test server has no port');
    url = `http://127.0.0.1:${address.port}/`;
    driver = makeRealBrowserDriver();
  });

  afterAll(async () => {
    await driver.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function withEdit(finder: TargetFinder, edit: Edit, check: (page: Page, applied: AppliedEdit, paths: string[]) => Promise<void>): Promise<void> {
    const page = await driver.open(url);
    try {
      await page.gotoReady();
      const found = await findTargets(page, finder);
      if (found.kind !== 'found') throw new Error(`no target: ${found.reason}`);
      const outcome = await editor.apply(page, found.paths, edit);
      if (outcome.kind !== 'applied') throw new Error(`edit failed: ${outcome.reason}`);
      try {
        await check(page, outcome.edit, found.paths);
      } finally {
        await outcome.edit.release();
      }
    } finally {
      await page.close();
    }
  }

  it('removes every text name from a button, and the tree reports no name', async () => {
    await withEdit({ selector: 'button', tree: { roles: ['button'], named: true } }, { kind: 'remove-text-name' }, async (page, _applied, paths) => {
      expect(paths).toEqual(['#first']);
      expect((await page.axAt('#first'))?.name ?? '').toBe('');
    });
    await withEdit({ selector: '#second' }, { kind: 'remove-text-name' }, async (page) => {
      expect((await page.axAt('#second'))?.name ?? '').toBe('');
    });
  });

  it('removes the label of a field, for a label that points at it and one that wraps it', async () => {
    await withEdit({ selector: '#email', tree: { named: true } }, { kind: 'remove-text-name' }, async (page) => {
      expect((await page.axAt('#email'))?.name ?? '').toBe('');
    });
    await withEdit({ selector: '#name', tree: { named: true } }, { kind: 'remove-text-name' }, async (page) => {
      expect((await page.axAt('#name'))?.name ?? '').toBe('');
      expect(await page.queryAll('#name')).toHaveLength(1);
    });
  });

  it('removes and sets attributes and the role', async () => {
    await withEdit({ selector: 'img[alt]', tree: { named: true } }, { kind: 'remove-attribute', names: ['alt'] }, async (page) => {
      expect(await page.getAttribute('#logo', 'alt')).toBeNull();
    });
    await withEdit({ selector: '#last' }, { kind: 'set-attribute', name: 'tabindex', value: '-1' }, async (page) => {
      expect(await page.getAttribute('#last', 'tabindex')).toBe('-1');
    });
    await withEdit({ selector: '#last' }, { kind: 'replace-role', role: 'buton' }, async (page) => {
      expect(await page.getAttribute('#last', 'role')).toBe('buton');
    });
  });

  it('sets an inline style that wins over the page', async () => {
    await withEdit({ selector: 'main p', text: 'some' }, { kind: 'set-style', styles: { color: '#999999' } }, async (page) => {
      expect(await page.getComputedStyle('#intro', 'color')).toBe('rgb(153, 153, 153)');
    });
  });

  it('removes an element and stands its parent in for it', async () => {
    await withEdit({ selector: 'h1', every: true }, { kind: 'remove-element' }, async (page, applied) => {
      expect(await page.queryAll('h1')).toEqual([]);
      // An ancestor of the stand-in is not around it. Only a shadow host is.
      expect(await applied.locate(['#main', '#first', 'html'])).toEqual(['target', 'inside', 'elsewhere']);
    });
  });

  it('counts the shadow host of a changed element as around it, and no other ancestor', async () => {
    const page = await driver.open(url);
    try {
      await page.gotoReady();
      const pw = playwrightPageOf(page) as PwPage;
      // An edit reaches the top document only, so the anchor in a shadow root is built here.
      const result = await pw.evaluateHandle(() => ({
        anchors: [document.querySelector('x-host')?.shadowRoot?.querySelector('button')],
      }));
      try {
        expect(await result.evaluate(locateInPage as never, ['x-host', '#main', 'x-host >> button'])).toEqual([
          'around',
          'elsewhere',
          'target',
        ]);
      } finally {
        await result.dispose();
      }
    } finally {
      await page.close();
    }
  });

  it('cancels one key on the element: Tab stays on it, Enter does not click it', async () => {
    await withEdit({ selector: '#first' }, { kind: 'swallow-key', key: 'Tab' }, async (page) => {
      await page.focusBody();
      await page.tab();
      expect(await page.activeElementIs('#first')).toBe(true);
      await page.tab();
      expect(await page.activeElementIs('#first')).toBe(true);
    });
    await withEdit({ selector: '#first' }, { kind: 'swallow-key', key: 'Enter' }, async (page) => {
      await page.focusBody();
      await page.tab();
      await page.press('Enter');
      expect(await page.getAttribute('body', 'data-clicked')).toBeNull();
      await page.click('#first');
      expect(await page.getAttribute('body', 'data-clicked')).toBe('yes');
    });
  });

  it('makes a focus() call do nothing on the element and inside it, while Tab still reaches it', async () => {
    await withEdit({ selector: '[role="dialog"]' }, { kind: 'ignore-focus-calls' }, async (page, applied) => {
      expect(await applied.locate(['#inside', '#dialog', '#first'])).toEqual(['inside', 'target', 'elsewhere']);
    });
    await withEdit({ selector: '#last' }, { kind: 'ignore-focus-calls' }, async (page) => {
      await page.click('#jump');
      expect(await page.activeElementIs('#last')).toBe(false);
      await page.focusBody();
      for (let stop = 0; stop < 5; stop += 1) await page.tab();
      expect(await page.activeElementIs('#last')).toBe(true);
    });
  });

  it('reads a markup change back after the scan, and sees one the page put back', async () => {
    await withEdit({ selector: 'img[alt]', tree: { named: true } }, { kind: 'remove-attribute', names: ['alt'] }, async (_page, applied) => {
      expect(await applied.check()).toEqual({ held: true, note: null });
    });
    await withEdit({ selector: '#sticky' }, { kind: 'remove-attribute', names: ['aria-label'] }, async (page, applied) => {
      // The page's observer runs after the edit returns, then puts the label back.
      expect(await page.getAttribute('#sticky', 'aria-label')).toBe('Sticky');
      expect(await applied.check()).toEqual({ held: false, reason: 'the page put back an attribute the edit removed' });
    });
  });

  it('counts a key a document listener acted on before the swallow, and says when no key was pressed', async () => {
    await withEdit({ selector: '#first' }, { kind: 'swallow-key', key: 'Enter' }, async (page, applied) => {
      expect(await applied.check()).toEqual({ held: true, note: 'the checks never pressed Enter on the changed element' });
      await page.click('#first');
      await page.press('Enter');
      expect(await applied.check()).toEqual({ held: true, note: null });
    });
    await withEdit({ selector: '#doc-handled' }, { kind: 'swallow-key', key: 'Enter' }, async (page, applied) => {
      await page.click('#doc-handled');
      await page.press('Enter');
      expect(await page.getAttribute('body', 'data-document-handled')).toBe('yes');
      expect(await applied.check()).toEqual({
        held: false,
        reason: 'a Enter key aimed at the changed element reached the page before the edit could cancel it',
      });
    });
  });

  it('counts focus that reaches a dialog through content it renders on open', async () => {
    await withEdit({ selector: '#lazy-dialog' }, { kind: 'ignore-focus-calls' }, async (page, applied) => {
      expect(await applied.check()).toEqual({ held: true, note: null });
      await page.click('#open-lazy');
      expect(await page.activeElementWithin('#lazy-dialog')).toBe(true);
      expect(await applied.check()).toEqual({
        held: false,
        reason: 'focus reached the changed element in a way the edit does not stop, such as an element added later',
      });
    });
    // Focus by Tab and by a pointer press is not the page moving it, so the change still holds.
    await withEdit({ selector: '#last' }, { kind: 'ignore-focus-calls' }, async (page, applied) => {
      await page.focusBody();
      for (let stop = 0; stop < 5; stop += 1) await page.tab();
      expect(await page.activeElementIs('#last')).toBe(true);
      await page.focusBody();
      await page.click('#last');
      expect(await page.activeElementIs('#last')).toBe(true);
      expect(await applied.check()).toEqual({ held: true, note: null });
    });
  });

  it('fails when the page does not keep the change', async () => {
    const page = await driver.open(url);
    try {
      await page.gotoReady();
      const outcome = await editor.apply(page, ['#no-such-element'], { kind: 'remove-text-name' });
      expect(outcome).toEqual({ kind: 'failed', reason: 'a target element could not be found again as one element' });
    } finally {
      await page.close();
    }
  });
});

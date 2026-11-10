/**
 * Real Chromium: Page.hostMarkup and Page.axInShadowRoot, the two reads the component rulepacks use.
 * Both run in an isolated world, so page script that patches the DOM accessors cannot change them.
 *
 * Gated behind USABL_INTEGRATION=1 like the other browser tests, because it launches Chromium.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from '../../src/contracts/index.js';
import { makeRealBrowserDriver } from '../../src/deps/real.js';
import { REAL_PROCESS_BUDGET_MS } from '../support/timing.js';

const DEFINE = `<script>
  customElements.define('x-open', class extends HTMLElement { constructor() { super();
    this.attachShadow({ mode: 'open' }).innerHTML = '<span>Inside</span><button type="button" aria-label="Inner name">x</button>'; } });
  customElements.define('x-closed', class extends HTMLElement { constructor() { super();
    this.attachShadow({ mode: 'closed' }).innerHTML = '<button type="button" aria-label="Hidden name">x</button>'; } });
  customElements.define('x-plain', class extends HTMLElement {});
</script>`;

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Reads</title></head><body><main>
  <x-plain id="slots" data-kind="demo" accessible-label="">
    Loose text
    <span>unslotted</span>
    <span slot="">empty slot name</span>
    <span slot="icon">named slot</span>
  </x-plain>
  <x-plain id="hidden-x"><span aria-hidden="true">x</span></x-plain>
  <x-plain id="hidden-mixed"><span aria-hidden="true">x</span> Close <span hidden>one</span><span style="display: none">two</span><span inert>three</span><span style="visibility: hidden">four</span></x-plain>
  <x-plain id="screen-reader-text"><span style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0)">Close</span></x-plain>
  <x-undefined id="not-upgraded"></x-undefined>
  <x-open id="open-host"></x-open>
  <x-closed id="closed-host"></x-closed>
  <div id="no-root"><button type="button">Light button</button></div>
</main>${DEFINE}</body></html>`;

// The same page, with page script that makes the DOM accessors lie to anyone in the page's world.
const PATCHED = PAGE.replace(
  '<main>',
  `<script>
    Object.defineProperty(Node.prototype, 'textContent', { configurable: true, get() { return ''; } });
    Element.prototype.getAttribute = function () { return 'icon'; };
    Element.prototype.matches = function () { return false; };
  </script><main>`,
);

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('component markup and shadow reads, in Chromium', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  const driver = makeRealBrowserDriver();
  let server: Server;
  let base = '';

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(req.url === '/patched' ? PATCHED : PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await driver.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function open(path: string): Promise<Page> {
    const page = await driver.open(base + path);
    await page.gotoReady();
    return page;
  }

  for (const path of ['/', '/patched']) {
    it(`reads markup facts, counting slot="" as the default slot and leaving a named slot out (${path})`, async () => {
      const page = await open(path);
      try {
        expect(await page.hostMarkup('#slots')).toEqual({
          defined: true,
          attributes: { id: 'slots', 'data-kind': 'demo', 'accessible-label': '' },
          defaultSlotText: 'Loose text unslotted empty slot name',
        });
        expect((await page.hostMarkup('#not-upgraded'))?.defined).toBe(false);
        expect(await page.hostMarkup('#nothing-here')).toBeNull();
      } finally {
        await page.close();
      }
    });
  }

  // The default-slot text stands in for a name only when a screen reader can reach it. An "x" under
  // aria-hidden is a name for no one, so it must not let a rule skip its accessibility tree check.
  for (const path of ['/', '/patched']) {
    it(`leaves text hidden from assistive technology out of the default-slot text (${path})`, async () => {
      const page = await open(path);
      try {
        expect((await page.hostMarkup('#hidden-x'))?.defaultSlotText).toBe('');
        expect((await page.hostMarkup('#hidden-mixed'))?.defaultSlotText).toBe('Close');
        expect((await page.hostMarkup('#screen-reader-text'))?.defaultSlotText).toBe('Close');
      } finally {
        await page.close();
      }
    });
  }

  it('reads the node of an element inside an open shadow root, and null where there is none to read', async () => {
    const page = await open('/');
    try {
      expect(await page.axInShadowRoot('#open-host', 'button')).toEqual(expect.objectContaining({ name: 'Inner name', role: 'button' }));
      // A host with no shadow root, a closed root, and an inner selector that matches nothing.
      expect(await page.axInShadowRoot('#no-root', 'button')).toBeNull();
      expect(await page.axInShadowRoot('#closed-host', 'button')).toBeNull();
      expect(await page.axInShadowRoot('#open-host', 'input')).toBeNull();
      expect(await page.axInShadowRoot('#nothing-here', 'button')).toBeNull();
    } finally {
      await page.close();
    }
  });
});

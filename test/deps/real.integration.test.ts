import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright';
import type {
  BrowserDriver,
  EvidenceFloor,
  GateOutput,
  Page as UsablPage,
  Provider,
  ScreenScan,
  SurfaceConfig,
} from '../../src/contracts/index.js';
import { buildDeps } from '../../src/deps/build.js';
import { gate, renderEvidenceOf } from '../../src/gate/index.js';
import { computeIdentity, identityKey } from '../../src/primitives/identity.js';
import { LIVE_WORLD, adoptPage, makeRealBrowserDriver } from '../../src/deps/real.js';
import { mapRequirementsToProviders } from '../../src/intake/map-to-providers.js';
import { axeProvider } from '../../src/providers/axe/index.js';
import { makeCheckRunner } from '../../src/providers/check-runner.js';
import { markUnseenScreens } from '../../src/coverage/unseen.js';
import { makeStepRunner } from '../../src/providers/keyboard-walk/steps.js';
import { testConfig } from '../helpers.js';

interface FixtureServer {
  url: string;
  lateMountUrl: string;
  neverSettlesUrl: string;
  hangingRequestUrl: string;
  // Answers 302 to /sign-in.html, the way a login-gated application answers a request made with
  // an expired session. This is the whole failure, driven through a real browser and a real
  // redirect rather than a fake page told to report a different address.
  gatedUrl: string;
  // Answers 302 to /labelledby.html, an ordinary redirect that still lands on a real screen.
  redirectToScreenUrl: string;
  reachedScreenUrl: string;
  // Stays at its own address and fires three fetches the server answers 401, which is what the
  // real application does with a dead session.
  expiredSessionUrl: string;
  // Stays at its own address and mounts a login form inside an open shadow root.
  shadowSignInUrl: string;
  // The same page against endpoints that answer 403, which is authenticated and not permitted.
  forbiddenApiUrl: string;
  // Sends its identity request three seconds after load, well after readiness settles, so the 401
  // is not in the record at the first read and only appears during the walk.
  lateUnauthorizedUrl: string;
  // Focusing its first control mounts a tooltip that fades out over a few hundred milliseconds.
  tooltipOnFocusUrl: string;
  // Three sign-in pages the session rules cannot see, each served at the address the scan asked
  // for: a passkey prompt, a magic-link form, and an authentication wall that answers 200 to every
  // request under it.
  passkeySignInUrl: string;
  magicLinkUrl: string;
  authWallUrl: string;
  // The real screen: it fetches /api/data/orders and renders table#orders from the answer.
  ordersUrl: string;
  // The same screen, whose identity call is refused once and answered after a token refresh.
  ordersRecoveredUrl: string;
  // A screen whose call for its own data is answered 200 with an HTML page, the way a dev server
  // history fallback or a sign-in proxy answers it.
  spaFallbackUrl: string;
  // A page that asks for no data on load and requests the screen's data path only when a control
  // is focused, so the only answer to that path is one the walk caused.
  fetchOnFocusUrl: string;
  // A shell with one link, then a pause of ?pause= milliseconds with nothing in flight and nothing
  // changing, then a fetch that mounts the screen's real content.
  frozenPauseUrl: string;
  // A shell that pauses, mounts the orders table from a 200 JSON answer, and 800 ms later replaces
  // itself with a magic-link sign-in form. The table never holds still; the sign-in form does.
  swapToSignInUrl: string;
  // A header, a navigation, and a heading that always mount, and a table of orders that mounts only
  // with ?content=ok or ?content=broken. With ?content=fail its mount throws and nothing replaces it.
  partialRenderUrl: string;
  // A shell that pauses, mounts table#orders, and in the same task asks for details the server
  // answers slowly. The answer mounts a button with no accessible name.
  detailsAfterSignalUrl: string;
  close: () => Promise<void>;
}

async function readFixture(name: string): Promise<string> {
  return readFile(fileURLToPath(new URL(`../../fixtures/live/${name}`, import.meta.url)), 'utf8');
}

// How long the server takes to answer /api/slow/. Far longer than a walk and the checks of a small
// page, so a scan that starts before the answer lands finishes before it too.
const SLOW_ANSWER_MS = 4_000;

async function makeFixtureServer(): Promise<FixtureServer> {
  const html = await readFixture('labelledby.html');
  const pages: Record<string, string> = {
    '/late-mount.html': await readFixture('late-mount.html'),
    '/never-settles.html': await readFixture('never-settles.html'),
    '/hanging-request.html': await readFixture('hanging-request.html'),
    '/sign-in.html': await readFixture('sign-in.html'),
    '/expired-session-app.html': await readFixture('expired-session-app.html'),
    '/shadow-sign-in.html': await readFixture('shadow-sign-in.html'),
    '/late-unauthorized.html': await readFixture('late-unauthorized.html'),
    '/tooltip-on-focus.html': await readFixture('tooltip-on-focus.html'),
    '/passkey-sign-in.html': await readFixture('passkey-sign-in.html'),
    '/magic-link.html': await readFixture('magic-link.html'),
    '/orders.html': await readFixture('orders-screen.html'),
    '/fetch-on-focus.html': await readFixture('fetch-on-focus.html'),
    '/frozen-pause.html': await readFixture('frozen-pause.html'),
    '/swap-to-sign-in.html': await readFixture('swap-to-sign-in.html'),
    '/partial-render.html': await readFixture('partial-render.html'),
    '/details-after-signal.html': await readFixture('details-after-signal.html'),
  };
  const spaFallback = await readFixture('spa-fallback.html');
  const authWall = await readFixture('auth-wall.html');
  // Addresses under /api/once/ already answered once. Each is refused the first time and answered
  // every time after, which is what a server does for a call made just before a token refresh.
  const answeredOnce = new Set<string>();

  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (reqUrl.pathname === '/' || reqUrl.pathname === '/labelledby.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    // What a login-gated application does with an expired session: it sends the browser to its
    // sign-in page, carrying the requested screen back as a return address.
    if (reqUrl.pathname === '/gated') {
      res.writeHead(302, { location: '/sign-in.html?next=%2Fgated' });
      res.end();
      return;
    }
    // The page's own data endpoints. /api/v2/* refuses as unauthenticated, which is what a server
    // does for a request carrying a dead session. /api/ok/* answers normally, so a healthy load
    // can be measured against the same fixture.
    if (reqUrl.pathname.startsWith('/api/v2/')) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"detail":"Authentication credentials were not provided."}');
      return;
    }
    // Authenticated and not permitted. A signed-in scan can legitimately meet this, so it must
    // never be read as a dead session.
    if (reqUrl.pathname.startsWith('/api/forbidden/')) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"detail":"You do not have permission."}');
      return;
    }
    // The screen's own data, answered for a working session.
    if (reqUrl.pathname.startsWith('/api/data/')) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('["A-100","A-101"]');
      return;
    }
    if (reqUrl.pathname.startsWith('/api/once/')) {
      const key = `${reqUrl.pathname}${reqUrl.search}`;
      if (!answeredOnce.has(key)) {
        answeredOnce.add(key);
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
        res.end('{"detail":"Token expired."}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"user":"operator"}');
      return;
    }
    // A history fallback: every address under it, the data call included, answers 200 with the
    // same HTML page.
    if (reqUrl.pathname.startsWith('/spa/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(spaFallback);
      return;
    }
    // Data the server takes a while to answer, long enough for a scan to finish before it lands.
    if (reqUrl.pathname.startsWith('/api/slow/')) {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end('{"details":"ready"}');
      }, SLOW_ANSWER_MS);
      return;
    }
    // An authentication wall: every address under it answers 200 with the same landing page.
    if (reqUrl.pathname.startsWith('/wall/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(authWall);
      return;
    }
    // An ordinary redirect that still ends on the screen that was asked for.
    if (reqUrl.pathname === '/redirect-to-screen') {
      res.writeHead(302, { location: '/labelledby.html' });
      res.end();
      return;
    }
    const page = pages[reqUrl.pathname];
    if (page !== undefined) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }
    // Answers nothing on purpose so the page's network never goes quiet.
    if (reqUrl.pathname === '/hang') {
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
    throw new Error('fixture server failed to bind a TCP port');
  }

  return {
    url: `http://127.0.0.1:${address.port}/`,
    lateMountUrl: `http://127.0.0.1:${address.port}/late-mount.html`,
    neverSettlesUrl: `http://127.0.0.1:${address.port}/never-settles.html`,
    hangingRequestUrl: `http://127.0.0.1:${address.port}/hanging-request.html`,
    gatedUrl: `http://127.0.0.1:${address.port}/gated`,
    redirectToScreenUrl: `http://127.0.0.1:${address.port}/redirect-to-screen`,
    reachedScreenUrl: `http://127.0.0.1:${address.port}/labelledby.html`,
    expiredSessionUrl: `http://127.0.0.1:${address.port}/expired-session-app.html`,
    shadowSignInUrl: `http://127.0.0.1:${address.port}/shadow-sign-in.html`,
    forbiddenApiUrl: `http://127.0.0.1:${address.port}/expired-session-app.html?api=/api/forbidden`,
    lateUnauthorizedUrl: `http://127.0.0.1:${address.port}/late-unauthorized.html`,
    tooltipOnFocusUrl: `http://127.0.0.1:${address.port}/tooltip-on-focus.html`,
    passkeySignInUrl: `http://127.0.0.1:${address.port}/passkey-sign-in.html`,
    magicLinkUrl: `http://127.0.0.1:${address.port}/magic-link.html`,
    authWallUrl: `http://127.0.0.1:${address.port}/wall/orders`,
    ordersUrl: `http://127.0.0.1:${address.port}/orders.html`,
    ordersRecoveredUrl: `http://127.0.0.1:${address.port}/orders.html?recover=1`,
    spaFallbackUrl: `http://127.0.0.1:${address.port}/spa/orders`,
    fetchOnFocusUrl: `http://127.0.0.1:${address.port}/fetch-on-focus.html`,
    frozenPauseUrl: `http://127.0.0.1:${address.port}/frozen-pause.html`,
    swapToSignInUrl: `http://127.0.0.1:${address.port}/swap-to-sign-in.html`,
    partialRenderUrl: `http://127.0.0.1:${address.port}/partial-render.html`,
    detailsAfterSignalUrl: `http://127.0.0.1:${address.port}/details-after-signal.html`,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        // The hang route leaves a socket open, and server.close() waits for it forever.
        server.closeAllConnections();
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
  };
}

// The readiness budget for scans whose declared signal never holds. See signalDriver.
const SIGNAL_BUDGET_MS = 5_000;

/** A provider that reports one barrier on whatever page it is given, so a scan that must report
 * nothing can be told apart from a scan that had nothing to report. */
function alwaysFiringProvider(screenId: string): Provider {
  return {
    id: 'always-fires',
    layer: 'test',
    capabilities: ['live'],
    run: async () => [
      {
        rule: 'page-has-heading-one',
        layer: 'test',
        severity: 'moderate' as const,
        evidenceClass: 'deterministic' as const,
        screenId,
        elementPath: 'html',
        elementName: null,
        role: null,
        whatUserExperiences: 'placeholder',
        why: 'placeholder',
        fix: 'placeholder',
        evidence: {},
        confidence: 'fail' as const,
      },
    ],
  };
}

// A probe is several reads of the live page, and on a loaded machine it can take long enough for
// the page to change under it. This driver wraps a real one so that the first probe of each page
// waits until the page has mounted the selector before it answers, which makes that timing certain
// rather than a matter of load. Everything else, readiness included, is the real driver.
function slowProbeDriver(real: BrowserDriver, selector: string): BrowserDriver {
  return {
    open: async (url: string): Promise<UsablPage> => {
      const page = await real.open(url);
      let firstProbe = true;
      return {
        ...page,
        gotoReady: (readyWhen) =>
          page.gotoReady(
            readyWhen === undefined
              ? undefined
              : {
                  timeoutMs: readyWhen.timeoutMs,
                  holds: async () => {
                    if (firstProbe) {
                      firstProbe = false;
                      await untilPresent(page, selector);
                    }
                    return readyWhen.holds();
                  },
                },
          ),
      };
    },
    close: async () => undefined,
  };
}

// Polls until the selector is in the page, for at most ten seconds.
async function untilPresent(page: UsablPage, selector: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await page.countEverywhere(selector)) > 0) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('real browser driver integration', () => {
  let fixture: FixtureServer;
  const driver = makeRealBrowserDriver();
  // Readiness waits for a declared signal until the readiness budget runs out, so a scan of a page
  // that never shows its signal costs the whole budget before it ends as a gap. These fixtures
  // settle in under two seconds, so a short budget keeps those scans quick without changing what
  // they prove.
  const signalDriver = makeRealBrowserDriver({ readyTimeoutMs: SIGNAL_BUDGET_MS });

  beforeAll(async () => {
    fixture = await makeFixtureServer();
  });

  afterAll(async () => {
    await driver.close();
    await signalDriver.close();
    await fixture.close();
  });

  it('resolves aria-labelledby through the AX tree', async () => {
    const page = await driver.open(fixture.url);
    try {
      await page.gotoReady();
      const node = await page.axAt('#labelledby-button');
      expect(node).not.toBeNull();
      expect(node?.name).toBe('Launch report');
      expect(node?.role).toBe('button');
    } finally {
      await page.close();
    }
  });

  it('captures aria-live updates on click and exposes them as live tokens', async () => {
    const page = await driver.open(fixture.url);
    try {
      await page.gotoReady();
      await page.click('#announce-button');
      const announcements = await page.drainAnnouncements();
      expect(announcements).toContain('Saved successfully 1');

      const stops = await makeStepRunner().run(page, [{ do: 'click', selector: '#announce-button' }]);
      expect(stops[0]?.announcement.some((token) => token.kind === 'live' && token.text === 'Saved successfully 2')).toBe(
        true,
      );
    } finally {
      await page.close();
    }
  });

  // The capture reads a live region's text. Page script that redefines textContent, or replaces
  // the drain usabl reads, in its own world must not change what usabl hears.
  const SPOOFING_SAVE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Save</title></head><body>
    <main><button type="button" id="save">Save</button><div role="status" id="message"></div></main>
    <script>
      Object.defineProperty(Node.prototype, 'textContent', {
        get() { return 'Saved'; },
        set(value) { this.replaceChildren(document.createTextNode(String(value))); },
      });
      window.__usablDrain = () => ['Saved'];
      document.getElementById('save').addEventListener('click', () => {
        document.getElementById('message').textContent = 'Not saved';
        window.__usablDrain = () => ['Saved'];
      });
    </script>
  </body></html>`;

  it('hears what the live region says, not what page script reports', async () => {
    const page = await driver.open(`data:text/html;charset=utf-8,${encodeURIComponent(SPOOFING_SAVE_PAGE)}`);
    try {
      await page.click('#save');
      const announcements = await page.drainAnnouncements();
      expect(announcements).toEqual(['Not saved']);
    } finally {
      await page.close();
    }
  });

  it('hears an announcement on a page that stops DOMContentLoaded from reaching other listeners', async () => {
    // A capture that waited for DOMContentLoaded to start its observer never started on this page,
    // and the drain returned nothing.
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Save</title>
      <script>window.addEventListener('DOMContentLoaded', (e) => e.stopImmediatePropagation(), true);</script>
      </head><body>
      <main><button type="button" id="save">Save</button><div role="status" id="message"></div></main>
      <script>
        document.getElementById('save').addEventListener('click', () => {
          document.getElementById('message').textContent = 'Saved';
        });
      </script>
    </body></html>`;
    const page = await driver.open(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    try {
      await page.click('#save');
      expect(await page.drainAnnouncements()).toEqual(['Saved']);
    } finally {
      await page.close();
    }
  });

  describe('which regions the capture hears', () => {
    // The capture hears a region only when its effective live value is polite or assertive, the
    // same way pf-toast-live-region resolves it: the nearest element that sets a value wins, an
    // explicit aria-live beats the role, and every other aria-live token is off. Each page also
    // writes "Heard" to a polite region, so an empty list cannot pass by the capture not running.
    function regionPage(region: string): string {
      return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Save</title></head><body>
        <main><button type="button" id="save">Save</button>
        <div aria-live="polite" id="control"></div>
        ${region}
        </main>
        <script>
          document.getElementById('save').addEventListener('click', () => {
            document.getElementById('message').textContent = 'Message';
            document.getElementById('control').textContent = 'Heard';
          });
        </script>
      </body></html>`;
    }

    const cases: Array<[string, string]> = [
      ['an aria-live="off" region', '<div aria-live="off" id="message"></div>'],
      [
        'an aria-live="off" wrapper inside a polite region',
        '<div aria-live="polite"><div aria-live="off"><span id="message"></span></div></div>',
      ],
      ['an uppercase aria-live="POLITE" token', '<div aria-live="POLITE" id="message"></div>'],
      ['an unknown aria-live="banana" token', '<div aria-live="banana" id="message"></div>'],
      ['an aria-live="off" on a role="status" element', '<div role="status" aria-live="off" id="message"></div>'],
      [
        'a role="timer" inside an assertive region',
        '<div aria-live="assertive"><div role="timer"><span id="message"></span></div></div>',
      ],
      [
        'an off wrapper inside a polite shadow host slot',
        '<div aria-live="polite"><x-off-slot><span id="message"></span></x-off-slot></div>' +
          "<script>customElements.define('x-off-slot', class extends HTMLElement { constructor() { super();" +
          " this.attachShadow({ mode: 'open' }).innerHTML = '<div aria-live=\"off\"><slot></slot></div>'; } });</script>",
      ],
      // Content hidden from assistive technology is silent even inside a live region. Orca says
      // nothing for a polite status inside aria-hidden="true", so the capture must not record it.
      [
        'a polite region inside an aria-hidden="true" subtree',
        '<div aria-hidden="true"><div aria-live="polite" id="message"></div></div>',
      ],
      [
        'an aria-hidden="true" wrapper between a polite region and the change',
        '<div aria-live="polite"><div aria-hidden="true"><span id="message"></span></div></div>',
      ],
      ['a role="status" region that is itself aria-hidden="true"', '<div role="status" aria-hidden="true" id="message"></div>'],
      [
        'a polite region inside aria-hidden="TRUE", which Chromium hides',
        '<div aria-hidden="TRUE"><div aria-live="polite" id="message"></div></div>',
      ],
      [
        'a polite region inside aria-hidden="false" under aria-hidden="true"',
        '<div aria-hidden="true"><div aria-hidden="false"><div aria-live="polite" id="message"></div></div></div>',
      ],
      ['a polite region inside an inert subtree', '<div inert><div aria-live="polite" id="message"></div></div>'],
      ['a polite region inside hidden content', '<div hidden><div aria-live="polite" id="message"></div></div>'],
      [
        'an aria-hidden wrapper around a slot inside a polite region',
        '<div aria-live="polite"><x-hidden-slot><span id="message"></span></x-hidden-slot></div>' +
          "<script>customElements.define('x-hidden-slot', class extends HTMLElement { constructor() { super();" +
          " this.attachShadow({ mode: 'open' }).innerHTML = '<div aria-hidden=\"true\"><slot></slot></div>'; } });</script>",
      ],
    ];

    for (const [name, region] of cases) {
      it(`does not hear ${name}`, async () => {
        const page = await driver.open(`data:text/html;charset=utf-8,${encodeURIComponent(regionPage(region))}`);
        try {
          await page.click('#save');
          expect(await page.drainAnnouncements()).toEqual(['Heard']);
        } finally {
          await page.close();
        }
      });
    }

    const heard: Array<[string, string]> = [
      ['a role="alert" region with no aria-live', '<div role="alert" id="message"></div>'],
      ['a role="log" region with no aria-live', '<div role="log" id="message"></div>'],
      ['a role="STATUS" region, matched without regard to case', '<div role="STATUS" id="message"></div>'],
      ['an empty aria-live on a role="status" element', '<div role="status" aria-live="" id="message"></div>'],
      [
        'a polite region inside an off wrapper',
        '<div aria-live="off"><div aria-live="polite" id="message"></div></div>',
      ],
      ['a polite region with aria-hidden="false"', '<div aria-live="polite" aria-hidden="false" id="message"></div>'],
      [
        'a polite region inside an aria-hidden="false" wrapper',
        '<div aria-hidden="false"><div aria-live="polite"><span id="message"></span></div></div>',
      ],
      ['a polite region with an empty aria-hidden', '<div aria-live="polite" aria-hidden="" id="message"></div>'],
    ];

    // A light element slotted into a live region inside a shadow root. The region's own text in the
    // shadow tree leaves out the slotted text that changed and holds text the change did not make
    // speakable: slot fallback text, and shadow-only text. Recording it would let a flow
    // requirement pass on text no screen reader speaks for the change, so "Saved" must never be
    // heard here.
    const shadowRegions: Array<[string, string]> = [
      ['slot fallback text', '<div aria-live="polite"><slot>Saved</slot></div>'],
      ['shadow-only text beside the slot', '<div aria-live="polite"><span>Saved</span><slot></slot></div>'],
    ];
    for (const [name, shadowHtml] of shadowRegions) {
      it(`never hears ${name} of a live region in a shadow root when slotted text changes`, async () => {
        const region =
          '<x-live-slot><span id="message"></span></x-live-slot>' +
          "<script>customElements.define('x-live-slot', class extends HTMLElement { constructor() { super();" +
          ` this.attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(shadowHtml)}; } });</script>`;
        const page = await driver.open(`data:text/html;charset=utf-8,${encodeURIComponent(regionPage(region))}`);
        try {
          await page.click('#save');
          const drained = await page.drainAnnouncements();
          expect(drained).not.toContain('Saved');
          expect(drained.some((entry) => entry.includes('Saved'))).toBe(false);
          expect(drained).toContain('Heard');
        } finally {
          await page.close();
        }
      });
    }

    // checkPage adopts a page the caller opened, and the capture it installs there must make the
    // same call as the one the CLI installs at document start.
    it('does not hear an off wrapper inside a polite region on an adopted page', async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const pw = await browser.newPage();
        await pw.setContent(
          regionPage('<div aria-live="polite"><div aria-live="off"><span id="message"></span></div></div>'),
          { waitUntil: 'domcontentloaded' },
        );
        const page = await adoptPage(pw);
        await page.click('#save');
        expect(await page.drainAnnouncements()).toEqual(['Heard']);
      } finally {
        await browser.close();
      }
    });

    it('does not hear a polite region inside aria-hidden="true" on an adopted page', async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const pw = await browser.newPage();
        await pw.setContent(regionPage('<div aria-hidden="true"><div aria-live="polite" id="message"></div></div>'), {
          waitUntil: 'domcontentloaded',
        });
        const page = await adoptPage(pw);
        await page.click('#save');
        expect(await page.drainAnnouncements()).toEqual(['Heard']);
      } finally {
        await browser.close();
      }
    });

    for (const [name, region] of heard) {
      it(`hears ${name}`, async () => {
        const page = await driver.open(`data:text/html;charset=utf-8,${encodeURIComponent(regionPage(region))}`);
        try {
          await page.click('#save');
          expect([...(await page.drainAnnouncements())].sort()).toEqual(['Heard', 'Message']);
        } finally {
          await page.close();
        }
      });
    }
  });

  describe('a document without the announcement capture', () => {
    // Silence from a document where the capture is not running would read as a page that
    // announced nothing, and a flow requirement would fail or pass on no evidence. The drain throws
    // instead, and the check runner turns the throw into a coverage gap.
    const SAVE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Save</title></head><body>
      <main><button type="button" id="save">Save</button><div role="status" id="message"></div></main>
      <script>
        document.getElementById('save').addEventListener('click', () => {
          document.getElementById('message').textContent = 'Saved';
        });
      </script>
    </body></html>`;

    let browser: Browser;
    beforeAll(async () => {
      browser = await chromium.launch({ headless: true });
    });
    afterAll(async () => {
      await browser.close();
    });

    // An adopted page whose capture was then removed from the live world, which is what a document
    // the capture never reached looks like to the drain.
    async function pageWithoutCapture(): Promise<{ usablPage: UsablPage; close: () => Promise<void> }> {
      const context = await browser.newContext();
      const pw = await context.newPage();
      await pw.setContent(SAVE_PAGE, { waitUntil: 'domcontentloaded' });
      const usablPage = await adoptPage(pw);
      const cdp = await context.newCDPSession(pw);
      const tree = await cdp.send('Page.getFrameTree');
      const world = await cdp.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: LIVE_WORLD });
      await cdp.send('Runtime.evaluate', { expression: 'delete window.__usablDrain', contextId: world.executionContextId });
      return { usablPage, close: () => context.close() };
    }

    it('throws on a drain instead of reporting silence', async () => {
      const { usablPage, close } = await pageWithoutCapture();
      try {
        await expect(usablPage.drainAnnouncements()).rejects.toThrow(/announcement capture is not running/);
      } finally {
        await close();
      }
    });

    it('turns a flow requirement whose drain throws into a coverage gap, never a pass', async () => {
      const { usablPage, close } = await pageWithoutCapture();
      try {
        const runner = makeCheckRunner({
          browser: { open: async () => usablPage, close: async () => {} },
          providers: mapRequirementsToProviders({
            version: 1,
            requirements: [
              {
                id: 'save-announces',
                kind: 'flow',
                surface: 'clusters',
                description: 'Saving announces that the change was saved.',
                assertion: { type: 'flow', steps: [{ do: 'click', selector: '#save' }], expectedAnnouncement: 'Saved' },
                approved: true,
              },
            ],
          }),
          config: testConfig(),
          allowedCapabilities: ['live'],
          stepRunner: makeStepRunner(),
        });
        const scan = await runner.scan({ id: 'clusters', url: 'http://127.0.0.1:5173/clusters' });
        // The keyboard walk drains at its first stop, so the whole screen is the gap.
        expect(scan.drafts).toEqual([]);
        expect(scan.gaps).toHaveLength(1);
        expect(scan.gaps[0]?.state).toBe('not-covered');
        expect(scan.gaps[0]?.reason).toContain('announcement capture is not running');
        expect(scan.gaps[0]?.reason).not.toContain('<anonymous>');
      } finally {
        await close();
      }
    });
  });

  it('adds a capability-denied gap when provider capabilities are disallowed', async () => {
    const deniedProviderRun = vi.fn(async () => []);
    const deniedProvider: Provider = {
      id: 'net-only',
      layer: 'test',
      capabilities: ['network'],
      run: deniedProviderRun,
    };
    const runner = makeCheckRunner({
      browser: driver,
      providers: [deniedProvider],
      config: testConfig(),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
      transcriptTabCap: 2,
    });

    const scan = await runner.scan({ id: 'integration-screen', url: fixture.url });

    expect(deniedProviderRun).not.toHaveBeenCalled();
    expect(scan.gaps).toContainEqual({
      ref: 'provider:net-only',
      state: 'capability-denied',
      reason: 'provider net-only denied capability: network',
    });
  });

  it('measures reachedSelectorPresent true when the selector is in the rendered DOM', async () => {
    const runner = makeCheckRunner({
      browser: driver,
      providers: [],
      config: testConfig({
        surfaces: [{ id: 'integration-screen', url: fixture.url, files: [], reachedWhen: '#labelledby-button' }],
      }),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
      transcriptTabCap: 2,
    });

    const scan = await runner.scan({ id: 'integration-screen', url: fixture.url });

    expect(scan.reachedSelectorPresent).toBe(true);
    expect(scan.reachedWhenSelector).toBe('#labelledby-button');
  });

  it('measures reachedSelectorPresent false when the selector is absent from the DOM', async () => {
    const runner = makeCheckRunner({
      browser: signalDriver,
      providers: [],
      config: testConfig({
        surfaces: [{ id: 'integration-screen', url: fixture.url, files: [], reachedWhen: '#never-rendered-marker' }],
      }),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
      transcriptTabCap: 2,
    });

    const scan = await runner.scan({ id: 'integration-screen', url: fixture.url });

    expect(scan.reachedSelectorPresent).toBe(false);
    expect(scan.reachedWhenSelector).toBe('#never-rendered-marker');
    // Readiness waits the whole signal budget for a selector that never matches.
  }, 30_000);

  it('reports the address the browser ended on after a real redirect, not the one requested', async () => {
    const page = await driver.open(fixture.gatedUrl);
    try {
      await page.gotoReady();
      expect(await page.currentUrl()).toContain('/sign-in.html');
    } finally {
      await page.close();
    }
  });

  it('records the page data requests a real server refused as unauthenticated', async () => {
    // The primary signal, through a real Chromium against a real 401. The fixture never leaves its
    // own address and mounts nothing that looks like a login form, so the refused requests are the
    // only thing there is to see.
    const page = await driver.open(fixture.expiredSessionUrl);
    try {
      await page.gotoReady();
      const refused = await page.unauthorizedApiRequests();
      expect(refused).toHaveLength(3);
      expect(refused.some((url) => url.endsWith('/api/v2/me'))).toBe(true);
      // The address never changed, which is exactly why a URL comparison cannot catch this.
      expect(await page.currentUrl()).toBe(fixture.expiredSessionUrl);
    } finally {
      await page.close();
    }
  });

  it('records nothing for a healthy load, and nothing for a real 403', async () => {
    // 403 means the request was authenticated and the identity is not allowed to have the thing.
    // A signed-in scan can legitimately meet it, so reading it as a dead session would turn a
    // correct run into a coverage gap.
    const healthy = await driver.open(fixture.reachedScreenUrl);
    try {
      await healthy.gotoReady();
      expect(await healthy.unauthorizedApiRequests()).toEqual([]);
    } finally {
      await healthy.close();
    }

    const forbidden = await driver.open(fixture.forbiddenApiUrl);
    try {
      await forbidden.gotoReady();
      expect(await forbidden.unauthorizedApiRequests()).toEqual([]);
    } finally {
      await forbidden.close();
    }

    const runner = makeCheckRunner({
      browser: driver,
      providers: [],
      config: testConfig({
        appBaseUrl: fixture.url,
        surfaces: [{ id: 'forbidden-screen', url: fixture.forbiddenApiUrl, files: [] }],
      }),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
      transcriptTabCap: 5,
      sessionConfigured: true,
    });
    const scan = await runner.scan({ id: 'forbidden-screen', url: fixture.forbiddenApiUrl });
    expect(scan.gaps).toEqual([]);
    // Three real page opens and a scan, each carrying its own navigation and settle. The default
    // per-test budget in this suite is not built for that, so this one states its own.
  }, 30_000);

  it('refuses to measure a screen whose own data requests came back 401', async () => {
    const barrierOnEveryPage = alwaysFiringProvider('expired-session-screen');
    const runner = makeCheckRunner({
      browser: driver,
      providers: [barrierOnEveryPage],
      config: testConfig({
        appBaseUrl: fixture.url,
        surfaces: [{ id: 'expired-session-screen', url: fixture.expiredSessionUrl, files: [] }],
      }),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
      transcriptTabCap: 5,
      sessionConfigured: true,
    });

    const scan = await runner.scan({ id: 'expired-session-screen', url: fixture.expiredSessionUrl });

    expect(scan.gaps).toHaveLength(1);
    expect(scan.gaps[0]).toMatchObject({ ref: fixture.expiredSessionUrl, state: 'not-covered' });
    expect(scan.gaps[0]?.reason).toContain('401');
    expect(scan.gaps[0]?.reason).toContain('/api/v2/...');
    expect(scan.drafts).toEqual([]);
    expect(scan.stops).toEqual([]);
    expect(scan.applicability).toEqual([]);
  });

  it('scans the same page normally when no session was configured', async () => {
    // A signed-out scan meets 401s as a matter of course, and nobody asserted otherwise, so the
    // refused-request rule stays silent and the screen is measured.
    const runner = makeCheckRunner({
      browser: driver,
      providers: [],
      config: testConfig({
        appBaseUrl: fixture.url,
        surfaces: [{ id: 'expired-session-screen', url: fixture.expiredSessionUrl, files: [] }],
      }),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
      transcriptTabCap: 5,
      sessionConfigured: false,
    });

    const scan = await runner.scan({ id: 'expired-session-screen', url: fixture.expiredSessionUrl });

    expect(scan.gaps).toEqual([]);
  });

  it('catches a 401 that only arrives after readiness, during the walk', async () => {
    // The timing window, through a real Chromium and a real 401. Readiness needs four equal DOM
    // counts 500 ms apart plus 500 ms of network quiet, so this stable shell settles in about
    // 1.5 s and the fixture's identity request at three seconds has not been sent yet. The first
    // read of the record is empty; the second, after the walk and the providers, is not.
    const page = await driver.open(fixture.lateUnauthorizedUrl);
    try {
      await page.gotoReady();
      expect(await page.unauthorizedApiRequests()).toEqual([]);
    } finally {
      await page.close();
    }

    // A provider that takes a couple of seconds, which is what a real stack does: axe alone runs
    // for seconds on a large screen. It puts the second read of the refused-request record well
    // after the fixture's identity request, which is the situation being reproduced.
    const slowProvider: Provider = {
      id: 'slow',
      layer: 'test',
      capabilities: ['live'],
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        return [];
      },
    };
    const runner = makeCheckRunner({
      browser: driver,
      providers: [alwaysFiringProvider('late-screen'), slowProvider],
      config: testConfig({
        appBaseUrl: fixture.url,
        surfaces: [{ id: 'late-screen', url: fixture.lateUnauthorizedUrl, files: [] }],
      }),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
      transcriptTabCap: 5,
      sessionConfigured: true,
    });

    const scan = await runner.scan({ id: 'late-screen', url: fixture.lateUnauthorizedUrl });

    expect(scan.gaps).toHaveLength(1);
    expect(scan.gaps[0]?.reason).toContain('401');
    // Everything the walk and the providers collected before the refusal showed up is discarded.
    expect(scan.drafts).toEqual([]);
    expect(scan.stops).toEqual([]);
    expect(scan.applicability).toEqual([]);
  }, 30_000);

  it('does not report a tooltip its own walk opened as a barrier', async () => {
    // The false positive this closes. The walk focuses the control, the tooltip mounts outside any
    // landmark, focusBody blurs it, and the element lingers through its fade out. axe reported it
    // as a NEW region violation on an unchanged page about one run in five. Content the scanner
    // caused is not the page, so the providers wait for it to go.
    const runner = makeCheckRunner({
      browser: driver,
      providers: [axeProvider],
      config: testConfig({
        appBaseUrl: fixture.url,
        surfaces: [{ id: 'tooltip-screen', url: fixture.tooltipOnFocusUrl, files: [] }],
      }),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
      transcriptTabCap: 5,
    });

    // Repeated, because the defect was intermittent: about one run in five before the wait.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const scan = await runner.scan({ id: 'tooltip-screen', url: fixture.tooltipOnFocusUrl });
      // Nothing about the tooltip node itself, and no orphan-content violation, which is the
      // shape axe reported it in on the real application.
      expect(scan.drafts.filter((draft) => draft.elementPath === '#tip')).toEqual([]);
      expect(scan.drafts.filter((draft) => draft.rule === 'region')).toEqual([]);
      // The whole page is clean, so any draft at all would be the scanner reporting on itself.
      expect(scan.drafts).toEqual([]);
    }
  }, 60_000);

  it('sees a password field inside an open shadow root at the requested address', async () => {
    // The widened secondary signal. The URL never changed and document.querySelectorAll finds
    // nothing, so only a locator that pierces shadow roots can catch this.
    const page = await driver.open(fixture.shadowSignInUrl);
    try {
      await page.gotoReady();
      expect(await page.queryAll('input[type="password"]')).toEqual([]);
      expect(await page.countEverywhere('input[type="password"]')).toBe(1);
    } finally {
      await page.close();
    }

    const runner = makeCheckRunner({
      browser: driver,
      providers: [],
      config: testConfig({
        surfaces: [{ id: 'shadow-screen', url: fixture.shadowSignInUrl, files: [] }],
      }),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
      transcriptTabCap: 5,
      sessionConfigured: true,
    });

    const scan = await runner.scan({ id: 'shadow-screen', url: fixture.shadowSignInUrl });

    expect(scan.gaps).toHaveLength(1);
    expect(scan.gaps[0]?.reason).toContain('asks for a password');
    expect(scan.drafts).toEqual([]);
  });

  it('refuses to measure a screen a real redirect sent to a sign-in page', async () => {
    // The whole failure, end to end and with nothing faked: the server answers the screen request
    // with a 302 to its sign-in page, Chromium follows it, and the scan must report a coverage gap
    // instead of filing the sign-in page's barriers under this screen id.
    const barrierOnEveryPage = alwaysFiringProvider('gated-screen');
    const runner = makeCheckRunner({
      browser: driver,
      providers: [barrierOnEveryPage],
      config: testConfig({
        surfaces: [{ id: 'gated-screen', url: fixture.gatedUrl, files: [] }],
      }),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
      transcriptTabCap: 5,
    });

    const scan = await runner.scan({ id: 'gated-screen', url: fixture.gatedUrl });

    expect(scan.gaps).toHaveLength(1);
    expect(scan.gaps[0]).toMatchObject({ ref: fixture.gatedUrl, state: 'not-covered' });
    expect(scan.gaps[0]?.reason).toContain('redirected away');
    expect(scan.gaps[0]?.reason).toContain('/sign-in.html');
    // The return address the server put in the query is a token-shaped value in the real world,
    // so it never reaches the reason.
    expect(scan.gaps[0]?.reason).not.toContain('next=');
    expect(scan.drafts).toEqual([]);
    expect(scan.stops).toEqual([]);
    expect(scan.applicability).toEqual([]);
  });

  it('scans normally when a real redirect still lands on the screen that was asked for', async () => {
    // The false positive that would make this check unusable. A 302 to the canonical address of
    // the same screen is an ordinary thing for an application to do, and the screen was measured.
    const runner = makeCheckRunner({
      browser: driver,
      providers: [],
      config: testConfig({
        surfaces: [
          {
            id: 'redirected-screen',
            url: fixture.redirectToScreenUrl,
            files: [],
            reachedWhen: '#labelledby-button',
          },
        ],
      }),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
      transcriptTabCap: 5,
    });

    const scan = await runner.scan({ id: 'redirected-screen', url: fixture.redirectToScreenUrl });

    expect(scan.gaps).toEqual([]);
    expect(scan.stops.length).toBeGreaterThan(0);
    // Positive proof the screen really was reached, not merely that nothing objected.
    expect(scan.reachedSelectorPresent).toBe(true);
  });

  it('scans a sign-in screen normally when the sign-in screen is what was asked for', async () => {
    // Condition two on its own must never fire. An operator who lists the sign-in page as a
    // surface is asking for it to be measured, password field and all.
    const signInUrl = `${fixture.reachedScreenUrl.replace('/labelledby.html', '/sign-in.html')}`;
    const runner = makeCheckRunner({
      browser: driver,
      providers: [],
      config: testConfig({
        surfaces: [{ id: 'sign-in', url: signInUrl, files: [], reachedWhen: '#password' }],
      }),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
      transcriptTabCap: 5,
    });

    const scan = await runner.scan({ id: 'sign-in', url: signInUrl });

    expect(scan.gaps).toEqual([]);
    expect(scan.reachedSelectorPresent).toBe(true);
    expect(scan.stops.length).toBeGreaterThan(0);
  });

  it('waits for a page that keeps mounting after the network is quiet', async () => {
    const page = await driver.open(fixture.lateMountUrl);
    try {
      await page.gotoReady();
      // The fixture mounts in two bursts after load. A network-only wait sees at most the first.
      expect(await page.queryAll('button.mounted')).toHaveLength(104);
    } finally {
      await page.close();
    }
  });

  it('gives up on the readiness budget the config sets and names the DOM phase', async () => {
    // Three seconds proves the operator budget is what ran, because neither the old engine
    // constant nor the shipped default is three seconds.
    const impatient = makeRealBrowserDriver({ readyTimeoutMs: 3_000 });
    try {
      const page = await impatient.open(fixture.neverSettlesUrl);
      const startedAt = Date.now();
      await expect(page.gotoReady()).rejects.toThrow(/DOM did not stop changing within 3000ms/);
      expect(Date.now() - startedAt).toBeLessThan(8_000);
      await page.close();
    } finally {
      await impatient.close();
    }
  });

  it('names the network phase when a request never returns', async () => {
    const impatient = makeRealBrowserDriver({ readyTimeoutMs: 3_000 });
    try {
      const page = await impatient.open(fixture.hangingRequestUrl);
      await expect(page.gotoReady()).rejects.toThrow(
        /network activity did not go quiet within 3000ms/,
      );
      await page.close();
    } finally {
      await impatient.close();
    }
  });

  it('carries the config budget through buildDeps into a disclosed coverage gap', async () => {
    const deps = await buildDeps(testConfig({ readyTimeoutMs: 3_000 }));
    try {
      const scan = await deps.checkRunner.scan({ id: 'never-settles', url: fixture.neverSettlesUrl });

      expect(scan.stops).toEqual([]);
      expect(scan.gaps).toHaveLength(1);
      expect(scan.gaps[0]).toMatchObject({ ref: fixture.neverSettlesUrl, state: 'not-covered' });
      expect(scan.gaps[0]?.reason).toContain('DOM did not stop changing within 3000ms');
    } finally {
      await deps.browser.close();
    }
  });

  describe('a declared readiness signal, through a real browser', () => {
    // One helper for every case: a real Chromium scan of one address under a configured session,
    // with a provider that reports a barrier on whatever page it is given, then the unseen pass
    // run() applies. A screen that is not seen ends with no drafts and a not-covered gap.
    async function scanWithSignal(
      url: string,
      reachedWhen: SurfaceConfig['reachedWhen'],
    ): Promise<{ unseen: boolean; drafts: number; gaps: string[] }> {
      const runner = makeCheckRunner({
        browser: signalDriver,
        providers: [alwaysFiringProvider('orders')],
        config: testConfig({
          appBaseUrl: fixture.url,
          surfaces: [
            { id: 'orders', url, files: [], ...(reachedWhen === undefined ? {} : { reachedWhen }) },
          ],
        }),
        allowedCapabilities: ['live'],
        stepRunner: makeStepRunner(),
        transcriptTabCap: 5,
        sessionConfigured: true,
      });
      const pass = markUnseenScreens([await runner.scan({ id: 'orders', url })]);
      const screen = pass.screens[0];
      return {
        unseen: pass.unseenScreenIds.includes('orders'),
        drafts: screen?.drafts.length ?? 0,
        gaps: (screen?.gaps ?? []).map((gap) => gap.reason),
      };
    }

    const signInPages: Array<[string, () => string]> = [
      ['a passkey sign-in page', () => fixture.passkeySignInUrl],
      ['a magic-link page', () => fixture.magicLinkUrl],
      ['an authentication wall that answers 200', () => fixture.authWallUrl],
    ];

    for (const [name, urlOf] of signInPages) {
      it(`gaps ${name} when the screen declares a selector`, async () => {
        const result = await scanWithSignal(urlOf(), 'table#orders');
        expect(result.unseen).toBe(true);
        expect(result.drafts).toBe(0);
        expect(result.gaps.some((reason) => reason.includes('table#orders'))).toBe(true);
      }, 30_000);

      it(`gaps ${name} when the screen declares a response`, async () => {
        const result = await scanWithSignal(urlOf(), { response: '/api/data/orders' });
        expect(result.unseen).toBe(true);
        expect(result.drafts).toBe(0);
        expect(result.gaps.some((reason) => reason.includes('/api/data/orders'))).toBe(true);
      }, 30_000);
    }

    it('still scores a passkey sign-in page as the screen when no signal is declared', async () => {
      // The documented limit. Nothing here tells the page apart from the screen.
      const result = await scanWithSignal(fixture.passkeySignInUrl, undefined);
      expect(result.unseen).toBe(false);
      expect(result.gaps).toEqual([]);
      expect(result.drafts).toBe(1);
    }, 30_000);

    it('measures the real screen when both parts of its signal hold', async () => {
      const result = await scanWithSignal(fixture.ordersUrl, {
        selector: 'table#orders',
        response: '/api/data/orders',
      });
      expect(result.unseen).toBe(false);
      expect(result.gaps).toEqual([]);
      expect(result.drafts).toBe(1);
    }, 30_000);

    it('measures a screen whose refused identity call was answered after a token refresh', async () => {
      const result = await scanWithSignal(fixture.ordersRecoveredUrl, {
        selector: 'table#orders',
        response: '/api/data/orders',
      });
      expect(result.gaps).toEqual([]);
      expect(result.drafts).toBe(1);
    }, 30_000);

    it('gaps a screen whose data call was answered 200 with an HTML page', async () => {
      const result = await scanWithSignal(fixture.spaFallbackUrl, { response: '/spa/api/orders' });
      expect(result.unseen).toBe(true);
      expect(result.drafts).toBe(0);
      expect(result.gaps.some((reason) => reason.includes('/spa/api/orders'))).toBe(true);
    }, 30_000);

    it('gaps a page whose only answer to the data path came from a request the walk caused', async () => {
      const result = await scanWithSignal(fixture.fetchOnFocusUrl, { response: '/api/data/orders' });
      expect(result.unseen).toBe(true);
      expect(result.drafts).toBe(0);
      expect(result.gaps.some((reason) => reason.includes('/api/data/orders'))).toBe(true);
    }, 30_000);

    it('still gaps that screen on the refusal when it declares no signal', async () => {
      const result = await scanWithSignal(fixture.ordersRecoveredUrl, undefined);
      expect(result.drafts).toBe(0);
      expect(result.gaps.some((reason) => reason.includes('401'))).toBe(true);
    }, 30_000);
  });

  describe('content that mounts after a frozen pause', () => {
    // The pauses measured against real Chromium when this residual was found. At 1.5 s readiness
    // still waited for the content. From 1.8 s on it settled inside the pause and the scan graded
    // the shell, a header with one link, as the screen.
    const PAUSES_MS = [1_500, 1_800, 2_100, 4_000];

    // Reports one draft when the screen's real content is in the page at the time the checks run,
    // so a scan of the content can be told apart from a scan of the shell.
    const contentProbe: Provider = {
      id: 'late-content-probe',
      layer: 'test',
      capabilities: ['live'],
      run: async ({ page, screen }) => {
        const buttons = await page.queryAll('#late-orders button');
        if (buttons.length === 0) {
          return [];
        }
        return [
          {
            rule: 'late-content-present',
            layer: 'test',
            severity: 'minor' as const,
            evidenceClass: 'deterministic' as const,
            screenId: screen.id,
            elementPath: '#late-orders',
            elementName: null,
            role: null,
            whatUserExperiences: 'placeholder',
            why: 'placeholder',
            fix: 'placeholder',
            evidence: {},
            confidence: 'fail' as const,
          },
        ];
      },
    };

    async function scanAfterPause(
      pauseMs: number,
      reachedWhen: SurfaceConfig['reachedWhen'],
    ): Promise<{ gapped: boolean; walkSawContent: boolean; checksSawContent: boolean }> {
      const url = `${fixture.frozenPauseUrl}?pause=${pauseMs}`;
      const runner = makeCheckRunner({
        browser: driver,
        providers: [contentProbe],
        config: testConfig({
          appBaseUrl: fixture.url,
          surfaces: [
            { id: 'late-orders', url, files: [], ...(reachedWhen === undefined ? {} : { reachedWhen }) },
          ],
        }),
        allowedCapabilities: ['live'],
        stepRunner: makeStepRunner(),
        transcriptTabCap: 5,
      });
      const pass = markUnseenScreens([await runner.scan({ id: 'late-orders', url })]);
      const screen = pass.screens[0];
      return {
        gapped: (screen?.gaps.length ?? 0) > 0,
        walkSawContent: (screen?.stops ?? []).some((stop) => stop.elementPath.includes('#late-orders')),
        checksSawContent: (screen?.drafts ?? []).some((draft) => draft.rule === 'late-content-present'),
      };
    }

    describe('a screen that shows its data and then swaps itself for a sign-in page', () => {
      // The wait must not end on the sign-in page. A response stays seen once it arrived, so it
      // cannot tell the table from what replaced it, and only a selector that holds at a settled
      // moment may end the wait.
      async function scanSwap(
        reachedWhen: SurfaceConfig['reachedWhen'],
        signalTimeoutMs?: number,
        browser: BrowserDriver = driver,
      ): Promise<{ stops: number; drafts: number; gaps: string[]; elapsedMs: number }> {
        const url = fixture.swapToSignInUrl;
        const runner = makeCheckRunner({
          browser,
          providers: [alwaysFiringProvider('orders')],
          config: testConfig({
            appBaseUrl: fixture.url,
            surfaces: [{ id: 'orders', url, files: [], ...(reachedWhen === undefined ? {} : { reachedWhen }) }],
            ...(signalTimeoutMs === undefined ? {} : { signalTimeoutMs }),
          }),
          allowedCapabilities: ['live'],
          stepRunner: makeStepRunner(),
          transcriptTabCap: 5,
          sessionConfigured: true,
        });
        const started = Date.now();
        const scanned = await runner.scan({ id: 'orders', url });
        const elapsedMs = Date.now() - started;
        const screen = markUnseenScreens([scanned]).screens[0];
        return {
          stops: scanned.stops.length,
          drafts: screen?.drafts.length ?? 0,
          gaps: (screen?.gaps ?? []).map((gap) => gap.reason),
          elapsedMs,
        };
      }

      it('gaps the screen when it declares only a response', async () => {
        const result = await scanSwap({ response: '/api/data/orders' });
        expect(result.gaps.length).toBeGreaterThan(0);
        expect(result.drafts).toBe(0);
      }, 30_000);

      it('ends the wait at the signal cap, runs no walk, and names the selector and the cap', async () => {
        const result = await scanSwap('table#orders', 3_000);
        expect(result.stops).toBe(0);
        expect(result.drafts).toBe(0);
        expect(result.gaps.some((reason) => reason.includes('table#orders') && reason.includes('3000'))).toBe(true);
        // The page first settles at about 1.5 s, in its pause, so the cap ends the wait near
        // 4.5 s even though the page mounts and swaps after that. Navigation and the landing read
        // add the rest. The default readiness budget is far longer, so a wait that ran on past the
        // cap would fail here.
        expect(result.elapsedMs).toBeLessThan(7_000);
      }, 30_000);

      it('ends the wait at the signal cap when the table mounts while the probe runs', async () => {
        // The run that made the test above flaky, made certain. The first probe is asked on the
        // shell and answers only after the table has mounted. That answer is about a page that
        // changed after its settled sample, so it cannot end the wait. The page swaps to the
        // sign-in form, the cap runs out, and no walk runs.
        const result = await scanSwap('table#orders', 3_000, slowProbeDriver(driver, 'table#orders'));
        expect(result.stops).toBe(0);
        expect(result.drafts).toBe(0);
        expect(result.gaps.some((reason) => reason.includes('table#orders') && reason.includes('3000'))).toBe(true);
      }, 30_000);
    });

    for (const pauseMs of PAUSES_MS) {
      it(`grades the content that mounts after a ${pauseMs} ms pause when the screen declares a selector`, async () => {
        const result = await scanAfterPause(pauseMs, '#late-orders button');
        // Readiness waited for the selector, so the walk and the checks both ran on the content.
        expect(result.gapped).toBe(false);
        expect(result.walkSawContent).toBe(true);
        expect(result.checksSawContent).toBe(true);
      }, 30_000);

      it(`never passes the shell after a ${pauseMs} ms pause when the screen declares only a response`, async () => {
        // A response does not extend the wait. A request sent after the walk began never counts,
        // so a pause long enough to end readiness ends as a gap, and a shorter one is graded.
        const result = await scanAfterPause(pauseMs, { response: '/api/data/late-orders' });
        expect(result.gapped || (result.walkSawContent && result.checksSawContent)).toBe(true);
        if (!result.gapped) {
          expect(result.walkSawContent).toBe(true);
          expect(result.checksSawContent).toBe(true);
        }
      }, 30_000);
    }
  });

  describe('a screen whose header mounted and whose content did not', () => {
    // The floor is what a real axe scan of the broken screen records, built the way baseline builds
    // it: one entry per identity, with the count of deterministic drafts behind it. The broken
    // screen's buttons, links, and images have no name. The fixed screen names them all. The failed
    // screen never renders the table at all.
    type Content = 'ok' | 'broken' | 'fail';

    async function scanOrders(content: Content, reachedWhen: SurfaceConfig['reachedWhen']): Promise<ScreenScan[]> {
      const url = `${fixture.partialRenderUrl}?content=${content}`;
      const runner = makeCheckRunner({
        browser: driver,
        providers: [axeProvider],
        config: testConfig({
          appBaseUrl: fixture.url,
          surfaces: [{ id: 'orders', url, files: [], ...(reachedWhen === undefined ? {} : { reachedWhen }) }],
        }),
        allowedCapabilities: ['live'],
        stepRunner: makeStepRunner(),
        transcriptTabCap: 5,
      });
      return markUnseenScreens([await runner.scan({ id: 'orders', url })]).screens;
    }

    function floorFrom(screens: ScreenScan[]): EvidenceFloor {
      const entries = new Map<string, EvidenceFloor['entries'][number]>();
      for (const draft of screens.flatMap((screen) => screen.drafts)) {
        if (draft.evidenceClass !== 'deterministic') continue;
        const { elementKey, identityBasis } = computeIdentity(draft);
        const key = identityKey({ screenId: draft.screenId, rule: draft.rule, elementKey });
        const entry = entries.get(key) ?? { screenId: draft.screenId, layer: draft.layer, rule: draft.rule, elementKey, identityBasis, count: 0 };
        entry.count += 1;
        entries.set(key, entry);
      }
      return { version: 2, entries: [...entries.values()] };
    }

    function gateOn(screens: ScreenScan[], floor: EvidenceFloor): GateOutput {
      const url = screens[0]!.url;
      return gate({
        coverage: {
          changedFiles: ['src/OrdersPage.tsx'],
          affected: [{ screenId: 'orders', url, provenance: 'manual' }],
          unresolvedFiles: [],
          gaps: screens.flatMap((screen) => screen.gaps),
          nothingToCheck: false,
        },
        guardDivergedPaths: [],
        drafts: screens.flatMap((screen) => screen.drafts),
        floor,
        waivers: [],
        now: '2026-01-01T00:00:00.000Z',
        cleanlyScannedScreens: new Set(screens.filter((s) => s.gaps.length === 0).map((s) => s.screenId)),
        renderEvidence: renderEvidenceOf(screens),
      });
    }

    let floor: EvidenceFloor;
    beforeAll(async () => {
      floor = floorFrom(await scanOrders('broken', undefined));
    }, 30_000);

    it('records the barriers a real axe scan finds in the table', () => {
      const rules = floor.entries.map((entry) => entry.rule);
      expect(rules).toContain('button-name');
      expect(rules).toContain('image-alt');
      expect(rules).toContain('link-name');
      // A real axe key, never a hand-written one: the image entry names its element by path.
      const image = floor.entries.find((entry) => entry.rule === 'image-alt');
      expect(image?.identityBasis).toBe('structural');
    });

    it('claims nothing fixed when the content did not mount, keeps the verdict, and gives the notice', async () => {
      const out = gateOn(await scanOrders('fail', undefined), floor);
      expect(out.findings.filter((finding) => finding.status === 'fixed')).toEqual([]);
      expect(out.floorGaps).toEqual([]);
      expect(out.accessibilityVerdict).toBe('verified');
      expect(out.floorUnconfirmed).toHaveLength(1);
      expect(out.floorUnconfirmed[0]!.rules).toEqual([...new Set(floor.entries.map((e) => e.rule))].sort());
      expect(out.floorUnconfirmed[0]!.barriers).toBe(floor.entries.reduce((total, e) => total + e.count, 0));
    }, 30_000);

    it('does not claim a genuinely fixed image barrier fixed with no signal, and gives the notice', async () => {
      // The image is not focusable and the fixed page raises no draft on it, so nothing in the run
      // meets that element. Fixed and never mounted look the same here, so it is not paid down.
      const out = gateOn(await scanOrders('ok', undefined), floor);
      expect(out.findings.some((finding) => finding.status === 'fixed' && finding.rule === 'image-alt')).toBe(false);
      expect(out.accessibilityVerdict).toBe('verified');
      expect(out.floorUnconfirmed.flatMap((u) => u.rules)).toContain('image-alt');
      expect(out.floorUnconfirmed.flatMap((u) => u.rules)).toContain('button-name');
      expect(out.summary).toContain('not seen, not claimed fixed');
    }, 30_000);

    it('pays down every barrier on the fixed screen when its signal held', async () => {
      const out = gateOn(await scanOrders('ok', 'table#orders'), floor);
      expect(out.floorUnconfirmed).toEqual([]);
      expect(out.findings.filter((finding) => finding.status === 'fixed').map((f) => f.rule).sort()).toEqual(
        floor.entries.map((entry) => entry.rule).sort(),
      );
      expect(out.accessibilityVerdict).toBe('verified');
    }, 30_000);
  });

  describe('a selector that mounts while the readiness probe runs', () => {
    it('reports the barrier that mounts after the selector, from a request the selector started', async () => {
      // The table mounts while the probe runs, and in the same task the page asks for details the
      // server answers four seconds later. The answer mounts a button with no accessible name. A
      // wait that reported held on the probe alone handed the scan a page still loading: the walk
      // and the checks ran before the button existed, the table was still there after them, and
      // the screen came out clean with no gap.
      const url = fixture.detailsAfterSignalUrl;
      const runner = makeCheckRunner({
        browser: slowProbeDriver(driver, 'table#orders'),
        providers: [axeProvider],
        config: testConfig({
          appBaseUrl: fixture.url,
          surfaces: [{ id: 'orders', url, files: [], reachedWhen: 'table#orders' }],
        }),
        allowedCapabilities: ['live'],
        stepRunner: makeStepRunner(),
        transcriptTabCap: 5,
      });
      const pass = markUnseenScreens([await runner.scan({ id: 'orders', url })]);
      const screen = pass.screens[0];
      expect(pass.unseenScreenIds).toEqual([]);
      expect(screen?.gaps ?? []).toEqual([]);
      expect((screen?.drafts ?? []).map((draft) => draft.rule)).toContain('button-name');
    }, 30_000);
  });

  it('returns null for ignored or missing AX nodes', async () => {
    const page = await driver.open(fixture.url);
    try {
      await page.gotoReady();
      await expect(page.axAt('#hidden-ignored')).resolves.toBeNull();
      await expect(page.axAt('#does-not-exist')).resolves.toBeNull();
    } finally {
      await page.close();
    }
  });
});

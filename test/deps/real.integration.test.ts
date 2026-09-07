import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Provider } from '../../src/contracts/index.js';
import { buildDeps } from '../../src/deps/build.js';
import { makeRealBrowserDriver } from '../../src/deps/real.js';
import { makeCheckRunner } from '../../src/providers/check-runner.js';
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
  close: () => Promise<void>;
}

async function readFixture(name: string): Promise<string> {
  return readFile(fileURLToPath(new URL(`../../fixtures/live/${name}`, import.meta.url)), 'utf8');
}

async function makeFixtureServer(): Promise<FixtureServer> {
  const html = await readFixture('labelledby.html');
  const pages: Record<string, string> = {
    '/late-mount.html': await readFixture('late-mount.html'),
    '/never-settles.html': await readFixture('never-settles.html'),
    '/hanging-request.html': await readFixture('hanging-request.html'),
    '/sign-in.html': await readFixture('sign-in.html'),
    '/expired-session-app.html': await readFixture('expired-session-app.html'),
    '/shadow-sign-in.html': await readFixture('shadow-sign-in.html'),
  };

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

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('real browser driver integration', () => {
  let fixture: FixtureServer;
  const driver = makeRealBrowserDriver();

  beforeAll(async () => {
    fixture = await makeFixtureServer();
  });

  afterAll(async () => {
    await driver.close();
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
      browser: driver,
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
  });

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
    expect(scan.gaps[0]?.reason).toContain('/api/v2/me');
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

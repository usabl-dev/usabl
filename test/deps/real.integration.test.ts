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
  };

  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (reqUrl.pathname === '/' || reqUrl.pathname === '/labelledby.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
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

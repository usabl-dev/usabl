import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Provider } from '../../src/contracts/index.js';
import { makeRealBrowserDriver } from '../../src/deps/real.js';
import { makeCheckRunner } from '../../src/providers/check-runner.js';
import { makeStepRunner } from '../../src/providers/keyboard-walk/steps.js';
import { testConfig } from '../helpers.js';

interface FixtureServer {
  url: string;
  close: () => Promise<void>;
}

async function makeFixtureServer(): Promise<FixtureServer> {
  const fixturePath = fileURLToPath(new URL('../../fixtures/live/labelledby.html', import.meta.url));
  const html = await readFile(fixturePath, 'utf8');

  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (reqUrl.pathname === '/' || reqUrl.pathname === '/labelledby.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
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
    close: async () =>
      new Promise<void>((resolve, reject) => {
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

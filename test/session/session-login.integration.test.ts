/**
 * `usabl session` then `usabl check` on an app with a real login, end to end.
 *
 * The app is a small local server: a sign-in form that sets a session cookie after a form post,
 * and an orders screen that redirects to the form without that cookie. The orders screen has one
 * known accessibility barrier, a button with no name, that the sign-in page does not have. So a
 * finding on it proves the scan ran signed in.
 *
 * The session is captured through the real browser path with the person replaced by code: the test
 * fills the form and confirms. Everything after that is the real CLI: check reads the saved file
 * from the repository, and doctor reads its git state and mode from the real repository and disk.
 *
 * The cookie value is low entropy on purpose (SECRETPOISON), because CI scans the whole history for
 * secrets. It is also the string every assertion looks for in the output, and must never find.
 *
 * Gated behind USABL_INTEGRATION=1 like the other browser tests, because it launches Chromium.
 */
import { execFile } from 'node:child_process';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { main } from '../../src/cli.js';
import { gitIgnoreState, SESSION_STATE_PATH } from '../../src/deps/session.js';
import { openSessionBrowser, runSession, type SessionBrowser } from '../../src/session/index.js';
import { loadConfig } from '../../src/cli.js';

const execFileAsync = promisify(execFile);
const COOKIE = 'sid=SECRETPOISON';

const SIGN_IN = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign in</title></head>
<body><main><h1>Sign in</h1>
<form method="post" action="/login">
  <label for="user">User name</label><input id="user" name="user" autocomplete="username">
  <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password">
  <button type="submit">Sign in</button>
</form></main></body></html>`;

const ORDERS = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Orders</title></head>
<body><main><h1>Orders</h1>
<table id="orders"><caption>Open orders</caption><thead><tr><th scope="col">Order</th></tr></thead><tbody><tr><td>1001</td></tr></tbody></table>
<button type="button" class="icon-only"></button>
</main></body></html>`;

function startApp(): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const signedIn = (req.headers.cookie ?? '').split(/;\s*/).includes(COOKIE);
    if (req.method === 'POST' && url.pathname === '/login') {
      req.resume();
      req.on('end', () => {
        res.writeHead(303, { location: '/orders', 'set-cookie': `${COOKIE}; Path=/; HttpOnly; SameSite=Lax` });
        res.end();
      });
      return;
    }
    if (url.pathname === '/login') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(SIGN_IN);
      return;
    }
    if (url.pathname === '/' || url.pathname === '/orders') {
      if (!signedIn) {
        res.writeHead(302, { location: '/login' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(ORDERS);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('usabl session on an app with a login', { timeout: 180_000 }, () => {
  let app: Server;
  let base: string;
  let repo: string;
  let originalCwd: string;
  let stdout: string[];
  let stderr: string[];

  beforeAll(async () => {
    app = await startApp();
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    repo = await mkdtemp(join(tmpdir(), 'usabl-session-login-'));
    await mkdir(join(repo, 'src'));
    await writeFile(join(repo, '.gitignore'), '.usabl/\n');
    await writeFile(join(repo, 'src', 'App.tsx'), "import { Orders } from './Orders'\nexport const App = () => <Orders />\n");
    await writeFile(join(repo, 'src', 'Orders.tsx'), 'export const Orders = () => <main />\n');
    await writeFile(
      join(repo, 'usabl.config.json'),
      `${JSON.stringify(
        {
          appBaseUrl: base,
          uiFileGlobs: ['src/**'],
          discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
          surfaces: [{ id: 'orders', url: `${base}/orders`, files: ['src/Orders.tsx'], reachedWhen: '#orders' }],
          guardedPaths: [],
        },
        null,
        2,
      )}\n`,
    );
    await git(repo, 'init', '--quiet');
    await git(repo, 'config', 'user.name', 'usabl test');
    await git(repo, 'config', 'user.email', 'test@usabl.invalid');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '--quiet', '-m', 'seed');
    // The change under check touches the orders screen.
    await appendFile(join(repo, 'src', 'Orders.tsx'), '// changed\n');
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => app.close(() => resolve()));
    await rm(repo, { recursive: true, force: true });
  });

  beforeEach(() => {
    originalCwd = process.cwd();
    process.chdir(repo);
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
  });

  async function cli(argv: string[]): Promise<Captured> {
    stdout.length = 0;
    stderr.length = 0;
    const code = await main(argv);
    return { code, stdout: stdout.join(''), stderr: stderr.join('') };
  }

  // A person, replaced by code: sign in through the form, wait for the signed-in screen, confirm.
  async function signIn(browser: SessionBrowser): Promise<'confirmed'> {
    const page = browser.page as Page;
    await page.goto(`${base}/login`);
    await page.fill('#user', 'ada');
    await page.fill('#password', 'not-a-real-password');
    await page.click('button[type="submit"]');
    await page.waitForSelector('#orders');
    return 'confirmed';
  }

  it('scans the signed-in screen after usabl session, and the sign-in page before it', async () => {
    // Before: no session, so the scan lands on the sign-in page and the screen is a gap.
    const before = await cli(['check', '--json']);
    const signedOut = JSON.parse(before.stdout) as { findings: Array<{ rule: string }>; coverage: { gaps: Array<{ screenId?: string }> } };
    expect(signedOut.findings.some((finding) => finding.rule === 'button-name')).toBe(false);
    expect(signedOut.coverage.gaps.length).toBeGreaterThan(0);

    const lines: string[] = [];
    const saved = await runSession({
      cwd: repo,
      configPath: 'usabl.config.json',
      loadConfig: (path) => loadConfig(path, () => {}),
      gitIgnoreState,
      openBrowser: (url) => openSessionBrowser(url, { headless: true }),
      waitForConfirmation: signIn,
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
    });
    expect(saved, lines.join('\n')).toBe(0);
    expect((await stat(join(repo, SESSION_STATE_PATH))).mode & 0o777).toBe(0o600);
    expect((await stat(join(repo, '.usabl', 'session'))).mode & 0o777).toBe(0o700);
    expect(await readFile(join(repo, SESSION_STATE_PATH), 'utf8')).toContain('SECRETPOISON');
    expect(lines.join('\n')).not.toContain('SECRETPOISON');

    // After: check finds the saved session itself and scans the orders screen signed in.
    const after = await cli(['check', '--json']);
    const signedIn = JSON.parse(after.stdout) as {
      findings: Array<{ rule: string; screenId: string }>;
      coverage: { gaps: unknown[] };
    };
    expect(signedIn.findings.some((finding) => finding.rule === 'button-name' && finding.screenId === 'orders')).toBe(true);
    expect(signedIn.coverage.gaps).toEqual([]);
    for (const run of [before, after]) {
      expect(run.stdout + run.stderr).not.toContain('SECRETPOISON');
    }

    // Doctor on the same repository: ignored, owner-only, live.
    const healthy = await cli(['doctor']);
    expect(healthy.stdout).toMatch(/\[wired\] authenticated session/);
    expect(healthy.stdout).not.toContain('SECRETPOISON');
  });

  it('doctor flags the session file once it has mode 0644', async () => {
    await chmod(join(repo, SESSION_STATE_PATH), 0o644);
    try {
      const report = await cli(['doctor']);
      expect(report.stdout).toMatch(/\[drifted\] authenticated session/);
      expect(report.stdout).toContain(`chmod 600 ${SESSION_STATE_PATH}`);
      expect(report.stdout).not.toContain('SECRETPOISON');
    } finally {
      await chmod(join(repo, SESSION_STATE_PATH), 0o600);
    }
  });

  it('doctor flags the session file once git would commit it, and check refuses to use it', async () => {
    await writeFile(join(repo, '.gitignore'), '');
    try {
      const report = await cli(['doctor']);
      expect(report.stdout).toMatch(/\[drifted\] authenticated session/);
      expect(report.stdout).toContain('.usabl/');
      expect(report.stdout).toContain('.gitignore');

      await expect(main(['check', '--json'])).rejects.toThrow(/git does not ignore/);
      expect(stdout.join('') + stderr.join('')).not.toContain('SECRETPOISON');
    } finally {
      await writeFile(join(repo, '.gitignore'), '.usabl/\n');
    }
  });
});

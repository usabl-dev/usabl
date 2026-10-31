/**
 * `usabl session` saves a signed-in Playwright storage state for later scans.
 *
 * The file is a credential, so these tests hold four rules: nothing is saved where git could
 * commit it, the file is 0600 in a 0700 folder, nothing that is in it is ever printed, and a
 * session usabl could not read in full is never saved as if it were whole. The browser is a fake
 * here; test/session/session-login.integration.test.ts drives a real one through a real login.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UsablConfig } from '../../src/contracts/index.js';
import { SESSION_STATE_PATH, type GitIgnoreState } from '../../src/deps/session.js';
import { runSession, type SessionBrowser, type SessionDeps } from '../../src/session/index.js';
import { testConfig } from '../helpers.js';

const SIGNED_IN = {
  cookies: [
    { name: 'sid', value: 'SECRETPOISON', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' },
  ],
  origins: [{ origin: 'http://127.0.0.1:5173', localStorage: [{ name: 'token', value: 'SECRETPOISON' }] }],
};

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Harness {
  deps: SessionDeps;
  out: string[];
  err: string[];
  opened: string[];
  closed: number;
}

async function harness(
  options: {
    ignore?: GitIgnoreState | GitIgnoreState[];
    state?: unknown;
    confirmation?: 'confirmed' | 'browser-closed';
    storageStateFails?: boolean;
    config?: UsablConfig;
  } = {},
): Promise<Harness> {
  const cwd = await mkdtemp(join(tmpdir(), 'usabl-session-'));
  dirs.push(cwd);
  const ignoreAnswers = Array.isArray(options.ignore) ? [...options.ignore] : [options.ignore ?? 'ignored'];
  const h: Harness = { deps: undefined as never, out: [], err: [], opened: [], closed: 0 };
  const browser: SessionBrowser = {
    page: null,
    storageState: async () => {
      if (options.storageStateFails === true) {
        throw new Error('Target page, context or browser has been closed');
      }
      return options.state ?? SIGNED_IN;
    },
    whenClosed: () => new Promise(() => {}),
    close: async () => {
      h.closed += 1;
    },
  };
  h.deps = {
    cwd,
    configPath: 'usabl.config.json',
    loadConfig: async () => options.config ?? testConfig({ appBaseUrl: 'http://127.0.0.1:5173/app?token=SECRETPOISON' }),
    gitIgnoreState: async () => (ignoreAnswers.length > 1 ? ignoreAnswers.shift()! : ignoreAnswers[0]!),
    openBrowser: async (url) => {
      h.opened.push(url);
      return browser;
    },
    waitForConfirmation: async () => options.confirmation ?? 'confirmed',
    out: (line) => h.out.push(line),
    err: (line) => h.err.push(line),
  };
  return h;
}

function printed(h: Harness): string {
  return [...h.out, ...h.err].join('\n');
}

describe('usabl session', () => {
  it('saves the signed-in state at 0600 in a 0700 folder and prints nothing that is in it', async () => {
    const h = await harness();
    expect(await runSession(h.deps)).toBe(0);

    const file = join(h.deps.cwd, SESSION_STATE_PATH);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(SIGNED_IN);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(h.deps.cwd, '.usabl', 'session'))).mode & 0o777).toBe(0o700);
    expect(h.closed).toBe(1);
    // It opens the app's origin only, so a query string in the configured URL is never shown.
    expect(h.opened).toEqual(['http://127.0.0.1:5173']);
    expect(printed(h)).toContain(SESSION_STATE_PATH);
    expect(printed(h)).not.toContain('SECRETPOISON');
    // It points at the readiness signal that keeps a sign-in page from being scored as the screen.
    expect(printed(h)).toContain('reachedWhen');
  });

  it('tightens a session file and folder left with looser modes', async () => {
    const h = await harness();
    const folder = join(h.deps.cwd, '.usabl', 'session');
    await mkdir(folder, { recursive: true });
    await chmod(folder, 0o755);
    await writeFile(join(h.deps.cwd, SESSION_STATE_PATH), '{}');
    await chmod(join(h.deps.cwd, SESSION_STATE_PATH), 0o644);

    expect(await runSession(h.deps)).toBe(0);
    expect((await stat(join(h.deps.cwd, SESSION_STATE_PATH))).mode & 0o777).toBe(0o600);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
  });

  it.each([
    ['not-ignored' as const, 'Add the line .usabl/ to .gitignore'],
    ['tracked' as const, `git rm --cached ${SESSION_STATE_PATH}`],
    ['unknown' as const, 'could not confirm'],
  ])('refuses before opening a browser when git says %s', async (state, fix) => {
    const h = await harness({ ignore: state });
    expect(await runSession(h.deps)).toBe(2);
    expect(h.opened).toEqual([]);
    expect(printed(h)).toContain(fix);
    await expect(stat(join(h.deps.cwd, SESSION_STATE_PATH))).rejects.toThrow();
  });

  it('checks again before it writes, in case .gitignore changed while the person signed in', async () => {
    const h = await harness({ ignore: ['ignored', 'not-ignored'] });
    expect(await runSession(h.deps)).toBe(2);
    expect(h.opened).toHaveLength(1);
    expect(printed(h)).toContain('.gitignore');
    await expect(stat(join(h.deps.cwd, SESSION_STATE_PATH))).rejects.toThrow();
  });

  it('saves nothing when the browser quit before usabl could read the session', async () => {
    const h = await harness({ confirmation: 'browser-closed' });
    expect(await runSession(h.deps)).toBe(2);
    expect(printed(h)).toMatch(/nothing was saved/i);
    await expect(stat(join(h.deps.cwd, SESSION_STATE_PATH))).rejects.toThrow();
  });

  it('saves nothing when reading the session fails, and does not echo the browser error', async () => {
    const h = await harness({ storageStateFails: true });
    expect(await runSession(h.deps)).toBe(2);
    expect(printed(h)).toMatch(/nothing was saved/i);
    expect(printed(h)).not.toContain('Target page');
    await expect(stat(join(h.deps.cwd, SESSION_STATE_PATH))).rejects.toThrow();
  });

  it('saves nothing when the browser holds no cookies and no site storage', async () => {
    const h = await harness({ state: { cookies: [], origins: [] } });
    expect(await runSession(h.deps)).toBe(2);
    expect(printed(h)).toMatch(/sign in/i);
    await expect(stat(join(h.deps.cwd, SESSION_STATE_PATH))).rejects.toThrow();
  });
});

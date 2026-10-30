/**
 * `usabl session`: sign in once in a real browser and save the session for later scans.
 *
 * It opens a headed browser at the app's origin. The person signs in. When they press Enter in the
 * terminal, or close the browser tab, usabl reads the Playwright storage state and saves it to
 * SESSION_STATE_PATH. `usabl check`, `usabl baseline`, and the dev overlay use that file while it
 * exists and git ignores it.
 *
 * The file is a credential, and the rules here follow from that:
 *  - It is written only where git ignores it. That is checked before the browser opens, so nobody
 *    signs in for nothing, and again right before the write, in case .gitignore changed meanwhile.
 *  - The folder is 0700 and the file 0600. The file is written beside its final name and renamed,
 *    so a reader never sees half a session, and a looser mode left by an earlier file is replaced.
 *  - Nothing in it is printed: not a cookie, a value, a token, or a browser error that might quote
 *    one. Output says only where the file is and how many cookies and sites it holds.
 *  - A session usabl could not read in full is not saved. If the browser quits before usabl reads
 *    it, nothing is written, rather than an older or partial copy.
 *
 * This command mints no verdict and never runs a check.
 */
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { UsablConfig } from '../contracts/index.js';
import {
  SESSION_STATE_DIR,
  SESSION_STATE_PATH,
  sessionIgnoreProblem,
  type GitIgnoreState,
} from '../deps/session.js';

// How the browser ended up, from usabl's side. last-page-closed means the person closed the tab:
// the browser process is still there, so the session can still be read. disconnected means the
// browser itself is gone, and the session with it.
export type BrowserEnd = 'last-page-closed' | 'disconnected';

export interface SessionBrowser {
  // The page the person signs in on. The command never reads it; a test drives it.
  page: unknown;
  storageState(): Promise<unknown>;
  whenClosed(): Promise<BrowserEnd>;
  close(): Promise<void>;
}

// confirmed: read the session now. browser-closed: the browser quit, so there is nothing to read.
export type Confirmation = 'confirmed' | 'browser-closed';

export interface SessionDeps {
  cwd: string;
  configPath: string;
  loadConfig(path: string): Promise<UsablConfig>;
  gitIgnoreState(cwd: string, path: string): Promise<GitIgnoreState>;
  openBrowser(url: string): Promise<SessionBrowser>;
  waitForConfirmation(browser: SessionBrowser): Promise<Confirmation>;
  out(line: string): void;
  err(line: string): void;
}

const NOTHING_SAVED =
  'The browser closed before usabl could read the session, so nothing was saved. Run usabl session again, sign in, and press Enter here, or close the tab rather than quitting the browser.';

function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

// Sites that hold local storage or IndexedDB. Counted, never named: an origin list is not secret,
// but nothing about the session's contents needs to reach the terminal.
function originsWithStorage(state: unknown): number {
  const origins: unknown = typeof state === 'object' && state !== null ? Reflect.get(state, 'origins') : undefined;
  if (!Array.isArray(origins)) {
    return 0;
  }
  return origins.filter((origin) => {
    if (typeof origin !== 'object' || origin === null) {
      return false;
    }
    return countOf(Reflect.get(origin, 'localStorage')) > 0 || countOf(Reflect.get(origin, 'indexedDB')) > 0;
  }).length;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Writes the session at 0600 inside a 0700 folder, through a temporary file and a rename. */
export async function writeSessionFile(cwd: string, contents: string): Promise<string> {
  const folder = join(cwd, SESSION_STATE_DIR);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  // mkdir leaves an existing folder as it was, and its mode is also cut by the umask, so set it.
  await chmod(folder, 0o700);
  const target = join(cwd, SESSION_STATE_PATH);
  const temporary = join(folder, `.storage-state-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return target;
}

export async function runSession(deps: SessionDeps): Promise<number> {
  const config = await deps.loadConfig(deps.configPath);
  const before = sessionIgnoreProblem(await deps.gitIgnoreState(deps.cwd, SESSION_STATE_PATH), SESSION_STATE_PATH);
  if (before !== null) {
    deps.err(`usabl: no browser was opened, because a session cannot be saved here. ${before}`);
    return 2;
  }
  // The origin only. A configured URL can carry a path, a query, or a fragment, and none of it is
  // needed to sign in or safe to assume is not a token.
  const origin = new URL(config.appBaseUrl).origin;
  deps.out(`Opening a browser at ${origin}. Sign in to the app there.`);
  deps.out('When you are signed in, press Enter here, or close the browser tab.');

  const browser = await deps.openBrowser(origin);
  let state: unknown;
  try {
    const confirmation = await deps.waitForConfirmation(browser);
    if (confirmation === 'browser-closed') {
      deps.err(`usabl: ${NOTHING_SAVED}`);
      return 2;
    }
    try {
      state = await browser.storageState();
    } catch {
      // The browser's own error is not repeated: the reason is the same, and the text is not ours.
      deps.err(`usabl: ${NOTHING_SAVED}`);
      return 2;
    }
  } finally {
    await browser.close();
  }

  const cookies = countOf(typeof state === 'object' && state !== null ? Reflect.get(state, 'cookies') : undefined);
  const sites = originsWithStorage(state);
  if (cookies === 0 && sites === 0) {
    deps.err(
      'usabl: The browser holds no cookies and no site storage, so there is no session to save. Nothing was saved. Run usabl session again and sign in before you press Enter.',
    );
    return 2;
  }

  const after = sessionIgnoreProblem(await deps.gitIgnoreState(deps.cwd, SESSION_STATE_PATH), SESSION_STATE_PATH);
  if (after !== null) {
    deps.err(`usabl: nothing was saved. ${after}`);
    return 2;
  }
  await writeSessionFile(deps.cwd, `${JSON.stringify(state, null, 2)}\n`);

  deps.out(
    `Saved the session to ${SESSION_STATE_PATH}. Only your user can read it. It holds ${plural(cookies, 'cookie', 'cookies')} and storage for ${plural(sites, 'site', 'sites')}.`,
  );
  deps.out(
    'usabl check, usabl baseline, and the dev overlay sign in with it while it exists and git ignores it. Delete the file to scan signed out.',
  );
  deps.out(
    'Give each screen a reachedWhen readiness signal, so a sign-in page shown after the session ends is never scored as the screen. usabl init lists the screens that need one.',
  );
  return 0;
}

/**
 * The real browser: Chromium with one page at the app's origin, headed for a person. The browser
 * stays open after the person closes the last tab, which is what lets usabl read the session at
 * that point. headless is for tests, which sign in through the page themselves.
 */
export async function openSessionBrowser(url: string, options: { headless?: boolean } = {}): Promise<SessionBrowser> {
  const { chromium } = await import('playwright');
  let browser;
  try {
    browser = await chromium.launch({ headless: options.headless ?? false });
  } catch {
    throw new Error(
      'usabl session could not open a browser window. It needs a desktop session and the Playwright Chromium build (npx playwright install chromium). On a machine with no display, save a Playwright storage state another way and point USABL_STORAGE_STATE at it.',
    );
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  const ended = new Promise<BrowserEnd>((resolve) => {
    browser.on('disconnected', () => resolve('disconnected'));
    const watch = (watched: typeof page): void => {
      watched.on('close', () => {
        if (context.pages().length === 0) {
          resolve('last-page-closed');
        }
      });
    };
    watch(page);
    context.on('page', watch);
  });
  try {
    await page.goto(url);
  } catch {
    await browser.close();
    throw new Error(
      `usabl session could not open ${url}. Start the app, or fix appBaseUrl in the usabl config, then run usabl session again.`,
    );
  }
  return {
    page,
    storageState: () => context.storageState(),
    whenClosed: () => ended,
    close: () => browser.close(),
  };
}

/** Waits for Enter in the terminal or for the browser to close, whichever comes first. */
export async function waitForPerson(browser: SessionBrowser): Promise<Confirmation> {
  const lines = createInterface({ input: process.stdin });
  try {
    return await Promise.race([
      new Promise<Confirmation>((resolve) => lines.once('line', () => resolve('confirmed'))),
      browser.whenClosed().then((end): Confirmation => (end === 'last-page-closed' ? 'confirmed' : 'browser-closed')),
    ]);
  } finally {
    lines.close();
  }
}

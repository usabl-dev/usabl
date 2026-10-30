/**
 * The authenticated session usabl scans with: a Playwright storage state file named by the
 * `USABL_STORAGE_STATE` environment variable, or, when that is unset, the file `usabl session`
 * saved at SESSION_STATE_PATH. The saved file is never loaded when a trusted ref is set or in CI.
 *
 * Why an environment variable and not a flag or a config field. Two of the three operator
 * surfaces have no argv at all (the Claude Stop hook and the Vite overlay both build Deps
 * from a config file), so a flag would leave them unable to reach a login-gated screen. A
 * config field is worse: the file holds live session cookies and tokens, and a path sitting
 * in committed config invites someone to commit the file it points at. A path to a storage
 * state never enters committed config.
 *
 * This unit resolves and validates the path only. It reads session contents for two purposes
 * and no others: confirming the file parses, and reading cookie expiry times to tell a live
 * session from a dead one. It never puts the path, a cookie value, or any other content into a
 * message, because all of them can be private.
 */
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

export const STORAGE_STATE_ENV_VAR = 'USABL_STORAGE_STATE';

// Where `usabl session` saves the signed-in state, relative to the repository root. The folder is
// usabl's local state folder, which a repository ignores as a whole. The folder is made 0700 and
// the file 0600, because the file holds live session cookies.
export const SESSION_STATE_DIR = '.usabl/session';
export const SESSION_STATE_PATH = `${SESSION_STATE_DIR}/storage-state.json`;
// The one line a repository adds to .gitignore so the session file can never be committed.
export const SESSION_GITIGNORE_LINE = '.usabl/';

/**
 * What git says about a path, for the one question that matters for a credential: could it be
 * committed? `ignored` is the only answer that lets a session file be written or loaded inside a
 * repository. `tracked` means git already holds the file, whatever .gitignore says. `outside`
 * means the path is not in this repository, so this repository cannot commit it. `unknown` means
 * git could not answer (no repository, or no git), and is never read as ignored.
 */
export type GitIgnoreState = 'ignored' | 'tracked' | 'not-ignored' | 'outside' | 'unknown';

const execFileAsync = promisify(execFile);

function exitCodeOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const code = Reflect.get(error, 'code');
  return typeof code === 'number' ? code : null;
}

export async function gitIgnoreState(cwd: string, path: string): Promise<GitIgnoreState> {
  let root: string;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
    root = stdout.trim();
  } catch {
    return 'unknown';
  }
  const absolute = resolve(cwd, path);
  const fromRoot = relative(root, absolute);
  if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    return 'outside';
  }
  // A tracked file is never reported by check-ignore, so ask about tracking first. That way the
  // message can name the command that untracks it, not only the .gitignore line.
  try {
    await execFileAsync('git', ['ls-files', '--error-unmatch', '--', fromRoot], { cwd: root });
    return 'tracked';
  } catch (error) {
    if (exitCodeOf(error) !== 1) {
      return 'unknown';
    }
  }
  try {
    await execFileAsync('git', ['check-ignore', '--quiet', '--', fromRoot], { cwd: root });
    return 'ignored';
  } catch (error) {
    return exitCodeOf(error) === 1 ? 'not-ignored' : 'unknown';
  }
}

/**
 * Why a session file inside the repository must not be written or loaded, with the fix, or null
 * when git ignores it. The path in the message is the fixed repository path, never a private one.
 */
export function sessionIgnoreProblem(state: GitIgnoreState, path: string): string | null {
  if (state === 'ignored' || state === 'outside') {
    return null;
  }
  if (state === 'tracked') {
    return `git already tracks ${path}, so the session in it would be committed. Run git rm --cached ${path}, add the line ${SESSION_GITIGNORE_LINE} to .gitignore, and sign in again with usabl session.`;
  }
  if (state === 'not-ignored') {
    return `git does not ignore ${path}, so the session in it could be committed. Add the line ${SESSION_GITIGNORE_LINE} to .gitignore.`;
  }
  return `usabl could not confirm that git ignores ${path}: this folder is not a git repository, or git is not installed. usabl keeps a session file only where git ignores it. Run usabl from the repository root.`;
}

// Group and other permission bits. Any of them set means another account on the machine can read
// or change the session file. Windows has no such bits, so the check is skipped there.
export function sessionModeProblem(mode: number, pathForFix: string): string | null {
  if (process.platform === 'win32' || (mode & 0o077) === 0) {
    return null;
  }
  return `other users on this machine can read ${pathForFix === SESSION_STATE_PATH ? pathForFix : 'the session file'}, and it holds live session cookies. Run chmod 600 ${pathForFix}.`;
}

export type EnvReader = Readonly<Record<string, string | undefined>>;

/**
 * The raw operator intent: a trimmed path, or null for "no session configured". An empty or
 * whitespace-only value is unset. Shells set a variable to the empty string in ways nobody
 * means as a session (an unset variable expanded into an export, a cleared CI variable), and
 * treating that as a path would turn a no-session run into a hard failure.
 */
export function readStorageStateEnv(env: EnvReader): string | null {
  const raw = env[STORAGE_STATE_ENV_VAR];
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Why a run must not load the saved session file, or null when it may.
 *
 * A run with a trusted ref is the pull request gate, and a run in CI may be one. There the checkout
 * holds the code under review, and the gate starts that code (npm run dev) before the judge scans.
 * That code can write the saved file, and the same pull request can make git ignore it, so the
 * ignore rule proves nothing. Loading it would let the pull request choose the signed-in state the
 * judge scans. In those runs only USABL_STORAGE_STATE, which the trusted workflow sets from a
 * secret, can sign the judge in.
 *
 * CI is the standard CI variable that hosted runners set. Any value other than empty, false, or 0
 * counts, so an unusual spelling errs toward not loading the file.
 */
export function savedSessionBlock(options: { env: EnvReader; trustedRef?: string | undefined }): 'trusted-ref' | 'ci' | null {
  if (options.trustedRef !== undefined) {
    return 'trusted-ref';
  }
  const ci = options.env['CI']?.trim().toLowerCase();
  if (ci !== undefined && ci !== '' && ci !== 'false' && ci !== '0') {
    return 'ci';
  }
  return null;
}

/**
 * Whether a parsed storage state has nothing left in it that could authenticate anything.
 *
 * This refuses a run, so the bar is not "probably dead". It is "there is nothing here that could
 * possibly work". Four conditions must all hold:
 *
 *   1. Every cookie in the file carries a real expiry. Playwright writes a negative `expires` for a
 *      session cookie, which dies with the browser and states no expiry to judge. One session
 *      cookie, or one cookie with no `expires` field at all, could still be carrying the session,
 *      so it makes the whole file unjudgeable.
 *   2. There is at least one such cookie, and every one of them is already past. A file with no
 *      cookies at all says nothing.
 *   3. No origin holds any local storage or any IndexedDB. A bearer or refresh token is recorded in
 *      local storage as an opaque name and value with no expiry field, and Playwright also records
 *      and restores IndexedDB per origin, which is where token libraries that outgrew local storage
 *      keep their state. Either one is a thing that might still authenticate.
 *   4. The state declares no top-level `credentials`. Playwright records virtual authenticator
 *      credentials there, which is how a passkey session is carried, and they have no expiry to
 *      judge at all.
 *
 * The consequence is deliberate: this errs entirely toward letting a dead session through. A
 * session cookie beside a stale dated cookie is not refused. One IndexedDB entry, one local storage
 * entry, or one passkey credential beside a wall of expired cookies is not refused. A missed dead
 * session is caught at scan time by the rules in providers/redirected.ts, which measure the page
 * rather than guessing from a file. A false refusal has no such backstop: it stops a working run.
 *
 * What this check can see: expiry times the file itself states, and whether the other stores are
 * empty.
 *
 * What this check cannot see: whether the server still honours a cookie that has not expired,
 * whether a token in local storage or IndexedDB is live, whether a passkey credential still
 * authenticates, whether a cookie is scoped to the origin being scanned, and any session ended
 * server side ahead of its stated dates.
 *
 * `nowMs` is milliseconds since the Unix epoch and must be finite. Infinity would put every expiry
 * in the past and refuse every session; NaN would fail every comparison and accept every session.
 * Both are programmer errors in the caller's clock and neither may be answered with a boolean.
 *
 * Exported so the rule is testable on its own, without a file or a clock.
 */
export function isStorageStateExpired(parsed: unknown, nowMs: number): boolean {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new TypeError('isStorageStateExpired needs a finite millisecond timestamp');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return false;
  }
  if (holdsAnyOriginState(Reflect.get(parsed, 'origins'))) {
    return false;
  }
  if (holdsAnyCredential(Reflect.get(parsed, 'credentials'))) {
    return false;
  }
  const cookies: unknown = Reflect.get(parsed, 'cookies');
  if (!Array.isArray(cookies)) {
    return false;
  }
  const nowSeconds = nowMs / 1000;
  let dated = 0;
  for (const cookie of cookies) {
    if (typeof cookie !== 'object' || cookie === null) {
      // Not a cookie shape this understands, so the file is not one this may rule on.
      return false;
    }
    const expires: unknown = Reflect.get(cookie, 'expires');
    if (typeof expires !== 'number' || !Number.isFinite(expires) || expires <= 0) {
      // A session cookie, or a cookie with no usable expiry. It could still be carrying the
      // session, so nothing here can be called dead.
      return false;
    }
    if (expires > nowSeconds) {
      return false;
    }
    dated += 1;
  }
  return dated > 0;
}

/**
 * Whether any origin in a storage state holds local storage or IndexedDB. A permissive read on
 * purpose: anything that is not confidently empty counts as holding something, because the caller
 * uses this only to decide not to refuse.
 */
function holdsAnyOriginState(origins: unknown): boolean {
  if (origins === undefined || origins === null) {
    return false;
  }
  if (!Array.isArray(origins)) {
    // Present in some shape this does not understand. Treat it as holding something.
    return true;
  }
  return origins.some((origin) => {
    if (typeof origin !== 'object' || origin === null) {
      return true;
    }
    return (
      holdsAnyEntry(Reflect.get(origin, 'localStorage')) ||
      holdsAnyEntry(Reflect.get(origin, 'indexedDB'))
    );
  });
}

/** Whether a per-origin store records anything. Absent is empty; any other unknown shape is not. */
function holdsAnyEntry(entries: unknown): boolean {
  if (entries === undefined || entries === null) {
    return false;
  }
  return !Array.isArray(entries) || entries.length > 0;
}

/**
 * Whether the state declares any virtual authenticator credential. Playwright records these at the
 * top level and restores them into the browser, so one is a passkey the state can still sign with.
 */
function holdsAnyCredential(credentials: unknown): boolean {
  return holdsAnyEntry(credentials);
}

/**
 * Resolve the storage state a run should open its browser contexts with.
 *
 * Precedence: an explicit path from the caller wins over the environment. Bespoke measurement
 * scripts already pass one directly, and a stray variable in the operator's shell must not
 * silently redirect a script that was told exactly which session to use.
 *
 * An unreadable, unparseable, or expired environment path fails here, at composition, rather
 * than at scan time. Failing late is how issue #152 happened: the check runner turns a browser
 * open failure into a not-covered coverage gap, so a bad session path would be absorbed into a
 * minted verdict instead of stopping the run, and Playwright's own ENOENT message would
 * carry the path into the Result JSON that gets posted as a pull request comment. An
 * operator who exported the variable asked for an authenticated scan, so the honest outcome
 * of a path usabl cannot read is a loud stop, never a signed-out scan wearing a verdict.
 *
 * An expired session is the same failure wearing a readable file. Every byte parses, so nothing
 * upstream objects, and the browser opens the application's sign-in page instead of the screen
 * that was asked for. Stopping here costs one file read and no browser at all.
 *
 * The explicit caller path is not checked here. It is a programmatic argument, its caller
 * owns its own error handling, and validating it would change behaviour this fix does not own.
 *
 * `now` is milliseconds since the Unix epoch and defaults to the wall clock. It is a parameter
 * so the expiry rule can be tested against a fixed instant.
 */
export async function resolveStorageStatePath(options: {
  explicit?: string | undefined;
  env: EnvReader;
  now?: number;
  // The repository root. When it is given and the variable is unset, the file `usabl session`
  // saved there is used if it exists. When it is absent, only the variable is read, as before.
  cwd?: string;
  // Asks git whether a path could be committed. A port so tests need no repository.
  gitIgnoreState?: (cwd: string, path: string) => Promise<GitIgnoreState>;
  // Where a warning goes, such as a session file other users can read.
  warn?: (line: string) => void;
  // The ref the run is judged against. When it is set, or the run is in CI, the saved file is
  // never loaded. See savedSessionBlock.
  trustedRef?: string | undefined;
}): Promise<string | null> {
  if (options.explicit !== undefined) {
    return options.explicit;
  }
  const path = readStorageStateEnv(options.env);
  if (path === null) {
    if (options.cwd === undefined) {
      return null;
    }
    const block = savedSessionBlock(options);
    if (block !== null) {
      await reportSkippedSavedSession(options.cwd, block, options.warn);
      return null;
    }
    return resolveSavedSession(options as typeof options & { cwd: string });
  }
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    // The path is deliberately absent from this message. It can name a private location, and
    // the operator who set the variable is the one person who can already read its value.
    throw new Error(
      `${STORAGE_STATE_ENV_VAR} is set but usabl cannot read the file it names. Point it at a readable Playwright storage state JSON file, or unset it to scan signed out.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Contents are never quoted back for the same reason: this file holds live session tokens.
    throw new Error(
      `${STORAGE_STATE_ENV_VAR} names a file that is not JSON. Point it at a Playwright storage state JSON file (see "playwright storageState"), or unset it to scan signed out.`,
    );
  }
  if (isStorageStateExpired(parsed, options.now ?? Date.now())) {
    // No cookie value, no origin, and no path reaches this message. Only the fact of expiry does.
    throw new Error(
      `${STORAGE_STATE_ENV_VAR} names a Playwright storage state whose session has expired. Everything usabl can check in that file is spent: every cookie carries an expiry, every one of those is already past, no origin holds local storage or IndexedDB, and there are no stored credentials. Mint a new session, point ${STORAGE_STATE_ENV_VAR} at the new file, and run usabl again, or unset ${STORAGE_STATE_ENV_VAR} to scan signed out on purpose. The path is not printed here because it can name a private location.`,
    );
  }
  return path;
}

/**
 * Say once that a saved session file exists and was not used, so an operator knows why the run is
 * signed out. Only the file's existence is checked. Nothing in it is read, and only the fixed path
 * usabl chose is named.
 */
async function reportSkippedSavedSession(
  cwd: string,
  block: 'trusted-ref' | 'ci',
  warn: ((line: string) => void) | undefined,
): Promise<void> {
  try {
    await stat(join(cwd, SESSION_STATE_PATH));
  } catch {
    return;
  }
  const why = block === 'trusted-ref' ? 'this run has a trusted ref' : 'this run is in CI';
  warn?.(
    `usabl: not using the saved session at ${SESSION_STATE_PATH}, because ${why}. Here only ${STORAGE_STATE_ENV_VAR} can sign in, so this run scans signed out.`,
  );
}

/**
 * The session file `usabl session` saved, checked the same way the variable's file is, plus one
 * rule of its own: it sits inside the repository, so it is used only when git ignores it. A file
 * git would commit stops the run with the fix. Loading it would put a credential one `git add`
 * away from a pull request, and in a CI checkout it can only be there because someone committed
 * it. A file other users can read is used, with a warning that names the fix.
 */
async function resolveSavedSession(options: {
  cwd: string;
  now?: number;
  gitIgnoreState?: (cwd: string, path: string) => Promise<GitIgnoreState>;
  warn?: (line: string) => void;
}): Promise<string | null> {
  const absolute = join(options.cwd, SESSION_STATE_PATH);
  let raw: string;
  try {
    raw = await readFile(absolute, 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') {
      return null;
    }
    throw new Error(
      `usabl cannot read the saved session at ${SESSION_STATE_PATH}. Check its permissions, or delete it and sign in again with usabl session.`,
    );
  }
  const ignoreState = await (options.gitIgnoreState ?? gitIgnoreState)(options.cwd, SESSION_STATE_PATH);
  const ignoreProblem = sessionIgnoreProblem(ignoreState, SESSION_STATE_PATH);
  if (ignoreProblem !== null) {
    throw new Error(`usabl will not use the saved session: ${ignoreProblem}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Contents are never quoted back: this file holds live session tokens.
    throw new Error(
      `The saved session at ${SESSION_STATE_PATH} is not JSON, so it is not a Playwright storage state. Delete it and sign in again with usabl session.`,
    );
  }
  if (isStorageStateExpired(parsed, options.now ?? Date.now())) {
    throw new Error(
      `The saved session at ${SESSION_STATE_PATH} has expired: every cookie in it is past its expiry and it holds nothing else that could sign in. Sign in again with usabl session, or delete the file to scan signed out on purpose.`,
    );
  }
  const mode = (await stat(absolute)).mode;
  const modeProblem = sessionModeProblem(mode, SESSION_STATE_PATH);
  if (modeProblem !== null) {
    options.warn?.(`usabl: warning: ${modeProblem}`);
  }
  return absolute;
}

/**
 * The authenticated session usabl scans with: a Playwright storage state file named by the
 * `USABL_STORAGE_STATE` environment variable.
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
import { readFile } from 'node:fs/promises';

export const STORAGE_STATE_ENV_VAR = 'USABL_STORAGE_STATE';

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
 * Whether a parsed storage state has nothing left in it that could authenticate anything.
 *
 * This refuses a run, so the bar is not "probably dead". It is "there is nothing here that could
 * possibly work". Three conditions must all hold:
 *
 *   1. Every cookie in the file carries a real expiry. Playwright writes a negative `expires` for a
 *      session cookie, which dies with the browser and states no expiry to judge. One session
 *      cookie, or one cookie with no `expires` field at all, could still be carrying the session,
 *      so it makes the whole file unjudgeable.
 *   2. There is at least one such cookie, and every one of them is already past. A file with no
 *      cookies at all says nothing.
 *   3. No origin holds any local storage. A bearer or refresh token is recorded there as an opaque
 *      name and value with no expiry field, so its presence is a thing that might still
 *      authenticate and this cannot rule on it.
 *
 * The consequence is deliberate: this errs entirely toward letting a dead session through. A
 * session cookie beside a stale dated cookie is not refused. A local storage entry beside a wall
 * of expired cookies is not refused. A missed dead session is caught at scan time by the rules in
 * providers/redirected.ts, which measure the page rather than guessing from a file. A false
 * refusal has no such backstop: it stops a working run for no reason.
 *
 * What this check can see: expiry times the file itself states.
 *
 * What this check cannot see: whether the server still honours a cookie that has not expired,
 * whether a token in local storage is live, whether a cookie is scoped to the origin being
 * scanned, and any session ended server side ahead of its stated dates.
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
  if (holdsAnyLocalStorage(Reflect.get(parsed, 'origins'))) {
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
 * Whether any origin in a storage state holds a local storage entry. A permissive read on purpose:
 * anything that is not confidently empty counts as holding something, because the caller uses this
 * only to decide not to refuse.
 */
function holdsAnyLocalStorage(origins: unknown): boolean {
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
    const entries: unknown = Reflect.get(origin, 'localStorage');
    if (entries === undefined || entries === null) {
      return false;
    }
    return !Array.isArray(entries) || entries.length > 0;
  });
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
}): Promise<string | null> {
  if (options.explicit !== undefined) {
    return options.explicit;
  }
  const path = readStorageStateEnv(options.env);
  if (path === null) {
    return null;
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
      `${STORAGE_STATE_ENV_VAR} names a Playwright storage state whose session has expired: every cookie in it carries an expiry, every one of those is already past, and it holds no local storage, so nothing in the file can authenticate and usabl would scan the sign-in page instead of the application. Mint a new session, point ${STORAGE_STATE_ENV_VAR} at the new file, and run usabl again, or unset ${STORAGE_STATE_ENV_VAR} to scan signed out on purpose. The path is not printed here because it can name a private location.`,
    );
  }
  return path;
}

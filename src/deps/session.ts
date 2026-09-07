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
 * Whether the cookies in a parsed storage state are all past their expiry.
 *
 * Playwright records `expires` on a cookie as seconds since the Unix epoch, and uses a negative
 * value to mark a session cookie, which dies with the browser and carries no expiry to judge.
 * So the only cookies this can rule on are the ones with a positive `expires`. If there are none,
 * this says nothing. If there is at least one and every one of them is already past, the file
 * cannot authenticate anything and a scan opened with it would land on the sign-in page.
 *
 * What this check can see: cookie expiry times written into the file.
 *
 * What this check cannot see: a bearer or refresh token held in `origins[].localStorage`, because
 * a storage state records those as opaque name and value pairs with no expiry field; a cookie the
 * server revoked before its stated expiry; a session ended server side while the cookie still
 * looks current; and a cookie that is live but scoped to a different origin than the one scanned.
 * A false reading in that direction is a missed catch, never a false alarm: this returns true only
 * on expiry times the file itself states, so it can fail to notice a dead session but cannot call
 * a live one dead. The scan-time redirect check is what covers the cases this cannot see.
 *
 * Exported so the rule is testable on its own, without a file or a clock.
 */
export function isStorageStateExpired(parsed: unknown, nowMs: number): boolean {
  if (typeof parsed !== 'object' || parsed === null) {
    return false;
  }
  const cookies: unknown = Reflect.get(parsed, 'cookies');
  if (!Array.isArray(cookies)) {
    return false;
  }
  const expiries: number[] = [];
  for (const cookie of cookies) {
    if (typeof cookie !== 'object' || cookie === null) {
      continue;
    }
    const expires: unknown = Reflect.get(cookie, 'expires');
    // Negative is Playwright's session-cookie marker. Zero, a non-number, and a non-finite value
    // are not expiry times either, so none of them lets this rule on the cookie.
    if (typeof expires !== 'number' || !Number.isFinite(expires) || expires <= 0) {
      continue;
    }
    expiries.push(expires);
  }
  if (expiries.length === 0) {
    return false;
  }
  const nowSeconds = nowMs / 1000;
  return expiries.every((expires) => expires <= nowSeconds);
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
      `${STORAGE_STATE_ENV_VAR} names a Playwright storage state whose session has expired: every cookie in it that carries an expiry is already past it, so usabl would scan the sign-in page instead of the application. Mint a new session, point ${STORAGE_STATE_ENV_VAR} at the new file, and run usabl again, or unset ${STORAGE_STATE_ENV_VAR} to scan signed out on purpose. The path is not printed here because it can name a private location.`,
    );
  }
  return path;
}

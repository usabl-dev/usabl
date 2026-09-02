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
 * This unit resolves and validates the path only. It never reads session contents for any
 * purpose other than confirming the file parses, and it never puts the path or the contents
 * into a message, because both can be private.
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
 * Resolve the storage state a run should open its browser contexts with.
 *
 * Precedence: an explicit path from the caller wins over the environment. Bespoke measurement
 * scripts already pass one directly, and a stray variable in the operator's shell must not
 * silently redirect a script that was told exactly which session to use.
 *
 * An unreadable or unparseable environment path fails here, at composition, rather than at
 * scan time. Failing late is how issue #152 happened: the check runner turns a browser open
 * failure into a not-covered coverage gap, so a bad session path would be absorbed into a
 * minted verdict instead of stopping the run, and Playwright's own ENOENT message would
 * carry the path into the Result JSON that gets posted as a pull request comment. An
 * operator who exported the variable asked for an authenticated scan, so the honest outcome
 * of a path usabl cannot read is a loud stop, never a signed-out scan wearing a verdict.
 *
 * The explicit caller path is not checked here. It is a programmatic argument, its caller
 * owns its own error handling, and validating it would change behaviour this fix does not own.
 */
export async function resolveStorageStatePath(options: {
  explicit?: string | undefined;
  env: EnvReader;
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
  try {
    JSON.parse(raw);
  } catch {
    // Contents are never quoted back for the same reason: this file holds live session tokens.
    throw new Error(
      `${STORAGE_STATE_ENV_VAR} names a file that is not JSON. Point it at a Playwright storage state JSON file (see "playwright storageState"), or unset it to scan signed out.`,
    );
  }
  return path;
}

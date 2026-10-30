/**
 * The session file `usabl session` saves, and how a run picks it up.
 *
 * The file is a credential. A run loads it only when git ignores it, so a session can never ride
 * into a commit, a pull request, or a CI checkout, and no message ever carries what is in it. The
 * fixture values are low entropy on purpose (SECRETPOISON), because CI scans the whole history for
 * secrets and a real-looking token would trip it.
 */
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SESSION_STATE_PATH,
  STORAGE_STATE_ENV_VAR,
  gitIgnoreState,
  resolveStorageStatePath,
  type GitIgnoreState,
} from '../../src/deps/session.js';

const execFileAsync = promisify(execFile);
const NOW_MS = Date.UTC(2026, 9, 29);
const LIVE_STATE = JSON.stringify({
  cookies: [{ name: 'sid', value: 'SECRETPOISON', domain: '127.0.0.1', path: '/', expires: -1 }],
  origins: [],
});
const EXPIRED_STATE = JSON.stringify({
  cookies: [{ name: 'sid', value: 'SECRETPOISON', domain: '127.0.0.1', path: '/', expires: NOW_MS / 1000 - 60 }],
  origins: [],
});

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(state: string | null, mode = 0o600): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'usabl-session-file-'));
  dirs.push(dir);
  if (state !== null) {
    await mkdir(join(dir, '.usabl', 'session'), { recursive: true });
    await writeFile(join(dir, SESSION_STATE_PATH), state);
    await chmod(join(dir, SESSION_STATE_PATH), mode);
  }
  return dir;
}

function resolveIn(
  cwd: string,
  ignore: GitIgnoreState,
  extra: { env?: Record<string, string>; warnings?: string[]; trustedRef?: string } = {},
): Promise<string | null> {
  return resolveStorageStatePath({
    env: extra.env ?? {},
    now: NOW_MS,
    cwd,
    ...(extra.trustedRef === undefined ? {} : { trustedRef: extra.trustedRef }),
    gitIgnoreState: async () => ignore,
    warn: (line) => extra.warnings?.push(line),
  });
}

describe('the saved session file', () => {
  it('is loaded when it exists and git ignores it', async () => {
    const cwd = await workspace(LIVE_STATE);
    await expect(resolveIn(cwd, 'ignored')).resolves.toBe(join(cwd, SESSION_STATE_PATH));
  });

  it('is not looked for when there is none, so the run scans signed out as before', async () => {
    const cwd = await workspace(null);
    await expect(resolveIn(cwd, 'ignored')).resolves.toBeNull();
  });

  it('gives way to USABL_STORAGE_STATE, which the operator named on purpose', async () => {
    const cwd = await workspace(LIVE_STATE);
    const other = join(cwd, 'other-state.json');
    await writeFile(other, LIVE_STATE);
    await expect(resolveIn(cwd, 'not-ignored', { env: { [STORAGE_STATE_ENV_VAR]: other } })).resolves.toBe(other);
  });

  it('stops the run when git would commit it, and says what to add to .gitignore', async () => {
    const cwd = await workspace(LIVE_STATE);
    const failure = resolveIn(cwd, 'not-ignored');
    await expect(failure).rejects.toThrow(SESSION_STATE_PATH);
    await expect(failure).rejects.toThrow('.usabl/');
    await expect(failure).rejects.toThrow('.gitignore');
    await expect(failure).rejects.not.toThrow('SECRETPOISON');
  });

  it('stops the run when git already tracks it, and names the command that untracks it', async () => {
    const cwd = await workspace(LIVE_STATE);
    const failure = resolveIn(cwd, 'tracked');
    await expect(failure).rejects.toThrow(`git rm --cached ${SESSION_STATE_PATH}`);
    await expect(failure).rejects.not.toThrow('SECRETPOISON');
  });

  it('stops the run when usabl cannot ask git, rather than load a file git might commit', async () => {
    const cwd = await workspace(LIVE_STATE);
    await expect(resolveIn(cwd, 'unknown')).rejects.toThrow(/could not confirm/i);
  });

  it('stops the run on an expired session and names the command that saves a new one', async () => {
    const cwd = await workspace(EXPIRED_STATE);
    const failure = resolveIn(cwd, 'ignored');
    await expect(failure).rejects.toThrow('usabl session');
    await expect(failure).rejects.not.toThrow('SECRETPOISON');
  });

  it('stops the run on a file that is not JSON without quoting it', async () => {
    const cwd = await workspace('sid=SECRETPOISON');
    const failure = resolveIn(cwd, 'ignored');
    await expect(failure).rejects.toThrow(/not JSON/);
    await expect(failure).rejects.not.toThrow('SECRETPOISON');
  });

  it('warns, with the fix, when other users on the machine can read it', async () => {
    const cwd = await workspace(LIVE_STATE, 0o644);
    const warnings: string[] = [];
    await expect(resolveIn(cwd, 'ignored', { warnings })).resolves.toBe(join(cwd, SESSION_STATE_PATH));
    expect(warnings.join('\n')).toContain(`chmod 600 ${SESSION_STATE_PATH}`);
    expect(warnings.join('\n')).not.toContain('SECRETPOISON');
  });
});

describe('the saved session file in a gated run', () => {
  // In a pull request run, the code under review starts the app before the trusted judge scans it,
  // so a file in the checkout can have been written by that code. Only the variable, which the
  // trusted workflow sets from a secret, may sign the judge in.
  it('is never loaded when a trusted ref is set, and the run says so once', async () => {
    const cwd = await workspace(LIVE_STATE);
    const warnings: string[] = [];
    await expect(resolveIn(cwd, 'ignored', { warnings, trustedRef: 'main' })).resolves.toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('trusted ref');
    expect(warnings[0]).toContain(STORAGE_STATE_ENV_VAR);
    expect(warnings[0]).not.toContain('SECRETPOISON');
  });

  it('is never loaded in CI, and the run says so once', async () => {
    const cwd = await workspace(LIVE_STATE);
    const warnings: string[] = [];
    await expect(resolveIn(cwd, 'ignored', { warnings, env: { CI: 'true' } })).resolves.toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('CI');
    expect(warnings[0]).toContain(STORAGE_STATE_ENV_VAR);
    expect(warnings[0]).not.toContain('SECRETPOISON');
  });

  it('is not judged at all in a gated run, so a tracked file neither signs in nor stops the run', async () => {
    const cwd = await workspace(LIVE_STATE);
    await expect(resolveIn(cwd, 'tracked', { env: { CI: '1' } })).resolves.toBeNull();
    await expect(resolveIn(cwd, 'not-ignored', { trustedRef: 'origin/main' })).resolves.toBeNull();
  });

  it('says nothing when there is no saved file to skip', async () => {
    const cwd = await workspace(null);
    const warnings: string[] = [];
    await expect(resolveIn(cwd, 'ignored', { warnings, trustedRef: 'main', env: { CI: 'true' } })).resolves.toBeNull();
    expect(warnings).toEqual([]);
  });

  it('still uses USABL_STORAGE_STATE, which the trusted workflow sets', async () => {
    const cwd = await workspace(LIVE_STATE);
    const other = join(cwd, 'other-state.json');
    await writeFile(other, LIVE_STATE);
    const warnings: string[] = [];
    await expect(
      resolveIn(cwd, 'ignored', { warnings, trustedRef: 'main', env: { CI: 'true', [STORAGE_STATE_ENV_VAR]: other } }),
    ).resolves.toBe(other);
    expect(warnings).toEqual([]);
  });

  it('is loaded as before when CI is unset, empty, or false and no trusted ref is set', async () => {
    const cwd = await workspace(LIVE_STATE);
    for (const env of [{}, { CI: '' }, { CI: 'false' }, { CI: '0' }]) {
      await expect(resolveIn(cwd, 'ignored', { env })).resolves.toBe(join(cwd, SESSION_STATE_PATH));
    }
  });
});

describe('gitIgnoreState', () => {
  async function repo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'usabl-ignore-'));
    dirs.push(dir);
    await execFileAsync('git', ['init', '--quiet'], { cwd: dir });
    return dir;
  }

  it('tells ignored, not ignored, tracked, outside, and not a repository apart', async () => {
    const dir = await repo();
    expect(await gitIgnoreState(dir, SESSION_STATE_PATH)).toBe('not-ignored');

    await writeFile(join(dir, '.gitignore'), '.usabl/\n');
    expect(await gitIgnoreState(dir, SESSION_STATE_PATH)).toBe('ignored');

    await mkdir(join(dir, '.usabl', 'session'), { recursive: true });
    await writeFile(join(dir, SESSION_STATE_PATH), '{}');
    await execFileAsync('git', ['add', '--force', SESSION_STATE_PATH], { cwd: dir });
    expect(await gitIgnoreState(dir, SESSION_STATE_PATH)).toBe('tracked');

    const elsewhere = await mkdtemp(join(tmpdir(), 'usabl-outside-'));
    dirs.push(elsewhere);
    expect(await gitIgnoreState(dir, join(elsewhere, 'state.json'))).toBe('outside');
    expect(await gitIgnoreState(elsewhere, 'state.json')).toBe('unknown');
  });
});

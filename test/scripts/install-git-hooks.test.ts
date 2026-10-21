import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The hook installer runs from npm's prepare script. It must touch git config only in a
// usabl clone that a developer installs from. These tests run it against throwaway git repos
// with a fake pre-commit on PATH, so nothing real is installed and the real pre-commit binary
// is never reached.
const INSTALLER = resolve('scripts/install-git-hooks.sh');
const PACKAGE = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { scripts: Record<string, string> };
const PREPARE = PACKAGE.scripts['prepare'] ?? '';

let work: string;
let fakeBin: string;
let log: string;
let home: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'usabl-hooks-'));
  fakeBin = join(work, 'bin');
  home = join(work, 'home');
  log = join(work, 'pre-commit.log');
  await mkdir(fakeBin);
  await mkdir(home);
  const fake = join(fakeBin, 'pre-commit');
  await writeFile(fake, '#!/bin/sh\necho "$@" >> "$PRE_COMMIT_LOG"\n');
  await chmod(fake, 0o755);
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

// A clean environment: no CI flag, no user git config, and a PATH that holds only the fake
// pre-commit, the node running this test, and the system tools.
function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    PRE_COMMIT_LOG: log,
    ...extra,
  };
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, env: env(), encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function hooksPath(cwd: string): string | null {
  const result = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
    cwd,
    env: env(),
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

// A package directory laid out like a usabl clone: the installer under scripts/ and, unless
// told otherwise, the tracked pre-commit config at the root.
async function makePackage(dir: string, options: { preCommitConfig?: boolean } = {}): Promise<void> {
  await mkdir(join(dir, 'scripts'), { recursive: true });
  await copyFile(INSTALLER, join(dir, 'scripts', 'install-git-hooks.sh'));
  if (options.preCommitConfig !== false) {
    await writeFile(join(dir, '.pre-commit-config.yaml'), 'repos: []\n');
  }
}

function runInstaller(cwd: string, extra: Record<string, string> = {}): { status: number | null; stderr: string } {
  const result = spawnSync('bash', ['scripts/install-git-hooks.sh'], { cwd, env: env(extra), encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr };
}

async function preCommitCalls(): Promise<string[]> {
  return existsSync(log) ? (await readFile(log, 'utf8')).trim().split('\n') : [];
}

describe('install-git-hooks.sh installs hooks only in a usabl clone', () => {
  it('installs when the package is its own git repo and npm ran from it', async () => {
    const clone = join(work, 'usabl');
    await makePackage(clone);
    git(clone, 'init', '-q');

    const run = runInstaller(clone, { INIT_CWD: clone });

    expect(run.status).toBe(0);
    expect(await preCommitCalls()).toEqual(['install --install-hooks', 'install --hook-type commit-msg']);
    expect(hooksPath(clone)).toBe('.git/hooks');
  });

  it('installs when INIT_CWD is not set', async () => {
    const clone = join(work, 'usabl');
    await makePackage(clone);
    git(clone, 'init', '-q');

    expect(runInstaller(clone).status).toBe(0);
    expect(await preCommitCalls()).toHaveLength(2);
  });

  it('installs when INIT_CWD names the package root through a symlink', async () => {
    const clone = join(work, 'usabl');
    await makePackage(clone);
    git(clone, 'init', '-q');
    const link = join(work, 'usabl-link');
    await symlink(clone, link);

    expect(runInstaller(clone, { INIT_CWD: link }).status).toBe(0);
    expect(await preCommitCalls()).toHaveLength(2);
  });

  it("leaves a parent repository's husky hooks alone when the package is a folder inside it", async () => {
    // A source copy of usabl inside another project. The package has no .git of its own, so git
    // finds the parent repo, and the installer used to repoint the parent's hooks.
    const parent = join(work, 'parent');
    await mkdir(parent);
    git(parent, 'init', '-q');
    git(parent, 'config', '--local', 'core.hooksPath', '.husky');
    const nested = join(parent, 'vendor', 'usabl');
    await makePackage(nested);

    const run = runInstaller(nested, { INIT_CWD: nested });

    expect(run.status).toBe(0);
    expect(await preCommitCalls()).toEqual([]);
    expect(hooksPath(parent)).toBe('.husky');
  });

  it('does nothing when the package root has no .pre-commit-config.yaml', async () => {
    const clone = join(work, 'usabl');
    await makePackage(clone, { preCommitConfig: false });
    git(clone, 'init', '-q');
    git(clone, 'config', '--local', 'core.hooksPath', '.husky');

    expect(runInstaller(clone, { INIT_CWD: clone }).status).toBe(0);
    expect(await preCommitCalls()).toEqual([]);
    expect(hooksPath(clone)).toBe('.husky');
  });

  it('does nothing when npm ran from another directory, as in a git dependency install', async () => {
    // npm clones a git dependency into a temp directory with its own .git and runs prepare
    // there. INIT_CWD is the consumer's directory, not the clone.
    const tempClone = join(work, 'npm-git-clone');
    await makePackage(tempClone);
    git(tempClone, 'init', '-q');
    const consumer = join(work, 'consumer');
    await mkdir(consumer);

    expect(runInstaller(tempClone, { INIT_CWD: consumer }).status).toBe(0);
    expect(await preCommitCalls()).toEqual([]);
    expect(hooksPath(tempClone)).toBeNull();
  });

  it('does nothing when the package is not in a git repo', async () => {
    const plain = join(work, 'plain');
    await makePackage(plain);

    expect(runInstaller(plain, { INIT_CWD: plain }).status).toBe(0);
    expect(await preCommitCalls()).toEqual([]);
  });
});

describe('the prepare script', () => {
  function runPrepare(cwd: string): number | null {
    return spawnSync(PREPARE, { cwd, env: env(), shell: true, encoding: 'utf8' }).status;
  }

  it('exits 0 when the package has no hook installer, as in the published tarball', async () => {
    expect(PREPARE).not.toBe('');
    const unpacked = join(work, 'unpacked');
    await mkdir(unpacked);
    expect(runPrepare(unpacked)).toBe(0);
  });

  it('runs the hook installer when it is present and keeps its exit status', async () => {
    const clone = join(work, 'clone');
    await mkdir(join(clone, 'scripts'), { recursive: true });
    await writeFile(join(clone, 'scripts', 'install-git-hooks.sh'), 'echo ran > marker\nexit 7\n');

    expect(runPrepare(clone)).toBe(7);
    expect(existsSync(join(clone, 'marker'))).toBe(true);
  });
});

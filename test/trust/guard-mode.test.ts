/**
 * The file mode is part of what a guarded path stores. A file whose executable bit changed, or a
 * file swapped for a symbolic link whose link text equals the old content, is a change to the local
 * guard, the CI policy check, the session pins, and the receipt policy hash. The working tree is
 * read the way git reads it: a symbolic link by its link text, never by what it points at. These
 * tests use real git repositories and the real file reader in temporary folders.
 */
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { Deps, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { makeGitReader } from '../../src/deps/git.js';
import { computePolicyHash } from '../../src/evidence/receipt.js';
import {
  checkGuard,
  computeSessionPins,
  diffSessionPins,
  listDivergedGuardedPathsAtRefs,
  pinsAreCurrent,
} from '../../src/trust/guard.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

async function write(root: string, path: string, contents: string | Buffer): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), contents);
}

const GUARDED = 'vendor/policy';

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: [GUARDED],
};

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'usabl-guard-mode-'));
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['config', 'user.name', 'Test User']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await write(root, 'usabl.config.json', JSON.stringify(config));
  await write(root, 'src/App.tsx', 'export {}\n');
  // An unguarded file whose content is the same text as the link below points at.
  await write(root, 'vendor/data', 'data');
  await write(root, GUARDED, 'data');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'base']);
  return root;
}

function realDeps(root: string): Deps {
  return { ...makeFakeDeps(), git: makeGitReader({ cwd: root }), fs: makeFsGlob({ cwd: root }) };
}

async function commitAll(root: string, message: string): Promise<void> {
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', message]);
}

async function changeScreenOnly(root: string): Promise<void> {
  await write(root, 'src/App.tsx', 'export const changed = true\n');
  await git(root, ['add', 'src/App.tsx']);
  await git(root, ['commit', '-m', 'change a screen only']);
}

describe('the guard compares the file mode', { timeout: 60_000 }, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // Each change is checked by each of the four reads on its own, so each one is seen to fail
  // without the mode.
  const changes: Array<[string, (root: string) => Promise<void>]> = [
    [
      'a guarded file replaced by a symbolic link whose link text equals the old content',
      async (root) => {
        // The link text is "data", the old content. It points at vendor/data, which also holds
        // "data", so a read that follows the link sees the old content too.
        await unlink(join(root, GUARDED));
        await symlink('data', join(root, GUARDED));
      },
    ],
    [
      'a guarded file that becomes executable',
      async (root) => {
        await chmod(join(root, GUARDED), 0o755);
      },
    ],
  ];

  for (const [label, change] of changes) {
    it(`${label} is a change to the local guard`, async () => {
      root = await repo();
      await change(root);
      await expect(checkGuard(realDeps(root), 'HEAD')).resolves.toEqual([GUARDED]);
    });

    it(`${label} is a change to the CI policy check`, async () => {
      root = await repo();
      await git(root, ['branch', 'trusted']);
      await change(root);
      await commitAll(root, label);
      await expect(listDivergedGuardedPathsAtRefs(makeGitReader({ cwd: root }), 'trusted', 'HEAD')).resolves.toEqual([
        GUARDED,
      ]);
    });

    it(`${label} is a change to the session pins`, async () => {
      root = await repo();
      const deps = realDeps(root);
      const pins = await computeSessionPins(deps, config);
      await change(root);
      await commitAll(root, label);
      expect(diffSessionPins(pins, await computeSessionPins(deps, config))).toEqual([GUARDED]);
    });

    it(`${label} is a change to the receipt policy hash`, async () => {
      root = await repo();
      const deps = realDeps(root);
      const hash = await computePolicyHash(deps, [GUARDED]);
      await change(root);
      await commitAll(root, label);
      expect(await computePolicyHash(deps, [GUARDED])).not.toBe(hash);
    });
  }

  it('follows core.fileMode false: the local guard ignores the executable bit, but not the content', async () => {
    root = await repo();
    await git(root, ['config', 'core.fileMode', 'false']);
    const deps = realDeps(root);
    await chmod(join(root, GUARDED), 0o755);
    await expect(checkGuard(deps, 'HEAD')).resolves.toEqual([]);
    await write(root, GUARDED, 'changed');
    await expect(checkGuard(deps, 'HEAD')).resolves.toEqual([GUARDED]);
  });

  it('follows core.fileMode false for a file committed as executable', async () => {
    root = await repo();
    await chmod(join(root, GUARDED), 0o755);
    await commitAll(root, 'the file becomes executable');
    await git(root, ['config', 'core.fileMode', 'false']);
    await chmod(join(root, GUARDED), 0o644);
    await expect(checkGuard(realDeps(root), 'HEAD')).resolves.toEqual([]);
  });

  it('a symbolic link left unchanged is equal everywhere, whatever it points at', async () => {
    root = await repo();
    // The link text differs from what the link points at, so a read that follows it would differ.
    await write(root, 'vendor/other', 'something else');
    await unlink(join(root, GUARDED));
    await symlink('other', join(root, GUARDED));
    await commitAll(root, 'a guarded symbolic link');
    await git(root, ['branch', 'trusted']);
    const deps = realDeps(root);
    const pins = await computeSessionPins(deps, config);
    const hash = await computePolicyHash(deps, [GUARDED]);

    await expect(checkGuard(deps, 'HEAD')).resolves.toEqual([]);
    await changeScreenOnly(root);
    await expect(listDivergedGuardedPathsAtRefs(deps.git, 'trusted', 'HEAD')).resolves.toEqual([]);
    expect(diffSessionPins(pins, await computeSessionPins(deps, config))).toEqual([]);
    expect(await computePolicyHash(deps, [GUARDED])).toBe(hash);
  });

  it('a file left unchanged is equal everywhere', async () => {
    root = await repo();
    await git(root, ['branch', 'trusted']);
    const deps = realDeps(root);
    const pins = await computeSessionPins(deps, config);
    const hash = await computePolicyHash(deps, [GUARDED]);

    await expect(checkGuard(deps, 'HEAD')).resolves.toEqual([]);
    await changeScreenOnly(root);
    await expect(listDivergedGuardedPathsAtRefs(deps.git, 'trusted', 'HEAD')).resolves.toEqual([]);
    expect(diffSessionPins(pins, await computeSessionPins(deps, config))).toEqual([]);
    expect(await computePolicyHash(deps, [GUARDED])).toBe(hash);
  });

  it('a path below a symbolic link to a folder is not a file, as git reads it', async () => {
    root = await repo();
    await write(root, 'real/policy', 'data');
    await git(root, ['rm', '-r', '--cached', '--quiet', 'vendor']);
    await rm(join(root, 'vendor'), { recursive: true, force: true });
    await symlink('real', join(root, 'vendor'));
    // vendor/policy now resolves to real/policy, which holds the old content. git sees no file at
    // vendor/policy, so the guard does not either.
    await expect(checkGuard(realDeps(root), 'HEAD')).resolves.toEqual([GUARDED]);
  });
});

describe('session pins carry the mode in format v4', { timeout: 60_000 }, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  for (const older of ['v2', 'v3']) {
    it(`a stored pin in the ${older} format is read as changed and as not current, even when the file did not change`, async () => {
      root = await repo();
      const deps = realDeps(root);
      const next = await computeSessionPins(deps, config);
      const stored = Object.fromEntries(Object.entries(next).map(([path, pin]) => [path, pin.replace(/^v\d+:/, `${older}:`)]));
      expect(Object.values(next).every((pin) => pin.startsWith('v4:'))).toBe(true);
      expect(pinsAreCurrent(next)).toBe(true);
      expect(pinsAreCurrent(stored)).toBe(false);
      expect(diffSessionPins(stored, next)).toEqual(Object.keys(next).sort());
      expect(diffSessionPins(next, await computeSessionPins(deps, config))).toEqual([]);
    });
  }
});

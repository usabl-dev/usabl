/**
 * The guard compares guarded paths as stored bytes, never as decoded text. Two byte sequences that
 * are not valid UTF-8 can decode to the same text, so a text compare would read a changed file as
 * unchanged. A submodule is its own kind of entry, so no file compares or pins equal to one. These
 * tests use real git repositories and the real file reader in temporary folders.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { Deps, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { makeGitReader } from '../../src/deps/git.js';
import { sha256 } from '../../src/primitives/canonical.js';
import {
  checkGuard,
  computeSessionPins,
  diffSessionPins,
  listDivergedGuardedPathsAtRefs,
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

// Commit ids that are not in the repository, as a submodule's commit usually is not.
const ABSENT_A = 'a'.repeat(40);
const ABSENT_B = 'b'.repeat(40);

// Two bytes that are each invalid UTF-8, so both decode to U+FFFD.
const FE_FILE = Buffer.from([0xfe, 0x41]);
const FF_FILE = Buffer.from([0xff, 0x41]);

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'usabl-guard-bytes-'));
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['config', 'user.name', 'Test User']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await write(root, 'usabl.config.json', JSON.stringify(config));
  await write(root, 'src/App.tsx', 'export {}\n');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'base']);
  return root;
}

async function commitFile(root: string, contents: Buffer | string, message: string): Promise<void> {
  await write(root, GUARDED, contents);
  await git(root, ['add', GUARDED]);
  await git(root, ['commit', '-m', message]);
}

async function pinSubmodule(root: string, id: string, message: string): Promise<void> {
  await git(root, ['update-index', '--add', '--cacheinfo', `160000,${id},${GUARDED}`]);
  await git(root, ['commit', '-m', message]);
}

function realDeps(root: string): Deps {
  return { ...makeFakeDeps(), git: makeGitReader({ cwd: root }), fs: makeFsGlob({ cwd: root }) };
}

describe('the guard compares guarded files as bytes', { timeout: 60_000 }, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('the local guard reads 0xFE changed to 0xFF in a guarded file as changed', async () => {
    root = await repo();
    await commitFile(root, FE_FILE, 'a guarded file with 0xFE');
    await write(root, GUARDED, FF_FILE);
    await expect(checkGuard(realDeps(root), 'HEAD')).resolves.toEqual([GUARDED]);
  });

  it('the CI policy check reads 0xFE changed to 0xFF in a guarded file as changed', async () => {
    root = await repo();
    await commitFile(root, FE_FILE, 'a guarded file with 0xFE');
    await git(root, ['branch', 'trusted']);
    await commitFile(root, FF_FILE, 'the byte becomes 0xFF');
    await expect(listDivergedGuardedPathsAtRefs(makeGitReader({ cwd: root }), 'trusted', 'HEAD')).resolves.toEqual([
      GUARDED,
    ]);
  });

  it('the session pins read 0xFE changed to 0xFF in a guarded file as changed', async () => {
    root = await repo();
    await commitFile(root, FE_FILE, 'a guarded file with 0xFE');
    const deps = realDeps(root);
    const before = await computeSessionPins(deps, config);
    await commitFile(root, FF_FILE, 'the byte becomes 0xFF');
    expect(diffSessionPins(before, await computeSessionPins(deps, config))).toEqual([GUARDED]);
  });

  it('a guarded file that did not change compares and pins as unchanged', async () => {
    root = await repo();
    await commitFile(root, FE_FILE, 'a guarded file with 0xFE');
    await git(root, ['branch', 'trusted']);
    const deps = realDeps(root);
    const before = await computeSessionPins(deps, config);
    await write(root, 'src/App.tsx', 'export const changed = true\n');
    await git(root, ['add', 'src/App.tsx']);
    await git(root, ['commit', '-m', 'change a screen only']);
    await expect(checkGuard(deps, 'HEAD')).resolves.toEqual([]);
    await expect(listDivergedGuardedPathsAtRefs(deps.git, 'trusted', 'HEAD')).resolves.toEqual([]);
    expect(diffSessionPins(before, await computeSessionPins(deps, config))).toEqual([]);
  });
});

describe('a guarded submodule is its own kind of entry', { timeout: 60_000 }, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  for (const [label, lead] of [
    ['the byte 0xFF', Buffer.from([0xff])],
    ['the UTF-8 bytes of U+FFFD', Buffer.from([0xef, 0xbf, 0xbd])],
  ] as const) {
    it(`a file that holds ${label} and the id line never pins or compares equal to the submodule`, async () => {
      root = await repo();
      await pinSubmodule(root, ABSENT_A, 'pin the submodule');
      await git(root, ['branch', 'trusted']);
      const deps = realDeps(root);
      const before = await computeSessionPins(deps, config);
      const collision = Buffer.concat([lead, Buffer.from(`submodule commit ${ABSENT_A}\n`)]);

      // The working tree holds the file while HEAD still records the submodule.
      await git(root, ['rm', '--cached', '--quiet', GUARDED]);
      await write(root, GUARDED, collision);
      await expect(checkGuard(deps, 'HEAD')).resolves.toEqual([GUARDED]);

      await git(root, ['add', GUARDED]);
      await git(root, ['commit', '-m', 'the submodule becomes a file']);
      expect(diffSessionPins(before, await computeSessionPins(deps, config))).toEqual([GUARDED]);
      await expect(listDivergedGuardedPathsAtRefs(deps.git, 'trusted', 'HEAD')).resolves.toEqual([GUARDED]);
    });
  }

  it('a submodule at the same commit pins as unchanged', async () => {
    root = await repo();
    await pinSubmodule(root, ABSENT_A, 'pin the submodule');
    const deps = realDeps(root);
    const before = await computeSessionPins(deps, config);
    await write(root, 'src/App.tsx', 'export const changed = true\n');
    await git(root, ['add', 'src/App.tsx']);
    await git(root, ['commit', '-m', 'change a screen only']);
    expect(diffSessionPins(before, await computeSessionPins(deps, config))).toEqual([]);
  });

  it('a submodule moved to another commit pins and compares as changed', async () => {
    root = await repo();
    await pinSubmodule(root, ABSENT_A, 'pin the submodule');
    await git(root, ['branch', 'trusted']);
    const deps = realDeps(root);
    const before = await computeSessionPins(deps, config);
    await pinSubmodule(root, ABSENT_B, 'move the submodule');
    expect(diffSessionPins(before, await computeSessionPins(deps, config))).toEqual([GUARDED]);
    await expect(listDivergedGuardedPathsAtRefs(deps.git, 'trusted', 'HEAD')).resolves.toEqual([GUARDED]);
  });

  it('the local guard reads a guarded submodule as changed, whether or not it moved', async () => {
    root = await repo();
    await pinSubmodule(root, ABSENT_A, 'pin the submodule');
    const deps = realDeps(root);
    // Not checked out: nothing is at the path.
    await expect(checkGuard(deps, 'HEAD')).resolves.toEqual([GUARDED]);
    // An empty folder at the path, as git leaves a submodule that is not set up.
    await mkdir(join(root, GUARDED), { recursive: true });
    await expect(checkGuard(deps, 'HEAD')).resolves.toEqual([GUARDED]);
  });
});

describe('session pins carry a format version', { timeout: 60_000 }, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('a stored pin with no version is read as changed, even when the file did not change', async () => {
    root = await repo();
    await commitFile(root, 'policy text\n', 'a guarded file');
    const deps = realDeps(root);
    const next = await computeSessionPins(deps, config);
    // The form an earlier release stored: the hash of the decoded text, with no version.
    const unversioned = Object.fromEntries(
      await Promise.all(
        Object.keys(next).map(async (path) => [path, sha256((await deps.git.show('HEAD', path)) ?? '')] as const),
      ),
    );
    expect(diffSessionPins(unversioned, next)).toEqual(Object.keys(next).sort());
    expect(diffSessionPins(next, await computeSessionPins(deps, config))).toEqual([]);
  });
});

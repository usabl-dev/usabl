/**
 * A guarded path can be a submodule. The git reader reads it as the commit id the tree records for
 * it, so the CI policy check compares it as changed exactly when that id changed, whether or not
 * the submodule's commit is in the repository. These tests use real git repositories in temporary
 * folders.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { UsablConfig } from '../../src/contracts/index.js';
import { makeGitReader } from '../../src/deps/git.js';
import { listDivergedGuardedPathsAtRefs } from '../../src/trust/guard.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

async function write(root: string, path: string, contents: string | Buffer): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), contents);
}

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: ['vendor/policy'],
};

// Commit ids that are not in the repository, as a submodule's commit usually is not.
const ABSENT_A = 'a'.repeat(40);
const ABSENT_B = 'b'.repeat(40);

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'usabl-guard-submodule-'));
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['config', 'user.name', 'Test User']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await write(root, 'usabl.config.json', JSON.stringify(config));
  await write(root, 'src/App.tsx', 'export {}\n');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'base']);
  return root;
}

async function pinSubmodule(root: string, id: string, message: string): Promise<void> {
  await git(root, ['update-index', '--add', '--cacheinfo', `160000,${id},vendor/policy`]);
  await git(root, ['commit', '-m', message]);
}

describe('a guarded path that is a submodule', { timeout: 60_000 }, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('compares as changed when its recorded commit changes, though neither commit is here', async () => {
    root = await repo();
    await pinSubmodule(root, ABSENT_A, 'pin the submodule');
    await git(root, ['branch', 'trusted']);
    await pinSubmodule(root, ABSENT_B, 'move the submodule');
    await expect(listDivergedGuardedPathsAtRefs(makeGitReader({ cwd: root }), 'trusted', 'HEAD')).resolves.toEqual([
      'vendor/policy',
    ]);
  });

  it('compares as unchanged when its recorded commit stays the same', async () => {
    root = await repo();
    await pinSubmodule(root, ABSENT_A, 'pin the submodule');
    await git(root, ['branch', 'trusted']);
    await write(root, 'src/App.tsx', 'export const changed = true\n');
    // The submodule folder is not checked out, so only the screen file is staged.
    await git(root, ['add', 'src/App.tsx']);
    await git(root, ['commit', '-m', 'change a screen only']);
    await expect(listDivergedGuardedPathsAtRefs(makeGitReader({ cwd: root }), 'trusted', 'HEAD')).resolves.toEqual([]);
  });

  it('compares a file as changed from a submodule, even when the file holds the text of the id line', async () => {
    root = await repo();
    await pinSubmodule(root, ABSENT_A, 'pin the submodule');
    await git(root, ['branch', 'trusted']);
    const reader = makeGitReader({ cwd: root });
    const submoduleText = (await reader.show('trusted', 'vendor/policy')) ?? '';
    // The submodule becomes a file that holds the same text, as UTF-8 bytes, and then a file that
    // holds the id line git prints.
    await git(root, ['rm', '--cached', '--quiet', 'vendor/policy']);
    await write(root, 'vendor/policy', Buffer.from(submoduleText, 'utf8'));
    await git(root, ['add', 'vendor/policy']);
    await git(root, ['commit', '-m', 'the submodule becomes a file with the same text']);
    await expect(listDivergedGuardedPathsAtRefs(reader, 'trusted', 'HEAD')).resolves.toEqual(['vendor/policy']);
    await write(root, 'vendor/policy', `submodule commit ${ABSENT_A}\n`);
    await git(root, ['add', 'vendor/policy']);
    await git(root, ['commit', '-m', 'the file holds the id line']);
    await expect(listDivergedGuardedPathsAtRefs(reader, 'trusted', 'HEAD')).resolves.toEqual(['vendor/policy']);
    await write(root, 'vendor/policy', `${ABSENT_A}\n`);
    await git(root, ['add', 'vendor/policy']);
    await git(root, ['commit', '-m', 'the file holds the bare id']);
    await expect(listDivergedGuardedPathsAtRefs(reader, 'trusted', 'HEAD')).resolves.toEqual(['vendor/policy']);
  });
});

/**
 * The local guard finds a literal entry on the working tree the way every reader opens its path:
 * one part at a time, never following a link. So on a file system that ignores case, a link named
 * `POLICY` at the literal entry `policy` is the entry, and a folder above the entry that is now a
 * link, a file, or anything but a real folder is reported, since what is below it cannot be
 * compared. Finding the entry costs one look per part of its path, never a listing of the folder
 * that holds it. These tests use real git repositories and the real adapters.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { Deps, FsGlob } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { makeGitReader } from '../../src/deps/git.js';
import { checkGuard, computeSessionPins, expandConfigGuardedSet } from '../../src/trust/guard.js';
import { caseInsensitiveFolder } from '../support/case-insensitive-folder.js';

const execFileAsync = promisify(execFile);
const posixOnly = process.platform === 'win32' ? it.skip : it;
const folded = await caseInsensitiveFolder();
const onFoldedVolume = folded.base === null || process.platform === 'win32' ? it.skip : it;

const roots: string[] = [];

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', ['-c', 'user.name=usabl test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

async function write(root: string, path: string, text = 'x\n'): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

/** A repository under the base folder whose committed config names the literal entries. */
async function repoWith(base: string, config: { requirements?: string; guardedPaths: string[] }, committed: string[]): Promise<string> {
  const root = await mkdtemp(join(base, 'usabl-guard-walk-'));
  roots.push(root);
  await git(root, ['init', '-q', '--initial-branch=main']);
  await write(root, 'usabl.config.json', JSON.stringify(config) + '\n');
  for (const path of committed) {
    await write(root, path);
  }
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-q', '-m', 'base']);
  return root;
}

function realDeps(root: string, fs: FsGlob = makeFsGlob({ cwd: root })): Deps {
  return { ...makeFakeDeps(), git: makeGitReader({ cwd: root }), fs };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe(`a literal entry on a file system that ignores case${folded.reason === null ? '' : ` (skipped: ${folded.reason})`}`, { timeout: 60_000 }, () => {
  const base = folded.base ?? tmpdir();

  onFoldedVolume('reports a link at the entry named in another case', async () => {
    const root = await repoWith(base, { guardedPaths: ['policy'] }, ['src/x.ts']);
    await write(root, 'stuff/p.json', '{}\n');
    await symlink('stuff', join(root, 'POLICY'));
    await expect(checkGuard(realDeps(root))).resolves.toContain('policy');
  });

  onFoldedVolume('reports a link at the requirements folder named in another case, at the root and below a folder', async () => {
    const top = await repoWith(base, { requirements: 'reqs', guardedPaths: [] }, ['src/x.ts']);
    await write(top, 'stuff/r.yaml');
    await symlink('stuff', join(top, 'REQS'));
    await expect(checkGuard(realDeps(top))).resolves.toContain('reqs');

    const nested = await repoWith(base, { requirements: 'a/reqs', guardedPaths: [] }, ['a/keep.txt']);
    await write(nested, 'stuff/r.yaml');
    await symlink('../stuff', join(nested, 'a/REQS'));
    await expect(checkGuard(realDeps(nested))).resolves.toContain('a/reqs');
  });

  onFoldedVolume('reports a link above the entry named in another case', async () => {
    const root = await repoWith(base, { guardedPaths: ['a/policy'] }, ['src/x.ts']);
    await write(root, 'stuff/policy/p.json', '{}\n');
    await symlink('stuff', join(root, 'A'));
    await expect(checkGuard(realDeps(root))).resolves.toContain('a');
  });

  onFoldedVolume('reports nothing for an honest entry, and a new file in it as before', async () => {
    const root = await repoWith(base, { requirements: 'reqs[1]', guardedPaths: ['policy'] }, ['policy/p.json', 'reqs[1]/r.yaml']);
    await expect(checkGuard(realDeps(root))).resolves.toEqual([]);
    await write(root, 'REQS[1]/new.yaml');
    await expect(checkGuard(realDeps(root))).resolves.toEqual(['reqs[1]/new.yaml']);
  });
});

describe('a literal entry below a folder that is no longer a real folder', { timeout: 60_000 }, () => {
  posixOnly('reports a link above the entry to a folder inside the repository', async () => {
    const one = await repoWith(tmpdir(), { guardedPaths: ['a/policy'] }, ['src/x.ts']);
    await write(one, 'stuff/policy/p.json', '{}\n');
    await symlink('stuff', join(one, 'a'));
    await expect(checkGuard(realDeps(one))).resolves.toContain('a');
    expect(Object.keys(await computeSessionPins(realDeps(one), { guardedPaths: ['a/policy'] } as never))).toContain('a');

    const two = await repoWith(tmpdir(), { guardedPaths: ['a/b/policy'] }, ['src/x.ts']);
    await write(two, 'stuff/b/policy/p.json', '{}\n');
    await symlink('stuff', join(two, 'a'));
    await expect(checkGuard(realDeps(two))).resolves.toContain('a');

    const reqs = await repoWith(tmpdir(), { requirements: 'a/reqs', guardedPaths: [] }, ['src/x.ts']);
    await write(reqs, 'stuff/reqs/r.yaml');
    await symlink('stuff', join(reqs, 'a'));
    await expect(checkGuard(realDeps(reqs))).resolves.toContain('a');
  });

  posixOnly('reports a file where a folder above the entry would be', async () => {
    const root = await repoWith(tmpdir(), { guardedPaths: ['a/policy'] }, ['src/x.ts']);
    await write(root, 'a', 'a file\n');
    await expect(checkGuard(realDeps(root))).resolves.toContain('a');
  });

  posixOnly('reports a committed link above the entry on every check, since what is below it cannot be compared', async () => {
    const root = await repoWith(tmpdir(), { guardedPaths: ['a/policy'] }, ['stuff/policy/p.json']);
    await symlink('stuff', join(root, 'a'));
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-q', '-m', 'link']);
    await expect(checkGuard(realDeps(root))).resolves.toContain('a');
  });

  posixOnly('reports nothing when every folder above the entry is a real folder', async () => {
    const root = await repoWith(tmpdir(), { guardedPaths: ['a/policy', 'a/b/c/policy'], requirements: 'a/reqs' }, [
      'a/policy/p.json',
      'a/b/c/policy/p.json',
      'a/reqs/r.yaml',
    ]);
    await expect(checkGuard(realDeps(root))).resolves.toEqual([]);
    await expect(expandConfigGuardedSet(realDeps(root), { guardedPaths: ['a/policy'] })).resolves.not.toContain('a');
  });
});

describe('the cost of finding a literal entry', { timeout: 60_000 }, () => {
  posixOnly('never lists the folder that holds the entry', async () => {
    const root = await repoWith(tmpdir(), { guardedPaths: ['policy', 'a/b/policy'], requirements: 'reqs' }, [
      'policy/p.json',
      'a/b/policy/p.json',
      'a/b/other.txt',
      'reqs/r.yaml',
    ]);
    const real = makeFsGlob({ cwd: root });
    const listed: string[] = [];
    const fs: FsGlob = {
      ...real,
      readFile: real.readFile.bind(real),
      glob: real.glob.bind(real),
      globUnder: async (folder, patterns) => {
        listed.push(folder);
        return real.globUnder!(folder, patterns);
      },
    };
    await expect(checkGuard(realDeps(root, fs))).resolves.toEqual([]);
    // Only the entries themselves are listed: never the root, which holds the ledgers, and never
    // a/b, which holds a/b/policy.
    expect([...new Set(listed)].sort()).toEqual(
      ['.usabl-evidence.json', '.usabl-waivers.json', 'a/b/policy', 'policy', 'reqs', 'usabl.config.json', 'usabl.docs.json', 'usabl.routes.json'].sort(),
    );
  });
});

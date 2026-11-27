/**
 * Only Windows reads a first name that ends with `:` as a drive. On Linux and macOS it is a plain
 * folder name, so a guarded folder named `x:` or a requirements folder named `reqs:` must still
 * have its new untracked files listed on the working tree. These tests use a real git repository,
 * the real adapters, and an injected platform.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Deps } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { makeGitReader } from '../../src/deps/git.js';
import { expandConfigGuardedSet } from '../../src/trust/guard.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, encoding: 'utf8' });
}

async function write(root: string, path: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), 'x\n');
}

describe('a guarded folder whose name ends with a colon', { timeout: 60_000 }, () => {
  let root = '';

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-guard-colon-'));
    await git(root, ['init', '--initial-branch=main']);
    await git(root, ['config', 'user.name', 'Test User']);
    await git(root, ['config', 'user.email', 'test@example.com']);
    await write(root, 'x:/a/old.ts');
    await write(root, 'reqs:/old.yaml');
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-m', 'base']);
    await write(root, 'x:/a/new.ts');
    await write(root, 'reqs:/new.yaml');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lists new untracked files in it on Linux and macOS', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const deps: Deps = { ...makeFakeDeps(), git: makeGitReader({ cwd: root }), fs: makeFsGlob({ cwd: root, platform }) };
      const paths = await expandConfigGuardedSet(deps, { guardedPaths: ['x:/a/**'], requirements: 'reqs:' });
      expect(paths, platform).toContain('x:/a/new.ts');
      expect(paths, platform).toContain('reqs:/new.yaml');
    }
  });
});

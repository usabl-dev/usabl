/**
 * The local guard lists new files on the working tree with the file system adapter's glob. A
 * committed guardedPaths entry with many wildcards and a new file with a long name must not make
 * that listing slow, or a Stop hook could outlast the host's limit with nothing checked. These
 * tests use a real git repository in a temporary folder and the real adapters.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { Deps } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { makeGitReader } from '../../src/deps/git.js';
import { expandGuardedSet } from '../../src/trust/guard.js';

const execFileAsync = promisify(execFile);

// `src/`, then `*a` twelve times, then `*b`. Node took seconds on one name of 30 letters, and
// about five times as long for each four letters more. The test name has 34.
const SLOW_ENTRY = `src/${'*a'.repeat(12)}*b`;
// Far above the time the listing takes, so a loaded machine does not fail the test.
const QUICK_MS = 3000;

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, encoding: 'utf8' });
}

async function write(root: string, path: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), 'x\n');
}

describe('the guard working-tree listing with many wildcards', { timeout: 120_000 }, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lists a new matching file and rules out a long name quickly', async () => {
    root = await mkdtemp(join(tmpdir(), 'usabl-guard-fs-glob-'));
    await git(root, ['init', '--initial-branch=main']);
    await git(root, ['config', 'user.name', 'Test User']);
    await git(root, ['config', 'user.email', 'test@example.com']);
    await write(root, 'src/App.tsx');
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-m', 'base']);
    // New files no commit has: one the entry matches, and one long name it does not.
    await write(root, `src/${'a'.repeat(12)}b`);
    await write(root, `src/${'a'.repeat(34)}`);
    const deps: Deps = { ...makeFakeDeps(), git: makeGitReader({ cwd: root }), fs: makeFsGlob({ cwd: root }) };
    const start = performance.now();
    const guarded = await expandGuardedSet(deps, [SLOW_ENTRY]);
    const ms = performance.now() - start;
    expect(guarded).toEqual([`src/${'a'.repeat(12)}b`]);
    expect(ms).toBeLessThan(QUICK_MS);
  });
});

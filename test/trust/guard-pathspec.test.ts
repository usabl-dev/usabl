/**
 * git reads a path such as `:(top)x.json` or `:(literal)x.json` as pathspec magic: a prefix that
 * changes how git matches the path. The git reader turns that off, so a guarded file with such a
 * name is read by its own name at every ref, and a change to it is never read as absent at both.
 * Also, a guarded file too large for a text read is still compared, and a text read of one gives a
 * plain refusal. These tests use real git repositories in temporary folders.
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
import { computePolicyHash } from '../../src/evidence/receipt.js';
import { checkGuard, computeSessionPins, diffSessionPins, guardScopeAtRefs } from '../../src/trust/guard.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

async function write(root: string, path: string, contents: string | Buffer): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), contents);
}

function configFor(guardedPaths: string[]): UsablConfig {
  return {
    appBaseUrl: 'http://127.0.0.1:5173',
    uiFileGlobs: ['src/**'],
    discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
    surfaces: [],
    guardedPaths,
  };
}

async function repo(guardedPaths: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'usabl-guard-pathspec-'));
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['config', 'user.name', 'Test User']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await write(root, 'usabl.config.json', JSON.stringify(configFor(guardedPaths)));
  await write(root, 'src/App.tsx', 'export {}\n');
  return root;
}

async function commit(root: string, message: string): Promise<string> {
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

function realDeps(root: string): Deps {
  return { ...makeFakeDeps(), git: makeGitReader({ cwd: root }), fs: makeFsGlob({ cwd: root }) };
}

describe('a guarded name that starts with pathspec magic', { timeout: 60_000 }, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function magicRepo(): Promise<{ trusted: string; head: string; before: Record<string, string> }> {
    root = await repo(['*.json']);
    await write(root, ':(top)x.json', 'trusted policy');
    // A decoy with the name the magic reads, so a read of the wrong file finds a file.
    await write(root, 'x.json', 'decoy');
    const trusted = await commit(root, 'trusted');
    const before = await computeSessionPins(realDeps(root), configFor(['*.json']));
    await write(root, ':(top)x.json', 'weakened policy');
    const head = await commit(root, 'head');
    return { trusted, head, before };
  }

  it('an edit to :(top)x.json is a change to the CI policy check', async () => {
    const { trusted, head } = await magicRepo();
    expect((await guardScopeAtRefs(makeGitReader({ cwd: root }), trusted, head)).diverged).toEqual([':(top)x.json']);
  });

  it('an edit to :(top)x.json is a change to the session pins', async () => {
    const { before } = await magicRepo();
    expect(diffSessionPins(before, await computeSessionPins(realDeps(root), configFor(['*.json'])))).toEqual([
      ':(top)x.json',
    ]);
  });

  it('an edit to :(top)x.json is a change to the local guard and to the receipt policy hash', async () => {
    const { trusted } = await magicRepo();
    await expect(checkGuard(realDeps(root), trusted)).resolves.toEqual([':(top)x.json']);
    const listed = await makeGitReader({ cwd: root }).lsTree('HEAD', [':(top)x.json']);
    expect(Object.keys(listed)).toEqual([':(top)x.json']);
    expect(await computePolicyHash(realDeps(root), [':(top)x.json'])).not.toBe(
      await computePolicyHash(realDeps(root), ['x.json']),
    );
  });

  it('a new :(literal)new.json is a change to the CI policy check', async () => {
    const { head } = await magicRepo();
    await write(root, ':(literal)new.json', 'added');
    const added = await commit(root, 'add a file');
    expect((await guardScopeAtRefs(makeGitReader({ cwd: root }), head, added)).diverged).toEqual([':(literal)new.json']);
  });

  it('a guarded folder whose name starts with :( is listed by its own name', async () => {
    root = await repo([':(top)policy']);
    await write(root, ':(top)policy/a.json', 'a');
    await write(root, 'policy/a.json', 'decoy');
    const trusted = await commit(root, 'trusted');
    await write(root, ':(top)policy/a.json', 'b');
    const head = await commit(root, 'head');
    expect((await guardScopeAtRefs(makeGitReader({ cwd: root }), trusted, head)).diverged).toEqual([':(top)policy/a.json']);
  });
});

describe('a guarded file larger than a text read', { timeout: 120_000 }, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('is still compared at refs and on the working tree', async () => {
    root = await repo(['policy']);
    const large = Buffer.alloc(11 * 1024 * 1024, 0x61);
    await write(root, 'policy/model.bin', large);
    const trusted = await commit(root, 'trusted');
    const deps = realDeps(root);
    await expect(checkGuard(deps, trusted)).resolves.toEqual([]);
    const before = await computeSessionPins(deps, configFor(['policy']));
    large[large.length - 1] = 0x62;
    await write(root, 'policy/model.bin', large);
    await expect(checkGuard(deps, trusted)).resolves.toEqual(['policy/model.bin']);
    const head = await commit(root, 'head');
    expect((await guardScopeAtRefs(deps.git, trusted, head)).diverged).toEqual(['policy/model.bin']);
    expect(diffSessionPins(before, await computeSessionPins(deps, configFor(['policy'])))).toEqual(['policy/model.bin']);
  });

  it('a text read of a file over the limit says which file and what to do', async () => {
    root = await repo(['policy']);
    await write(root, 'policy/big.json', 'x'.repeat(4096));
    await commit(root, 'trusted');
    const git = makeGitReader({ cwd: root, maxBuffer: 1024 });
    const err = await git.show('HEAD', 'policy/big.json').then(
      () => null,
      (error: unknown) => error,
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('policy/big.json');
    expect(message).toContain('larger than');
    expect(message).not.toContain('maxBuffer');
    expect(message).not.toContain('ERR_CHILD_PROCESS');
  });
});

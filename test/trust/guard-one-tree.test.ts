/**
 * The guard reads what a ref stores from one listing of that ref. A link's text and the config's
 * text are read by the object id the listing gave, never by asking for the path at the ref again,
 * so the text and the id always come from the same tree. A ref that moves between two reads, which
 * can happen to HEAD while usabl runs, then cannot pair the id of one commit with the text of
 * another. Here a reader whose path read answers with other text stands in for that move: the
 * guard must not use that text. These tests use real git repositories in temporary folders.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { Deps, GitReader, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { makeGitReader } from '../../src/deps/git.js';
import { checkGuard, computeSessionPins, diffSessionPins, guardScopeAtRefs } from '../../src/trust/guard.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

async function write(root: string, path: string, contents: string): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), contents);
}

const CONFIG_PATH = 'usabl.config.json';
const LINK = 'policy/waivers.json';

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: ['policy'],
};

// A config that guards nothing beyond the files usabl always guards.
const guardsNothing = JSON.stringify({ ...config, guardedPaths: [] });

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'usabl-guard-one-tree-'));
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['config', 'user.name', 'Test User']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await write(root, CONFIG_PATH, JSON.stringify(config));
  await write(root, 'src/App.tsx', 'export {}\n');
  return root;
}

async function commit(root: string, message: string): Promise<string> {
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

// The real git reader, except that a path read of one path answers with other text, as it would
// if the ref had moved to a commit that stores that text.
function movedReader(root: string, lies: Record<string, string>): GitReader {
  const real = makeGitReader({ cwd: root });
  return {
    ...real,
    show: async (ref, path) => lies[path] ?? real.show(ref, path),
  };
}

function depsWith(root: string, reader: GitReader): Deps {
  return { ...makeFakeDeps(), git: reader, fs: makeFsGlob({ cwd: root }) };
}

describe('the guard reads text by the id its listing gave', { timeout: 60_000 }, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function linkSetup(): Promise<{ trusted: string; head: string }> {
    root = await repo();
    await write(root, 'data/stable.json', '{"waivers":[]}');
    await write(root, 'data/waivers.json', '{"waivers":[]}');
    await mkdir(join(root, 'policy'), { recursive: true });
    await symlink('../data/waivers.json', join(root, LINK));
    const trusted = await commit(root, 'trusted');
    await write(root, 'data/waivers.json', '{"waivers":["everything"]}');
    const head = await commit(root, 'edit the link target');
    return { trusted, head };
  }

  it('the CI check reads a guarded link by its listed id, so another text for the path cannot hide a target edit', async () => {
    const { trusted, head } = await linkSetup();
    const reader = movedReader(root, { [LINK]: '../data/stable.json' });
    expect((await guardScopeAtRefs(reader, trusted, head)).diverged).toEqual([LINK]);
  });

  it('the CI check reads a link in the middle of a chain by its listed id', async () => {
    root = await repo();
    await write(root, 'data/stable.json', '{"waivers":[]}');
    await write(root, 'data/real.json', '{"waivers":[]}');
    await symlink('real.json', join(root, 'data/link.json'));
    await mkdir(join(root, 'policy'), { recursive: true });
    await symlink('../data/link.json', join(root, LINK));
    const trusted = await commit(root, 'trusted');
    await write(root, 'data/real.json', '{"waivers":["everything"]}');
    const head = await commit(root, 'edit the last target');
    const reader = movedReader(root, { 'data/link.json': 'stable.json' });
    expect((await guardScopeAtRefs(reader, trusted, head)).diverged).toEqual([LINK]);
  });

  it('the session pins read a guarded link by its listed id', async () => {
    root = await repo();
    await write(root, 'data/stable.json', '{"waivers":[]}');
    await write(root, 'data/waivers.json', '{"waivers":[]}');
    await mkdir(join(root, 'policy'), { recursive: true });
    await symlink('../data/waivers.json', join(root, LINK));
    await commit(root, 'trusted');
    const deps = depsWith(root, movedReader(root, { [LINK]: '../data/stable.json' }));
    const before = await computeSessionPins(deps, config);
    await write(root, 'data/waivers.json', '{"waivers":["everything"]}');
    await commit(root, 'edit the link target');
    expect(diffSessionPins(before, await computeSessionPins(deps, config))).toEqual([LINK]);
  });

  it('the CI check reads the trusted config by its listed id, so another text cannot shrink the guarded set', async () => {
    root = await repo();
    await write(root, 'policy/a.json', '{"rule":"strict"}');
    const trusted = await commit(root, 'trusted');
    await write(root, CONFIG_PATH, guardsNothing);
    await write(root, 'policy/a.json', '{"rule":"off"}');
    const head = await commit(root, 'stop guarding policy and weaken it');
    const reader = movedReader(root, { [CONFIG_PATH]: guardsNothing });
    expect((await guardScopeAtRefs(reader, trusted, head)).diverged).toEqual(['policy/a.json', CONFIG_PATH]);
  });

  it('the local guard reads the trusted config by its listed id', async () => {
    root = await repo();
    await write(root, 'policy/a.json', '{"rule":"strict"}');
    const trusted = await commit(root, 'trusted');
    await write(root, CONFIG_PATH, guardsNothing);
    await write(root, 'policy/a.json', '{"rule":"off"}');
    const deps = depsWith(root, movedReader(root, { [CONFIG_PATH]: guardsNothing }));
    expect(await checkGuard(deps, trusted)).toEqual(['policy/a.json', CONFIG_PATH]);
  });
});

describe('the CI check needs the tree entry read', { timeout: 60_000 }, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('refuses a reader without one, never comparing text instead', async () => {
    root = await repo();
    const trusted = await commit(root, 'trusted');
    const real = makeGitReader({ cwd: root });
    const textOnly = { show: real.show, lsFilesUnder: real.lsFilesUnder };
    // A reader typed without the tree entry read no longer compiles; this one is built past the
    // type to show the check does not fall back to text at run time either.
    await expect(guardScopeAtRefs(textOnly as unknown as GitReader, trusted, trusted)).rejects.toThrow();
  });
});

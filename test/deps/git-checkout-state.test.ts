/**
 * The local checkout state the Stop hook pins at the first stop of a session: the sparse checkout
 * settings and pattern file, and the submodule folders that are empty. The working tree walk reads
 * a missing file as left out on purpose under that state, so any change to it later in a session
 * must read as a change. An honest repository whose state does not change reads the same text on
 * every read.
 *
 * Real git in a temporary folder, with a global config of the test's own.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeGitReader } from '../../src/deps/git.js';
import { REAL_PROCESS_BUDGET_MS } from '../support/timing.js';

const execFileAsync = promisify(execFile);

let repo = '';
let home = '';
const savedEnv: Record<string, string | undefined> = {};

async function gitIn(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout;
}

async function git(...args: string[]): Promise<string> {
  return gitIn(repo, ...args);
}

async function write(path: string, text: string, base: string = repo): Promise<void> {
  await mkdir(join(base, path, '..'), { recursive: true });
  await writeFile(join(base, path), text);
}

async function newRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await gitIn(path, 'init', '-q', '--initial-branch=main');
  await gitIn(path, 'config', 'user.name', 'Test User');
  await gitIn(path, 'config', 'user.email', 'test@example.invalid');
}

async function commitAll(message = 'commit', cwd: string = repo): Promise<void> {
  await gitIn(cwd, 'add', '-A');
  await gitIn(cwd, 'commit', '-q', '-m', message);
}

async function state(cwd: string = repo): Promise<Record<string, string>> {
  return makeGitReader({ cwd }).checkoutState();
}

// Every entry of a folder, its .git included, removed, and the folder kept.
async function empty(folder: string): Promise<void> {
  for (const name of await readdir(folder)) {
    await rm(join(folder, name), { recursive: true, force: true });
  }
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'usabl-checkout-state-home-')));
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) {
    savedEnv[key] = process.env[key];
  }
  await writeFile(join(home, '.gitconfig'), '[core]\n\thooksPath = /dev/null\n[protocol "file"]\n\tallow = always\n');
  process.env['HOME'] = home;
  process.env['XDG_CONFIG_HOME'] = join(home, '.config');
  delete process.env['GIT_CONFIG_GLOBAL'];
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  repo = await realpath(await mkdtemp(join(tmpdir(), 'usabl-checkout-state-')));
  await newRepo(repo);
  await write('src/App.tsx', 'export const App = 1;\n');
  await write('other/Other.tsx', 'export const Other = 1;\n');
  await commitAll('base');
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await rm(repo, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe('the sparse checkout state', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  it('has no key in a repository with no sparse checkout and no pattern file', async () => {
    expect(await state()).toEqual({});
  });

  it('reads the same for an honest cone sparse checkout whose patterns do not change', async () => {
    await git('sparse-checkout', 'set', '--cone', 'src');
    const first = await state();
    expect(Object.keys(first)).toEqual(['.git/info/sparse-checkout']);
    await write('src/App.tsx', 'export const App = 2;\n');
    expect(await state()).toEqual(first);
  });

  it('changes when sparse checkout is turned on', async () => {
    const before = await state();
    await git('config', 'core.sparseCheckout', 'true');
    await write('.git/info/sparse-checkout', '/*\n!/src/App.tsx\n');
    expect(await state()).not.toEqual(before);
  });

  it('changes when the agent writes other patterns', async () => {
    await git('sparse-checkout', 'set', '--cone', 'src');
    const before = await state();
    await git('config', 'core.sparseCheckoutCone', 'false');
    await write('.git/info/sparse-checkout', '/*\n!/src/App.tsx\n');
    expect(await state()).not.toEqual(before);
  });

  it('changes when the pattern file is emptied', async () => {
    await git('sparse-checkout', 'set', '--cone', 'src');
    const before = await state();
    await writeFile(join(repo, '.git/info/sparse-checkout'), '');
    expect(await state()).not.toEqual(before);
  });

  it('changes when a folder stands in place of the pattern file', async () => {
    await git('sparse-checkout', 'set', '--cone', 'src');
    const before = await state();
    await rm(join(repo, '.git/info/sparse-checkout'));
    await mkdir(join(repo, '.git/info/sparse-checkout'));
    expect(await state()).not.toEqual(before);
  });

  // git sparse-checkout writes its settings to the worktree config, which outranks .git/config, so
  // the agent changes them there. The state is what git reads, from every scope.
  it('changes when cone mode alone is turned off', async () => {
    await git('sparse-checkout', 'set', '--cone', 'src');
    const before = await state();
    await git('config', 'core.sparseCheckoutCone', 'false');
    expect(await state()).toEqual(before);
    await git('config', '--worktree', 'core.sparseCheckoutCone', 'false');
    expect(await state()).not.toEqual(before);
  });
});

describe('the empty submodule folders', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  async function addSubmodule(): Promise<string> {
    const lib = join(home, 'lib-source');
    await newRepo(lib);
    await write('ui/Lib.tsx', 'export const Lib = 1;\n', lib);
    await commitAll('lib', lib);
    await git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib');
    await git('commit', '-q', '-m', 'add the submodule');
    return lib;
  }

  it('has no key while every submodule folder holds its repository', async () => {
    await addSubmodule();
    expect(await state()).toEqual({});
  });

  it('names a submodule folder the agent empties, its .git included', async () => {
    await addSubmodule();
    const before = await state();
    await empty(join(repo, 'lib'));
    const after = await state();
    expect(after).not.toEqual(before);
    expect(JSON.parse(after['.git/modules'] ?? '[]')).toEqual(['lib']);
  });

  it('names a submodule that was never set up, and reads the same while it stays so', async () => {
    await addSubmodule();
    const clone = join(home, 'clone');
    await gitIn(home, 'clone', '-q', repo, clone);
    const first = await state(clone);
    expect(JSON.parse(first['.git/modules'] ?? '[]')).toEqual(['lib']);
    expect(await state(clone)).toEqual(first);
  });

  it('reads the sparse checkout state inside a submodule under its path', async () => {
    await addSubmodule();
    const before = await state();
    await gitIn(join(repo, 'lib'), 'sparse-checkout', 'set', '--no-cone', '/*', '!/ui/Lib.tsx');
    const after = await state();
    expect(after).not.toEqual(before);
    expect(JSON.parse(after['.git/info/sparse-checkout'] ?? '[]')[0]?.[0]).toBe('lib/');
  });
});

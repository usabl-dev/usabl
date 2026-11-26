/**
 * The committed part of the changed list: every file that differs between the merge base of the
 * trusted ref and HEAD, and HEAD. It comes from the commit and tree objects on both sides, each
 * read in Node and checked against its id, so an object the agent overwrites in .git/objects
 * stops the read instead of hiding a committed edit. A local setting that makes git diff quieter
 * changes nothing either. An honest repository lists what git diff lists, apart from renames,
 * which are listed by both names.
 *
 * Real git in a temporary folder, with a global config of the test's own.
 */
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeGitReader } from '../../src/deps/git.js';
import { patchCommitGraphParent } from '../support/commit-graph.js';
import { REAL_PROCESS_BUDGET_MS } from '../support/timing.js';

const execFileAsync = promisify(execFile);
const posixOnly = process.platform === 'win32' ? it.skip : it;

let repo = '';
let home = '';
const savedEnv: Record<string, string | undefined> = {};

async function gitIn(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function git(...args: string[]): Promise<string> {
  return gitIn(repo, ...args);
}

async function gitWithInput(input: string, ...args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = execFile('git', args, { cwd: repo, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
    child.stdin?.end(input);
  });
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

async function forgeObject(id: string, type: 'tree' | 'commit', content: Buffer): Promise<void> {
  const path = join(repo, '.git/objects', id.slice(0, 2), id.slice(2));
  await chmod(path, 0o644);
  await writeFile(path, deflateSync(Buffer.concat([Buffer.from(`${type} ${String(content.length)}\0`), content])));
}

// A tree object's bytes for a listing in git ls-tree's form, written to the object store.
async function makeTree(listing: string): Promise<{ id: string; raw: Buffer }> {
  const id = await gitWithInput(listing, 'mktree');
  const { stdout: raw } = await execFileAsync('git', ['cat-file', 'tree', id], { cwd: repo, encoding: 'buffer' });
  return { id, raw };
}

// What git diff lists, with rename detection off, so both names of a rename are listed.
async function gitDiffNames(ref: string): Promise<string[]> {
  const out = await git('-c', 'diff.renames=false', 'diff', '--no-renames', '--name-only', '-z', `${ref}...HEAD`, '--');
  return out.split('\0').filter((name) => name.length > 0).sort();
}

async function listed(ref: string): Promise<string[]> {
  return [...(await makeGitReader({ cwd: repo }).diffNameOnly(ref))].sort();
}

const APP = 'export const App = () => <label htmlFor="n">Name</label>;\n';
const APP_EDITED = 'export const App = () => <b>Name</b>;\n';

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'usabl-committed-diff-home-')));
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_COMMITTER_DATE', 'GIT_AUTHOR_DATE']) {
    savedEnv[key] = process.env[key];
  }
  await writeFile(join(home, '.gitconfig'), '[core]\n\thooksPath = /dev/null\n');
  process.env['HOME'] = home;
  process.env['XDG_CONFIG_HOME'] = join(home, '.config');
  delete process.env['GIT_CONFIG_GLOBAL'];
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  process.env['GIT_COMMITTER_DATE'] = '2026-01-01T00:00:00Z';
  process.env['GIT_AUTHOR_DATE'] = '2026-01-01T00:00:00Z';
  repo = await realpath(await mkdtemp(join(tmpdir(), 'usabl-committed-diff-')));
  await newRepo(repo);
  await write('src/App.tsx', APP);
  await write('src/Other.tsx', 'export const Other = 1;\n');
  await commitAll('base');
  await git('branch', 'trusted');
  await git('switch', '-q', '-c', 'feature');
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

/** The feature branch: one commit changes the other screen, a second removes the label. */
async function commitTheEdit(): Promise<void> {
  await write('src/Other.tsx', 'export const Other = 2;\n');
  await commitAll('change the other screen');
  await write('src/App.tsx', APP_EDITED);
  await commitAll('edit the screen');
}

describe('objects the agent overwrites on the trusted side', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  it('refuses to list when a tree only the trusted side holds is forged to hide a committed edit', async () => {
    await commitTheEdit();
    const trustedSrc = (await git('rev-parse', 'trusted:src')).trim();
    const edited = (await git('rev-parse', 'HEAD:src/App.tsx')).trim();
    const other = (await git('rev-parse', 'trusted:src/Other.tsx')).trim();
    const forged = await makeTree(`100644 blob ${edited}\tApp.tsx\n100644 blob ${other}\tOther.tsx\n`);
    await forgeObject(trustedSrc, 'tree', forged.raw);
    // git diff reads the forged tree without checking its id, so it lists the other screen only.
    expect(await gitDiffNames('trusted')).toEqual(['src/Other.tsx']);
    await expect(listed('trusted')).rejects.toThrow(/git fsck/u);
  });

  it('refuses to list when the merge base commit is forged to name a tree that holds the edit', async () => {
    // The trusted branch moved on after the feature branch left it, so the merge base is a commit
    // git reaches through parents and never checks.
    await git('switch', '-q', 'trusted');
    await write('README.md', 'notes\n');
    await commitAll('the trusted branch moves on');
    await git('switch', '-q', 'feature');
    await commitTheEdit();
    const base = (await git('merge-base', 'trusted', 'HEAD')).trim();
    expect(base).toBe((await git('rev-parse', 'trusted~1')).trim());
    const baseTree = (await git('rev-parse', `${base}^{tree}`)).trim();
    const edited = (await git('rev-parse', 'HEAD:src/App.tsx')).trim();
    const other = (await git('rev-parse', `${base}:src/Other.tsx`)).trim();
    const src = await makeTree(`100644 blob ${edited}\tApp.tsx\n100644 blob ${other}\tOther.tsx\n`);
    const root = await makeTree(`040000 tree ${src.id}\tsrc\n`);
    const text = await git('cat-file', 'commit', base);
    await forgeObject(base, 'commit', Buffer.from(text.replace(`tree ${baseTree}\n`, `tree ${root.id}\n`)));
    expect(await gitDiffNames('trusted')).toEqual(['src/Other.tsx']);
    await expect(listed('trusted')).rejects.toThrow(/git fsck/u);
  });

  it('refuses to list, naming git fsck, when the trusted commit itself is forged', async () => {
    await commitTheEdit();
    const trusted = (await git('rev-parse', 'trusted')).trim();
    const text = await git('cat-file', 'commit', trusted);
    await forgeObject(trusted, 'commit', Buffer.from(`${text}\n`));
    await expect(listed('trusted')).rejects.toThrow(/git fsck/u);
  });

  it('refuses to list when a tree only HEAD holds is forged', async () => {
    await commitTheEdit();
    const headSrc = (await git('rev-parse', 'HEAD:src')).trim();
    const original = (await git('rev-parse', 'trusted:src/App.tsx')).trim();
    const other = (await git('rev-parse', 'HEAD:src/Other.tsx')).trim();
    const forged = await makeTree(`100644 blob ${original}\tApp.tsx\n100644 blob ${other}\tOther.tsx\n`);
    await forgeObject(headSrc, 'tree', forged.raw);
    await expect(listed('trusted')).rejects.toThrow(/git fsck/u);
  });
});

describe('a commit-graph file the agent writes', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  it('lists a committed edit when the commit-graph makes HEAD a parent of a trusted commit', async () => {
    await git('switch', '-q', 'trusted');
    await write('NOTES.md', 'n1\n');
    await commitAll('n1');
    await write('NOTES.md', 'n2\n');
    await commitAll('n2');
    await git('switch', '-q', 'feature');
    await commitTheEdit();
    await git('commit-graph', 'write', '--reachable', '--no-progress');
    const graph = join(repo, '.git/objects/info/commit-graph');
    await chmod(graph, 0o644);
    const head = (await git('rev-parse', 'HEAD')).trim();
    patchCommitGraphParent(graph, (await git('rev-parse', 'trusted~1')).trim(), head);
    // git reads parents from the patched file, so HEAD is the merge base and git diff lists nothing.
    expect((await git('merge-base', 'trusted', 'HEAD')).trim()).toBe(head);
    expect(await gitDiffNames('trusted')).toEqual([]);
    expect(await listed('trusted')).toEqual(['src/App.tsx', 'src/Other.tsx']);
  });
});

describe('local settings that make git diff quieter', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  it('lists a committed submodule change that diff.ignoreSubmodules hides', async () => {
    const lib = join(home, 'lib-source');
    await newRepo(lib);
    await write('Lib.tsx', 'export const Lib = 1;\n', lib);
    await commitAll('lib', lib);
    const first = (await gitIn(lib, 'rev-parse', 'HEAD')).trim();
    await write('Lib.tsx', 'export const Lib = 2;\n', lib);
    await commitAll('lib two', lib);
    const second = (await gitIn(lib, 'rev-parse', 'HEAD')).trim();
    await git('update-index', '--add', '--cacheinfo', `160000,${first},lib`);
    await git('commit', '-q', '-m', 'add the submodule');
    await git('branch', '-f', 'trusted');
    await git('update-index', '--cacheinfo', `160000,${second},lib`);
    await git('commit', '-q', '-m', 'move the submodule');
    await git('config', 'diff.ignoreSubmodules', 'all');
    expect(await gitDiffNames('trusted')).toEqual([]);
    expect(await listed('trusted')).toEqual(['lib']);
  });
});

describe('the committed changes of an honest repository', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  it('lists nothing when HEAD is the trusted commit', async () => {
    expect(await listed('trusted')).toEqual([]);
    expect(await listed('HEAD')).toEqual([]);
  });

  it('lists both names of a committed rename', async () => {
    await git('mv', 'src/Other.tsx', 'src/Moved.tsx');
    await git('commit', '-q', '-m', 'move');
    expect(await listed('trusted')).toEqual(['src/Moved.tsx', 'src/Other.tsx']);
  });

  it('names the ref and how to fetch it when the trusted ref does not exist', async () => {
    await expect(listed('origin/nosuch')).rejects.toThrow(/git cannot read origin\/nosuch/u);
  });

  it('says so when HEAD shares no commit with the trusted ref', async () => {
    await git('switch', '-q', '--orphan', 'unrelated');
    await write('src/App.tsx', APP);
    await commitAll('unrelated');
    await expect(listed('trusted')).rejects.toThrow(/git finds no commit that HEAD shares with trusted/u);
  });

  posixOnly('lists what git diff lists over many commits, merges, and every kind of entry', async () => {
    // A wide tree that mostly stays the same, so most folders are never read.
    for (let folder = 0; folder < 20; folder += 1) {
      for (let file = 0; file < 10; file += 1) {
        await write(`wide/f${String(folder)}/n${String(file)}.ts`, `export const n = ${String(folder * 10 + file)};\n`);
      }
    }
    await write('kinds/file-to-folder', 'a file\n');
    await write('kinds/folder-to-file/inner.ts', 'inside\n');
    await write('kinds/exec.sh', 'echo\n');
    await write('kinds/gone.ts', 'deleted later\n');
    await write('deep/a/b/c/d/e/leaf.ts', 'leaf\n');
    await write('names/plain.ts', 'plain\n');
    await commitAll('the shape');
    await git('branch', '-f', 'trusted');
    // The trusted branch moves on for many commits.
    await git('switch', '-q', 'trusted');
    for (let step = 0; step < 120; step += 1) {
      await write(`trusted-log/l${String(step % 7)}.txt`, `step ${String(step)}\n`);
      await commitAll(`trusted ${String(step)}`);
    }
    await git('switch', '-q', 'feature');
    for (let step = 0; step < 40; step += 1) {
      await write(`feature-log/l${String(step % 5)}.txt`, `step ${String(step)}\n`);
      await commitAll(`feature ${String(step)}`);
    }
    // The feature branch takes the trusted branch in once, then goes on.
    await git('merge', '-q', '--no-edit', 'trusted~60');
    await write('wide/f3/n4.ts', 'export const n = -1;\n');
    await write('deep/a/b/c/d/e/leaf.ts', 'leaf two\n');
    await rm(join(repo, 'kinds/file-to-folder'));
    await write('kinds/file-to-folder/now.ts', 'a folder now\n');
    await rm(join(repo, 'kinds/folder-to-file'), { recursive: true });
    await write('kinds/folder-to-file', 'a file now\n');
    await chmod(join(repo, 'kinds/exec.sh'), 0o755);
    await rm(join(repo, 'kinds/gone.ts'));
    await symlink('plain.ts', join(repo, 'names/link.ts'));
    await write('names/Über spaced .ts', 'umlaut\n');
    await write('names/new\nline.ts', 'newline\n');
    await commitAll('the edits');
    for (let step = 40; step < 60; step += 1) {
      await write(`feature-log/l${String(step % 5)}.txt`, `step ${String(step)}\n`);
      await commitAll(`feature ${String(step)}`);
    }
    const expected = await gitDiffNames('trusted');
    expect(expected).toContain('wide/f3/n4.ts');
    expect(expected).toContain('kinds/exec.sh');
    expect(expected).toContain('names/new\nline.ts');
    expect(await listed('trusted')).toEqual(expected);
    const trusted = (await git('rev-parse', 'trusted')).trim();
    expect(await listed(trusted)).toEqual(expected);
  });
});

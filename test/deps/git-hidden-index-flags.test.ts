/**
 * git status and git diff do not show an edit to a tracked file marked assume-unchanged or
 * skip-worktree. Without help, a stop whose only edit is such a file read "nothing to check".
 * The git reader's status listing adds each such file whose working copy differs from the index,
 * so every surface that lists changes from it sees the edit.
 *
 * Real git in a temporary folder.
 */
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeGitReader } from '../../src/deps/git.js';
import { REAL_PROCESS_BUDGET_MS } from '../support/timing.js';

const execFileAsync = promisify(execFile);

let repo = '';

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repo, encoding: 'utf8' });
  return stdout;
}

async function write(path: string, text: string): Promise<void> {
  await mkdir(join(repo, path, '..'), { recursive: true });
  await writeFile(join(repo, path), text, 'utf8');
}

async function statusPaths(cwd: string = repo): Promise<string[]> {
  return (await makeGitReader({ cwd }).statusZ()).map((entry) => entry.path).sort();
}

const NEWLINE_NAME = 'src/odd\nname.tsx';

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'usabl-hidden-flags-'));
  await git('init', '-q', '--initial-branch=main');
  await git('config', 'user.name', 'Test User');
  await git('config', 'user.email', 'test@example.invalid');
  await write('src/App.tsx', 'export const App = 1;\n');
  await write('src/Theme.tsx', 'export const Theme = 1;\n');
  await write('src/Other.tsx', 'export const Other = 1;\n');
  await write(NEWLINE_NAME, 'export const Odd = 1;\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'base');
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('git status listing and files git hides with index flags', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  it('lists an edit to a file marked assume-unchanged', async () => {
    await git('update-index', '--assume-unchanged', 'src/App.tsx');
    await write('src/App.tsx', 'export const App = 2;\n');
    // git itself shows nothing.
    expect(await git('status', '--porcelain')).toBe('');
    await expect(makeGitReader({ cwd: repo }).statusZ()).resolves.toEqual([{ code: 'M', path: 'src/App.tsx' }]);
  });

  it('lists an edit to a file marked skip-worktree', async () => {
    await git('update-index', '--skip-worktree', 'src/Theme.tsx');
    await write('src/Theme.tsx', 'export const Theme = 2;\n');
    expect(await git('status', '--porcelain')).toBe('');
    await expect(makeGitReader({ cwd: repo }).statusZ()).resolves.toEqual([{ code: 'M', path: 'src/Theme.tsx' }]);
  });

  it('lists an edit to a file with both flags', async () => {
    await git('update-index', '--assume-unchanged', '--skip-worktree', 'src/App.tsx');
    await write('src/App.tsx', 'export const App = 2;\n');
    expect(await statusPaths()).toEqual(['src/App.tsx']);
  });

  it('lists nothing for a flagged file whose bytes did not change', async () => {
    await git('update-index', '--assume-unchanged', 'src/App.tsx');
    await git('update-index', '--skip-worktree', 'src/Theme.tsx');
    // Written again with the same bytes, so the file's time changes and its content does not.
    await write('src/App.tsx', 'export const App = 1;\n');
    expect(await statusPaths()).toEqual([]);
  });

  it('lists a flagged edit next to the changes git status shows, once each', async () => {
    await git('update-index', '--assume-unchanged', 'src/App.tsx');
    await write('src/App.tsx', 'export const App = 2;\n');
    await write('src/Other.tsx', 'export const Other = 2;\n');
    await write('src/New.tsx', 'export const New = 1;\n');
    expect(await statusPaths()).toEqual(['src/App.tsx', 'src/New.tsx', 'src/Other.tsx']);
  });

  it('lists a flagged file that was deleted', async () => {
    await git('update-index', '--assume-unchanged', 'src/App.tsx');
    await unlink(join(repo, 'src/App.tsx'));
    await expect(makeGitReader({ cwd: repo }).statusZ()).resolves.toEqual([{ code: 'D', path: 'src/App.tsx' }]);
  });

  it('lists a skip-worktree file that was deleted when sparse checkout is off', async () => {
    await git('update-index', '--skip-worktree', 'src/Theme.tsx');
    await unlink(join(repo, 'src/Theme.tsx'));
    expect(await statusPaths()).toEqual(['src/Theme.tsx']);
  });

  it('lists a flagged file that became a symbolic link', async () => {
    await git('update-index', '--assume-unchanged', 'src/App.tsx');
    await unlink(join(repo, 'src/App.tsx'));
    await symlink('Other.tsx', join(repo, 'src/App.tsx'));
    expect(await statusPaths()).toEqual(['src/App.tsx']);
  });

  it('lists a flagged edit with the name git stores, a newline included', async () => {
    await git('update-index', '--assume-unchanged', '--', NEWLINE_NAME);
    await write(NEWLINE_NAME, 'export const Odd = 2;\n');
    expect(await statusPaths()).toEqual([NEWLINE_NAME]);
  });

  it('lists a flagged edit from the repository root when it runs in a subfolder', async () => {
    await git('update-index', '--assume-unchanged', 'src/App.tsx');
    await write('src/App.tsx', 'export const App = 2;\n');
    await mkdir(join(repo, 'docs'));
    expect(await statusPaths(join(repo, 'docs'))).toEqual(['src/App.tsx']);
  });

  it('reads a flagged file through the filters git add uses, so a line ending change alone is no edit', async () => {
    await write('.gitattributes', '*.tsx text eol=lf\n');
    await git('add', '.gitattributes');
    await git('commit', '-q', '-m', 'attributes');
    await git('update-index', '--assume-unchanged', 'src/App.tsx');
    await write('src/App.tsx', 'export const App = 1;\r\n');
    expect(await statusPaths()).toEqual([]);
  });

  describe('in a sparse checkout', () => {
    beforeEach(async () => {
      await write('docs/guide.md', 'guide\n');
      await git('add', '-A');
      await git('commit', '-q', '-m', 'docs');
      // Only src/ is checked out. git marks every file outside it skip-worktree and removes it.
      await git('sparse-checkout', 'set', '--no-cone', '/src/');
    });

    it('lists nothing for a file outside the sparse set, which git left out on purpose', async () => {
      expect(await git('ls-files', '-v', '--', 'docs/guide.md')).toBe('S docs/guide.md\n');
      expect(await statusPaths()).toEqual([]);
    });

    it('lists an edit to a file outside the sparse set that is present again', async () => {
      await write('docs/guide.md', 'edited guide\n');
      expect(await statusPaths()).toEqual(['docs/guide.md']);
    });

    it('lists an assume-unchanged file in a folder sparse checkout removed', async () => {
      await git('update-index', '--no-skip-worktree', 'docs/guide.md');
      await git('update-index', '--assume-unchanged', 'docs/guide.md');
      await expect(makeGitReader({ cwd: repo }).statusZ()).resolves.toEqual([{ code: 'D', path: 'docs/guide.md' }]);
    });

    it('lists a skip-worktree file inside the sparse set that was deleted', async () => {
      await git('update-index', '--skip-worktree', 'src/App.tsx');
      await unlink(join(repo, 'src/App.tsx'));
      await expect(makeGitReader({ cwd: repo }).statusZ()).resolves.toEqual([{ code: 'D', path: 'src/App.tsx' }]);
    });
  });

  // An agent can turn sparse checkout on with one config line and no patterns. git cannot then
  // say which files are outside the sparse set, so a missing skip-worktree file is a deletion.
  it('lists a deleted skip-worktree file when sparse checkout is on with no patterns', async () => {
    await git('config', 'core.sparseCheckout', 'true');
    await git('update-index', '--skip-worktree', 'src/App.tsx');
    await unlink(join(repo, 'src/App.tsx'));
    expect(await git('status', '--porcelain')).toBe('');
    await expect(makeGitReader({ cwd: repo }).statusZ()).resolves.toEqual([{ code: 'D', path: 'src/App.tsx' }]);
  });
});

// A file name that is not valid UTF-8. git stores its bytes as they are, so the reader must read the
// file by those bytes, not by a decoded copy that names no file.
describe('a flagged file whose name is not valid UTF-8', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  const RAW_NAME = Buffer.concat([Buffer.from('src/lat'), Buffer.from([0xe9]), Buffer.from('.tsx')]);
  // How the reader returns the name: decoded as UTF-8, as git status names are.
  const SHOWN_NAME = RAW_NAME.toString('utf8');

  async function writeRaw(text: string): Promise<void> {
    await writeFile(Buffer.concat([Buffer.from(`${repo}/`), RAW_NAME]), text, 'utf8');
  }

  // update-index reads the name from stdin, so its bytes reach git as they are.
  async function flagRaw(flag: string): Promise<void> {
    execFileSync('git', ['update-index', flag, '-z', '--stdin'], { cwd: repo, input: Buffer.concat([RAW_NAME, Buffer.from([0])]) });
  }

  beforeEach(async () => {
    await writeRaw('export const Lat = 1;\n');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'raw name');
  });

  it('lists nothing when the flagged file did not change', async () => {
    await flagRaw('--assume-unchanged');
    expect(await statusPaths()).toEqual([]);
  });

  it('lists an edit to it', async () => {
    await flagRaw('--assume-unchanged');
    await writeRaw('export const Lat = 2;\n');
    await expect(makeGitReader({ cwd: repo }).statusZ()).resolves.toEqual([{ code: 'M', path: SHOWN_NAME }]);
  });

  it('lists an edit to it as an edit in a sparse checkout', async () => {
    await git('sparse-checkout', 'set', '--no-cone', '/src/');
    // Without this setting git status clears the flag of a file that is there, and lists the edit
    // itself. With it, only the reader's own listing can find the edit.
    await git('config', 'sparse.expectFilesOutsideOfPatterns', 'true');
    await flagRaw('--skip-worktree');
    await writeRaw('export const Lat = 2;\n');
    await expect(makeGitReader({ cwd: repo }).statusZ()).resolves.toEqual([{ code: 'M', path: SHOWN_NAME }]);
  });
});

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeGitReader } from '../../src/deps/git.js';

const execFileAsync = promisify(execFile);

async function runGit(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repoPath, encoding: 'utf8' });
  return stdout.trimEnd();
}

async function setupTempRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'usabl-git-test-'));
  await runGit(repoPath, ['init', '--initial-branch=main']);
  await runGit(repoPath, ['config', 'user.name', 'Test User']);
  await runGit(repoPath, ['config', 'user.email', 'test@example.com']);

  await writeFile(join(repoPath, 'screen.tsx'), 'first version\n', 'utf8');
  await runGit(repoPath, ['add', 'screen.tsx']);
  await runGit(repoPath, ['commit', '-m', 'seed']);

  await mkdir(join(repoPath, 'src/gate'), { recursive: true });
  await writeFile(join(repoPath, 'src/gate/index.ts'), 'export const gate = true;\n', 'utf8');
  await runGit(repoPath, ['add', 'src/gate/index.ts']);
  await runGit(repoPath, ['commit', '-m', 'add gate file']);

  await writeFile(join(repoPath, 'screen.tsx'), 'second version\n', 'utf8');
  await writeFile(join(repoPath, 'src/gate/local-only.ts'), 'export const localOnly = true;\n', 'utf8');
  return repoPath;
}

describe('makeGitReader', () => {
  let repoPath = '';

  beforeEach(async () => {
    repoPath = await setupTempRepo();
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  it('reads status and head file content from a temp repository', async () => {
    const git = makeGitReader({ cwd: repoPath });

    await expect(git.statusZ()).resolves.toContainEqual({ code: 'M', path: 'screen.tsx' });
    await expect(git.show('HEAD', 'screen.tsx')).resolves.toBe('first version\n');
    await expect(git.show('HEAD', 'missing.tsx')).resolves.toBeNull();
  });

  it('returns null for a path under a file at the ref', async () => {
    // screen.tsx is a file at HEAD, so nothing can sit below it. git reports that path as missing,
    // the same as any other missing path, so the trusted side reads it as absent.
    const git = makeGitReader({ cwd: repoPath });

    await expect(git.show('HEAD', 'screen.tsx/package.json')).resolves.toBeNull();
    await expect(git.show('HEAD', 'src/gate/index.ts/package.json')).resolves.toBeNull();
  });

  it('returns stable tree metadata for tracked and untracked working files without changing the real index', async () => {
    const git = makeGitReader({ cwd: repoPath });
    const indexBefore = await runGit(repoPath, ['diff', '--cached', '--name-only']);

    const firstTree = await git.writeTree();
    const secondTree = await git.writeTree();
    const headTree = await runGit(repoPath, ['rev-parse', 'HEAD^{tree}']);
    const workingTreeFiles = await runGit(repoPath, ['ls-tree', '-r', '--name-only', firstTree]);
    const indexAfter = await runGit(repoPath, ['diff', '--cached', '--name-only']);
    const head = await git.headRef();
    const blobs = await git.lsTree('HEAD', ['screen.tsx', 'missing.tsx']);

    expect(secondTree).toBe(firstTree);
    expect(firstTree).not.toBe(headTree);
    expect(workingTreeFiles.split('\n')).toContain('src/gate/local-only.ts');
    expect(indexAfter).toBe(indexBefore);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(blobs['screen.tsx']).toMatch(/^[0-9a-f]{40}$/);
    expect(blobs).not.toHaveProperty('missing.tsx');
  });

  // A plain object keyed by file name drops a key named __proto__, so a guarded file with that
  // name at the repository root would fall out of the policy hash.
  it('keeps a root file named __proto__ in the tree metadata', async () => {
    await writeFile(join(repoPath, '__proto__'), 'policy\n', 'utf8');
    await runGit(repoPath, ['add', '__proto__']);
    await runGit(repoPath, ['commit', '-m', 'add a file named __proto__']);
    const blobs = await makeGitReader({ cwd: repoPath }).lsTree('HEAD', ['__proto__', 'screen.tsx']);
    expect(Object.keys(blobs).sort()).toEqual(['__proto__', 'screen.tsx']);
    expect(Object.entries(blobs).find(([name]) => name === '__proto__')?.[1]).toMatch(/^[0-9a-f]{40}$/);
  });

  it('lists committed files by prefix and ignores working-tree-only files', async () => {
    const git = makeGitReader({ cwd: repoPath });

    await expect(git.lsFiles('HEAD', 'src/gate')).resolves.toEqual(['src/gate/index.ts']);
    await expect(git.lsFiles('HEAD', 'src/missing')).resolves.toEqual([]);
  });

  it('lists changed files from merge-base to head with diffNameOnly', async () => {
    const git = makeGitReader({ cwd: repoPath });
    const firstCommit = await runGit(repoPath, ['rev-list', '--max-parents=0', 'HEAD']);

    const changed = await git.diffNameOnly(firstCommit);
    expect(changed).toContain('src/gate/index.ts');
    expect(changed).not.toContain('src/gate/local-only.ts');
  });
});

// Git quotes a path with a byte above 0x7f, a newline, a tab, or a double quote unless the
// listing uses -z. A quoted name matches no glob, so a changed screen could read as nothing to
// check. A name that ends in a space is valid too and must not be trimmed away.
describe('makeGitReader with names git would quote or trim', { timeout: 30_000 }, () => {
  const UMLAUT = 'src/pages/Über.tsx';
  const TRAILING_SPACE = 'src/pages/Trailing.tsx ';
  const NEWLINE = 'src/pages/new\nline.tsx';
  const RENAMED_FROM = 'src/pages/Old.tsx';
  const RENAMED_TO = 'src/pages/Renamed.tsx';
  let repoPath = '';
  let base = '';

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'usabl-git-names-'));
    await runGit(repoPath, ['init', '--initial-branch=main']);
    await runGit(repoPath, ['config', 'user.name', 'Test User']);
    await runGit(repoPath, ['config', 'user.email', 'test@example.com']);
    // The default, set on purpose: git quotes non-ASCII bytes in every listing without -z.
    await runGit(repoPath, ['config', 'core.quotePath', 'true']);
    await mkdir(join(repoPath, 'src/pages'), { recursive: true });
    await writeFile(join(repoPath, RENAMED_FROM), 'export const Old = 1;\n', 'utf8');
    await runGit(repoPath, ['add', '-A']);
    await runGit(repoPath, ['commit', '-m', 'seed']);
    base = await runGit(repoPath, ['rev-parse', 'HEAD']);
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  async function commitAwkwardNames(): Promise<void> {
    for (const name of [UMLAUT, TRAILING_SPACE, NEWLINE]) {
      await writeFile(join(repoPath, name), 'export const Page = 1;\n', 'utf8');
    }
    await runGit(repoPath, ['mv', RENAMED_FROM, RENAMED_TO]);
    await runGit(repoPath, ['add', '-A']);
    await runGit(repoPath, ['commit', '-m', 'awkward names']);
  }

  it('lists every changed name from the merge base as git stores it', async () => {
    await commitAwkwardNames();
    const changed = await makeGitReader({ cwd: repoPath }).diffNameOnly(base);
    expect([...changed].sort()).toEqual([NEWLINE, RENAMED_TO, TRAILING_SPACE, UMLAUT].sort());
  });

  it('lists every changed name in the working tree as git stores it, with the new name of a rename', async () => {
    for (const name of [UMLAUT, TRAILING_SPACE, NEWLINE]) {
      await writeFile(join(repoPath, name), 'export const Page = 1;\n', 'utf8');
    }
    await runGit(repoPath, ['mv', RENAMED_FROM, RENAMED_TO]);
    await runGit(repoPath, ['add', '-A']);
    const paths = (await makeGitReader({ cwd: repoPath }).statusZ()).map((entry) => entry.path);
    expect([...paths].sort()).toEqual([NEWLINE, RENAMED_TO, TRAILING_SPACE, UMLAUT].sort());
  });

  it('lists committed names under a prefix as git stores them', async () => {
    await commitAwkwardNames();
    const files = await makeGitReader({ cwd: repoPath }).lsFiles('HEAD', 'src/pages');
    expect(files).toEqual([NEWLINE, RENAMED_TO, TRAILING_SPACE, UMLAUT].sort());
  });

  it('reads the blob of a committed name git would quote', async () => {
    await commitAwkwardNames();
    const blobs = await makeGitReader({ cwd: repoPath }).lsTree('HEAD', [UMLAUT, TRAILING_SPACE, NEWLINE]);
    expect(Object.keys(blobs).sort()).toEqual([NEWLINE, TRAILING_SPACE, UMLAUT].sort());
    for (const sha of Object.values(blobs)) {
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});

// A new folder is listed by git status as the folder alone, and a user's
// status.showUntrackedFiles=no hides untracked files from status entirely. Either way a new
// screen file would match no UI glob, so the run would have nothing to check.
describe('makeGitReader with new untracked files', { timeout: 30_000 }, () => {
  const NEW_SCREEN = 'src/newdir/New.tsx';
  const NEW_HELPER = 'src/newdir/deeper/helper.ts';
  let repoPath = '';

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'usabl-git-untracked-'));
    await runGit(repoPath, ['init', '--initial-branch=main']);
    await runGit(repoPath, ['config', 'user.name', 'Test User']);
    await runGit(repoPath, ['config', 'user.email', 'test@example.com']);
    await writeFile(join(repoPath, 'README.md'), 'seed\n', 'utf8');
    await runGit(repoPath, ['add', '-A']);
    await runGit(repoPath, ['commit', '-m', 'seed']);
    await mkdir(join(repoPath, 'src/newdir/deeper'), { recursive: true });
    await writeFile(join(repoPath, NEW_SCREEN), 'export const New = 1;\n', 'utf8');
    await writeFile(join(repoPath, NEW_HELPER), 'export const helper = 1;\n', 'utf8');
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  it('lists each file of a new folder, not the folder', async () => {
    const entries = await makeGitReader({ cwd: repoPath }).statusZ();
    expect(entries.map((entry) => entry.path).sort()).toEqual([NEW_HELPER, NEW_SCREEN].sort());
    expect(entries.every((entry) => entry.code === '??')).toBe(true);
  });

  it('lists new files when the user config hides untracked files from status', async () => {
    await runGit(repoPath, ['config', 'status.showUntrackedFiles', 'no']);
    const paths = (await makeGitReader({ cwd: repoPath }).statusZ()).map((entry) => entry.path);
    expect(paths.sort()).toEqual([NEW_HELPER, NEW_SCREEN].sort());
  });

  // A listing longer than the buffer usabl reads fails. The error must say what happened in plain
  // words, so the run reports an error a person can act on, never a short list read as complete.
  it('fails with a plain reason when a listing is longer than usabl reads', async () => {
    const git = makeGitReader({ cwd: repoPath, maxBuffer: 16 });
    await expect(git.statusZ()).rejects.toThrow(/git status printed more than usabl reads.*could not list/s);
    const seed = await runGit(repoPath, ['rev-parse', 'HEAD']);
    await runGit(repoPath, ['add', '-A']);
    await runGit(repoPath, ['commit', '-m', 'new files']);
    await expect(git.diffNameOnly(seed)).rejects.toThrow(/git diff printed more than usabl reads/);
  });
});

describe('makeGitReader in a repository with no commits', () => {
  let emptyRepo = '';

  beforeEach(async () => {
    emptyRepo = await mkdtemp(join(tmpdir(), 'usabl-git-empty-'));
    await runGit(emptyRepo, ['init', '--initial-branch=main']);
  });

  afterEach(async () => {
    await rm(emptyRepo, { recursive: true, force: true });
  });

  it('names the fix when HEAD does not exist yet', async () => {
    const git = makeGitReader({ cwd: emptyRepo });
    await expect(git.show('HEAD', 'usabl.config.json')).rejects.toThrow(
      /git cannot read HEAD.*no commits yet.*first commit/s,
    );
  });

  it('names the ref and the fix when a trusted ref does not exist', async () => {
    const git = makeGitReader({ cwd: emptyRepo });
    await expect(git.show('origin/main', 'usabl.config.json')).rejects.toThrow(
      /git cannot read origin\/main.*fetch it/s,
    );
  });
});

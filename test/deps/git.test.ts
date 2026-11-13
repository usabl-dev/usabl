import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

  it('lists committed files under several prefixes in one listing', async () => {
    const git = makeGitReader({ cwd: repoPath });

    await expect(git.lsFilesUnder('HEAD', ['src/gate', 'src/missing'])).resolves.toEqual(['src/gate/index.ts']);
    await expect(git.lsFilesUnder('HEAD', [])).resolves.toEqual([]);
    const whole = await git.lsFilesUnder('HEAD', ['']);
    expect(whole).toContain('src/gate/index.ts');
    expect(whole).not.toContain('src/gate/local-only.ts');
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

  // The guarded path listing is long when a guarded glob starts with a wildcard, which lists the
  // whole tree. .gitignore does not shorten a listing of committed files, so the advice names the
  // entry's form instead.
  it('says to start a guarded glob with a folder name when the guarded listing is too long', async () => {
    await runGit(repoPath, ['add', '-A']);
    await runGit(repoPath, ['commit', '-m', 'new files']);
    const git = makeGitReader({ cwd: repoPath, maxBuffer: 16 });
    const error = await git.lsFilesUnder('HEAD', ['']).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('guarded glob lists too many files');
    expect(message).toMatch(/start the entry with a folder name/i);
    expect(message).not.toContain('.gitignore');
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

  it('says to make a first commit when the working tree cannot be read without HEAD', async () => {
    await writeFile(join(emptyRepo, 'screen.tsx'), 'first version\n', 'utf8');
    const git = makeGitReader({ cwd: emptyRepo });
    const error = await git.writeTree().then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/no commits yet.*make a first commit/is);
    // git's own text, such as "fatal: Not a valid object name HEAD", and the command line stay out.
    expect(message).not.toMatch(/fatal|Command failed|read-tree/);
  });

  // The default branch is not always main, so the example fetches the ref that was named, or says
  // how to find the default branch when the ref names no remote.
  it('builds the fetch example from the ref, never a fixed main', async () => {
    const git = makeGitReader({ cwd: emptyRepo });
    const named = await git.show('upstream/develop', 'usabl.config.json').catch((err: Error) => err.message);
    expect(named).toContain('git fetch upstream develop');
    expect(named).not.toContain('origin main');
    const bare = await git.show('release', 'usabl.config.json').catch((err: Error) => err.message);
    expect(bare).toContain('git remote show origin');
    expect(bare).not.toContain('origin main');
  });
});

// A shallow clone can lack the trusted commit. For a full commit id git then says the path "does not
// exist in" or "exists on disk, but not in" that commit, the same text it gives for a file that is
// truly absent. Read as absent, a trusted policy file would read as no policy, so the reader checks
// that the ref names a commit before it reports a file as absent.
describe('makeGitReader with a trusted commit that is not in the repository', { timeout: 30_000 }, () => {
  const ABSENT_COMMIT = 'deadbeef'.repeat(5);
  let repoPath = '';

  beforeEach(async () => {
    repoPath = await setupTempRepo();
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  it('names the ref and the fix for a full commit id the repository does not have', async () => {
    const git = makeGitReader({ cwd: repoPath });
    // screen.tsx is on disk, so git says "exists on disk, but not in". missing.tsx is not, so git
    // says "does not exist in". Both mean the commit is absent, not the file.
    for (const path of ['screen.tsx', 'missing.tsx']) {
      const error = await git.show(ABSENT_COMMIT, path).then(
        (value) => value,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(new RegExp(`git cannot read ${ABSENT_COMMIT}.*fetch it`, 's'));
    }
  });

  it('still reads a file that is absent at a real commit or branch as absent', async () => {
    const git = makeGitReader({ cwd: repoPath });
    const head = await runGit(repoPath, ['rev-parse', 'HEAD']);
    await expect(git.show(head, 'missing.tsx')).resolves.toBeNull();
    await expect(git.show(head, 'screen.tsx')).resolves.toBe('first version\n');
    await expect(git.show('main', 'missing.tsx')).resolves.toBeNull();
    await expect(git.show('main', 'src/gate/local-only.ts')).resolves.toBeNull();
  });

  // The CLI refuses a --trusted-ref value that starts with a dash, and git gets every argument on
  // its own, never through a shell. The reader still ends git's options before the ref, so a ref
  // such as --output=<file> is never read as an option that writes a file.
  it('passes a ref that starts with a dash or holds shell characters as a ref, never as an option', async () => {
    const git = makeGitReader({ cwd: repoPath });
    for (const ref of ['--output=written', '-x', '$(touch shell-ran)', '`touch shell-ran`']) {
      await expect(git.show(ref, 'usabl.config.json')).rejects.toThrow();
    }
    const listed = await runGit(repoPath, ['status', '--porcelain', '--untracked-files=all']);
    expect(listed).not.toMatch(/written|shell-ran/);
  });

  // git diff pastes the ref into <ref>...HEAD, so --output=<file> as the ref would make git write
  // the listing to a file and print nothing, which reads as no changed files.
  it('never reads a ref as an option in the diff and tree listings', async () => {
    const git = makeGitReader({ cwd: repoPath });
    await expect(git.diffNameOnly('--output=written')).rejects.toThrow();
    await expect(git.lsTree('--output=written', ['screen.tsx'])).rejects.toThrow();
    await expect(git.lsFiles('--output=written', 'src/gate')).rejects.toThrow();
    await expect(git.lsFilesUnder('--output=written', ['src/gate'])).rejects.toThrow();
    await expect(git.lsFilesUnder('--output=written', [''])).rejects.toThrow();
    const listed = await runGit(repoPath, ['status', '--porcelain', '--untracked-files=all']);
    expect(listed).not.toMatch(/written/);
  });
});

// git show <ref>:<path> reads the argument as a path when it names no object and a file in the
// working tree has that exact name. A pull request can commit a file named <ref>:<path>, so a
// trusted read would print the pull request's own commit, or nothing, instead of failing. The
// reader reads objects only, so such a file never changes what a trusted read returns.
describe('makeGitReader reads a trusted file from git objects only', { timeout: 60_000 }, () => {
  let repoPath = '';
  let clonePath = '';

  beforeEach(async () => {
    repoPath = await setupTempRepo();
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
    if (clonePath !== '') await rm(clonePath, { recursive: true, force: true });
    clonePath = '';
  });

  it('throws the missing ref error in a shallow clone that holds a file named <commit>:<path>', async () => {
    await writeFile(join(repoPath, 'usabl.config.json'), '{"trusted":true}\n', 'utf8');
    await runGit(repoPath, ['add', 'usabl.config.json']);
    await runGit(repoPath, ['commit', '-m', 'base']);
    const base = await runGit(repoPath, ['rev-parse', 'HEAD']);
    await writeFile(join(repoPath, `${base}:usabl.config.json`), '{}\n', 'utf8');
    await runGit(repoPath, ['add', `${base}:usabl.config.json`]);
    await runGit(repoPath, ['commit', '-m', 'head adds a file named like the trusted read']);
    clonePath = await mkdtemp(join(tmpdir(), 'usabl-git-shallow-'));
    await runGit(clonePath, ['clone', '--quiet', '--depth', '1', `file://${repoPath}`, '.']);
    const git = makeGitReader({ cwd: clonePath });
    await expect(git.show(base, 'usabl.config.json')).rejects.toThrow(new RegExp(`git cannot read ${base}`));
  });

  it('throws the missing ref error when a file is named origin/main:<path> and origin/main does not exist', async () => {
    await mkdir(join(repoPath, 'origin'), { recursive: true });
    await writeFile(join(repoPath, 'origin/main:usabl.config.json'), '{}\n', 'utf8');
    await runGit(repoPath, ['add', 'origin/main:usabl.config.json']);
    await runGit(repoPath, ['commit', '-m', 'a file named like the trusted read']);
    const git = makeGitReader({ cwd: repoPath });
    await expect(git.show('origin/main', 'usabl.config.json')).rejects.toThrow(/git cannot read origin\/main/);
  });

  it('reads a file as absent at a real commit when a file is named <ref>:<path>', async () => {
    await writeFile(join(repoPath, 'main:.usabl-waivers.json'), '{}\n', 'utf8');
    await runGit(repoPath, ['add', 'main:.usabl-waivers.json']);
    await runGit(repoPath, ['commit', '-m', 'a file named like the trusted read']);
    await expect(makeGitReader({ cwd: repoPath }).show('main', '.usabl-waivers.json')).resolves.toBeNull();
  });

  it('still reads a normal file, an absent one, odd bytes, a large file, and a file in a folder', async () => {
    const odd = 'café\tline\r\nno newline at the end ';
    const large = 'x'.repeat(3 * 1024 * 1024);
    await writeFile(join(repoPath, 'odd.txt'), odd, 'utf8');
    await writeFile(join(repoPath, 'large.txt'), large, 'utf8');
    await runGit(repoPath, ['add', 'odd.txt', 'large.txt']);
    await runGit(repoPath, ['commit', '-m', 'odd and large']);
    const git = makeGitReader({ cwd: repoPath });
    await expect(git.show('HEAD', 'screen.tsx')).resolves.toBe('first version\n');
    await expect(git.show('HEAD', 'missing.tsx')).resolves.toBeNull();
    await expect(git.show('HEAD', 'odd.txt')).resolves.toBe(odd);
    await expect(git.show('HEAD', 'large.txt')).resolves.toBe(large);
    await expect(git.show('HEAD', 'src/gate/index.ts')).resolves.toBe('export const gate = true;\n');
  });
});

// A git ref name cannot start with a dash, be empty, or hold a colon, *, ?, [, a backslash, white
// space, or a control character. git reads such a value another way: as an option, as a path inside
// a commit, or as a pathspec that filters HEAD. Each of those can come back as a file state, such as
// an empty file or an absent one, for a ref usabl never read. So the reader refuses it first.
describe('makeGitReader with a value it cannot use as a ref', { timeout: 30_000 }, () => {
  const REFUSED = /usabl cannot use .* as a git ref/s;
  let repoPath = '';

  beforeEach(async () => {
    repoPath = await setupTempRepo();
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  // Without the refusal, git took each of these as a pathspec over HEAD and printed nothing, so
  // show returned an empty file.
  it('refuses a ref with a glob character instead of reading an empty file', async () => {
    const git = makeGitReader({ cwd: repoPath });
    for (const ref of ['nosuch*', 'nosuch?', 'nosuch[1]', '*', 'HEAD^{/zzz[0-9]}']) {
      await expect(git.show(ref, 'screen.tsx')).rejects.toThrow(REFUSED);
    }
  });

  // git splits a ref at its first colon, so HEAD:pol^{commit} names the file pol^{commit} in HEAD,
  // not a commit. With that file committed, the commit check passed and show read
  // pol/usabl.config.json as absent although it exists.
  it('refuses a ref with a colon instead of reading a file as absent', async () => {
    await mkdir(join(repoPath, 'pol'), { recursive: true });
    await writeFile(join(repoPath, 'pol/usabl.config.json'), '{}\n', 'utf8');
    await writeFile(join(repoPath, 'pol^{commit}'), 'odd name\n', 'utf8');
    await runGit(repoPath, ['add', 'pol/usabl.config.json', 'pol^{commit}']);
    await runGit(repoPath, ['commit', '-m', 'add pol']);
    const git = makeGitReader({ cwd: repoPath });
    await expect(git.show('HEAD:pol', 'usabl.config.json')).rejects.toThrow(REFUSED);
  });

  it('refuses a ref that starts with one dash or two in every function, and git writes nothing', async () => {
    const git = makeGitReader({ cwd: repoPath });
    for (const ref of ['-x', '--output=written']) {
      await expect(git.show(ref, 'screen.tsx')).rejects.toThrow(REFUSED);
      await expect(git.diffNameOnly(ref)).rejects.toThrow(REFUSED);
      await expect(git.lsTree(ref, ['screen.tsx'])).rejects.toThrow(REFUSED);
      await expect(git.lsTree(ref, [])).rejects.toThrow(REFUSED);
      await expect(git.lsFiles(ref, 'src/gate')).rejects.toThrow(REFUSED);
      await expect(git.lsFilesUnder(ref, ['src/gate'])).rejects.toThrow(REFUSED);
      await expect(git.lsFilesUnder(ref, [])).rejects.toThrow(REFUSED);
    }
    const listed = await runGit(repoPath, ['status', '--porcelain', '--untracked-files=all']);
    expect(listed).not.toMatch(/written/);
  });

  // git reads ^X:path and A..B:path as a negative or range revision over a blob. It printed
  // nothing and exited 0, so show read an existing file as empty.
  it('refuses a leading caret or a double dot in every function', async () => {
    await runGit(repoPath, ['switch', '-c', 'feature']);
    const git = makeGitReader({ cwd: repoPath });
    for (const ref of ['^HEAD', '^main', '^', 'main..HEAD', 'main~0..', '..main']) {
      await expect(git.show(ref, 'screen.tsx')).rejects.toThrow(REFUSED);
      await expect(git.diffNameOnly(ref)).rejects.toThrow(REFUSED);
      await expect(git.lsTree(ref, ['screen.tsx'])).rejects.toThrow(REFUSED);
      await expect(git.lsFiles(ref, 'src/gate')).rejects.toThrow(REFUSED);
      await expect(git.lsFilesUnder(ref, ['src/gate'])).rejects.toThrow(REFUSED);
    }
  });

  it('still reads the second parent of a merge as HEAD^2', async () => {
    await runGit(repoPath, ['switch', '-c', 'side', 'HEAD~1']);
    await writeFile(join(repoPath, 'side.txt'), 'side\n', 'utf8');
    await runGit(repoPath, ['add', 'side.txt']);
    await runGit(repoPath, ['commit', '-m', 'side']);
    await runGit(repoPath, ['switch', 'main']);
    await runGit(repoPath, ['merge', '--no-ff', '--no-edit', 'side']);
    const git = makeGitReader({ cwd: repoPath });
    await expect(git.show('HEAD^2', 'side.txt')).resolves.toBe('side\n');
    await expect(git.show('HEAD^2', 'src/gate/index.ts')).resolves.toBeNull();
    await expect(git.lsFilesUnder('HEAD^2', [''])).resolves.toContain('side.txt');
  });

  it('refuses an empty ref, white space, a backslash, and a control character', async () => {
    const git = makeGitReader({ cwd: repoPath });
    for (const ref of ['', 'main ', 'ma in', 'ma\tin', 'ma\nin', 'ma\\in', 'ma\u001b[31min', 'ma\u0000in', 'ma\u007fin']) {
      await expect(git.show(ref, 'screen.tsx')).rejects.toThrow(REFUSED);
    }
  });

  it('shows the refused ref without its control characters', async () => {
    const error = await makeGitReader({ cwd: repoPath })
      .show('ma\u001b]0;title\u0007in', 'screen.tsx')
      .catch((err: Error) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  describe('still reads every ref form usabl takes', () => {
    beforeEach(async () => {
      await runGit(repoPath, ['tag', 'v1']);
      await runGit(repoPath, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    });

    const forms: Array<[string, (repo: string) => Promise<string>]> = [
      ['a branch', async () => 'main'],
      ['a remote-tracking branch', async () => 'origin/main'],
      ['a tag', async () => 'v1'],
      ['a full commit id', async (repo) => runGit(repo, ['rev-parse', 'HEAD'])],
      ['a short commit id', async (repo) => runGit(repo, ['rev-parse', '--short', 'HEAD'])],
      ['HEAD', async () => 'HEAD'],
      ['HEAD~1', async () => 'HEAD~1'],
      ['HEAD^', async () => 'HEAD^'],
      ['main@{1}', async () => 'main@{1}'],
    ];

    it.each(forms)('reads %s', async (_label, refFor) => {
      const ref = await refFor(repoPath);
      const git = makeGitReader({ cwd: repoPath });
      await expect(git.show(ref, 'screen.tsx')).resolves.toBe('first version\n');
      await expect(git.show(ref, 'missing.tsx')).resolves.toBeNull();
      expect(Object.keys(await git.lsTree(ref, ['screen.tsx']))).toEqual(['screen.tsx']);
      await expect(git.lsFilesUnder(ref, [''])).resolves.toContain('screen.tsx');
      await expect(git.diffNameOnly(ref)).resolves.toBeInstanceOf(Array);
    });
  });
});

// usabl reads git's error text to tell a missing file from a failure. git translates that text
// when the user's locale asks for another language, so a German locale turned a missing policy file
// into a crash. This machine may have no git translations, so a stand-in git answers in German
// unless LC_ALL is C, the way a translated git does.
describe('makeGitReader under a non-English locale', { timeout: 30_000 }, () => {
  let repoPath = '';
  let binDir = '';
  const saved = { PATH: process.env['PATH'], LC_ALL: process.env['LC_ALL'], LANG: process.env['LANG'], LANGUAGE: process.env['LANGUAGE'] };

  beforeEach(async () => {
    repoPath = await setupTempRepo();
    binDir = await mkdtemp(join(tmpdir(), 'usabl-git-locale-bin-'));
    const realGit = (await execFileAsync('which', ['git'], { encoding: 'utf8' })).stdout.trim();
    const script = [
      '#!/bin/sh',
      'if [ "$LC_ALL" != "C" ]; then',
      // The reader runs git cat-file blob --end-of-options <ref>:<path>, so the ref is the fourth
      // argument.
      '  case "$4" in',
      "    HEAD:*) echo \"fatal: Pfad '${4#HEAD:}' existiert nicht in 'HEAD'\" >&2; exit 128 ;;",
      "    *) echo \"fatal: ungültiger Objektname '${4%%:*}'.\" >&2; exit 128 ;;",
      '  esac',
      'fi',
      `exec "${realGit}" "$@"`,
      '',
    ].join('\n');
    await writeFile(join(binDir, 'git'), script, { encoding: 'utf8', mode: 0o755 });
    process.env['PATH'] = `${binDir}:${saved.PATH ?? ''}`;
    process.env['LC_ALL'] = 'de_DE.UTF-8';
    process.env['LANG'] = 'de_DE.UTF-8';
    process.env['LANGUAGE'] = 'de';
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(repoPath, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  });

  it('reads a missing file at a ref as absent, not as a failure', async () => {
    const git = makeGitReader({ cwd: repoPath });
    await expect(git.show('HEAD', 'missing.tsx')).resolves.toBeNull();
    await expect(git.show('HEAD', 'screen.tsx')).resolves.toBe('first version\n');
  });

  it('still names the fix when the trusted ref does not exist', async () => {
    const git = makeGitReader({ cwd: repoPath });
    await expect(git.show('origin/nope', 'usabl.config.json')).rejects.toThrow(/git cannot read origin\/nope/);
  });
});

// The ref check refuses a dash before git runs, so a test through the reader cannot see the second
// layer. A stand-in git records every argument list and hands the call to real git, so the test can
// check that --end-of-options comes before the ref in each call that takes one.
describe('makeGitReader ends git options before every ref', { timeout: 30_000 }, () => {
  const ABSENT_COMMIT = 'deadbeef'.repeat(5);
  const SEPARATOR = '\u001f';
  let repoPath = '';
  let binDir = '';
  let logPath = '';
  const savedPath = process.env['PATH'];

  beforeEach(async () => {
    repoPath = await setupTempRepo();
    binDir = await mkdtemp(join(tmpdir(), 'usabl-git-args-bin-'));
    logPath = join(binDir, 'calls.log');
    const realGit = (await execFileAsync('which', ['git'], { encoding: 'utf8' })).stdout.trim();
    const script = [
      '#!/bin/sh',
      `printf '%s\\037' "$@" >> "${logPath}"`,
      `printf '\\n' >> "${logPath}"`,
      `exec "${realGit}" "$@"`,
      '',
    ].join('\n');
    await writeFile(join(binDir, 'git'), script, { encoding: 'utf8', mode: 0o755 });
    await writeFile(logPath, '', 'utf8');
    process.env['PATH'] = `${binDir}:${savedPath ?? ''}`;
  });

  afterEach(async () => {
    if (savedPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = savedPath;
    await rm(repoPath, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  });

  async function calls(): Promise<string[][]> {
    const text = await readFile(logPath, 'utf8');
    return text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => line.split(SEPARATOR).filter((arg, index, all) => index < all.length - 1 || arg.length > 0));
  }

  function expectEndBefore(all: string[][], refArg: string, command: string): void {
    const call = all.find((args) => args[0] === command && args.includes(refArg));
    expect(call, `a git ${command} call with ${refArg}`).toBeDefined();
    const args = call ?? [];
    const end = args.indexOf('--end-of-options');
    expect(end, `--end-of-options in git ${args.join(' ')}`).toBeGreaterThan(-1);
    expect(end).toBeLessThan(args.indexOf(refArg));
  }

  it('puts --end-of-options before the ref in show, the commit check, the diff, and each tree listing', async () => {
    const git = makeGitReader({ cwd: repoPath });
    await git.show('main', 'screen.tsx');
    await git.show(ABSENT_COMMIT, 'missing.tsx').catch(() => undefined);
    await git.diffNameOnly('main');
    await git.lsTree('main', ['screen.tsx']);
    await git.lsFiles('main', 'src/gate');
    await git.lsFilesUnder('main', ['src/gate']);
    await git.lsFilesUnder('HEAD', ['']);
    const all = await calls();
    // show reads the blob with git cat-file.
    expectEndBefore(all, 'main:screen.tsx', 'cat-file');
    expectEndBefore(all, `${ABSENT_COMMIT}^{commit}`, 'rev-parse');
    expectEndBefore(all, 'main...HEAD', 'diff');
    const listings = all.filter((args) => args[0] === 'ls-tree');
    expect(listings).toHaveLength(4);
    for (const args of listings) {
      const ref = args.includes('HEAD') ? 'HEAD' : 'main';
      const end = args.indexOf('--end-of-options');
      expect(end, `--end-of-options in git ${args.join(' ')}`).toBeGreaterThan(-1);
      expect(end).toBeLessThan(args.indexOf(ref));
    }
  });
});

// The commit check reads only one answer from git rev-parse: exit 1 means the ref names no commit.
// Any other failure says nothing about the ref, so it must reach the caller unchanged, never as a
// missing ref and never as an absent file. A stand-in git fails every rev-parse with exit 128.
describe('makeGitReader when the commit check itself fails', { timeout: 30_000 }, () => {
  let repoPath = '';
  let binDir = '';
  const savedPath = process.env['PATH'];

  beforeEach(async () => {
    repoPath = await setupTempRepo();
    binDir = await mkdtemp(join(tmpdir(), 'usabl-git-revparse-bin-'));
    const realGit = (await execFileAsync('which', ['git'], { encoding: 'utf8' })).stdout.trim();
    const script = [
      '#!/bin/sh',
      'if [ "$1" = "rev-parse" ]; then',
      '  echo "fatal: stand-in rev-parse failure" >&2; exit 128',
      'fi',
      `exec "${realGit}" "$@"`,
      '',
    ].join('\n');
    await writeFile(join(binDir, 'git'), script, { encoding: 'utf8', mode: 0o755 });
    process.env['PATH'] = `${binDir}:${savedPath ?? ''}`;
  });

  afterEach(async () => {
    if (savedPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = savedPath;
    await rm(repoPath, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  });

  it('throws the rev-parse failure unchanged for a missing commit and for a real one', async () => {
    const git = makeGitReader({ cwd: repoPath });
    for (const ref of ['deadbeef'.repeat(5), 'HEAD']) {
      const error = await git.show(ref, 'missing.tsx').then(
        (value) => value,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain('stand-in rev-parse failure');
      expect(message).not.toContain('git cannot read');
    }
  });
});

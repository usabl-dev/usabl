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

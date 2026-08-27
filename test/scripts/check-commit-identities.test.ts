import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const scriptPath = resolve('scripts/check-commit-identities.mjs');

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repoPath, encoding: 'utf8' });
  return stdout.trim();
}

async function runPolicy(repoPath: string, args: string[]) {
  return execFileAsync(process.execPath, [scriptPath, ...args], { cwd: repoPath, encoding: 'utf8' });
}

describe('commit identity policy workflow', () => {
  it('uses the commit range gate and skips only the local identity hook in CI', async () => {
    const workflow = await readFile(resolve('.github/workflows/usabl.yml'), 'utf8');
    expect(workflow).toContain('node scripts/check-commit-identities.mjs --range');
    expect(workflow).toContain('SKIP=gitleaks,approved-git-identity pre-commit run --all-files');
  });
});

describe('commit identity policy command', () => {
  let repoPath = '';

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'usabl-identity-test-'));
    await git(repoPath, ['init', '--initial-branch=main']);
    await git(repoPath, ['config', 'user.name', 'Test User']);
    await git(repoPath, ['config', 'user.email', 'test.user@redhat.com']);
    await git(repoPath, ['config', 'user.useConfigOnly', 'true']);
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  it('accepts an approved local identity', async () => {
    await expect(runPolicy(repoPath, ['--local'])).resolves.toMatchObject({
      stdout: 'Commit identities approved.\n',
    });
  });

  it('rejects an unapproved local identity', async () => {
    await git(repoPath, ['config', 'user.email', 'test.user@example.com']);
    await expect(runPolicy(repoPath, ['--local'])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('approved Red Hat address'),
    });
  });

  it('accepts an approved commit range', async () => {
    await writeFile(join(repoPath, 'first.txt'), 'first\n', 'utf8');
    await git(repoPath, ['add', 'first.txt']);
    await git(repoPath, ['commit', '-m', 'test: first']);
    const base = await git(repoPath, ['rev-parse', 'HEAD']);
    await writeFile(join(repoPath, 'second.txt'), 'second\n', 'utf8');
    await git(repoPath, ['add', 'second.txt']);
    await git(repoPath, ['commit', '-m', 'test: second']);
    const head = await git(repoPath, ['rev-parse', 'HEAD']);
    await expect(runPolicy(repoPath, ['--range', base, head])).resolves.toMatchObject({
      stdout: 'Commit identities approved.\n',
    });
  });

  it('accepts an approved Dependabot commit range', async () => {
    await writeFile(join(repoPath, 'first.txt'), 'first\n', 'utf8');
    await git(repoPath, ['add', 'first.txt']);
    await git(repoPath, ['commit', '-m', 'test: first']);
    const base = await git(repoPath, ['rev-parse', 'HEAD']);
    await writeFile(join(repoPath, 'second.txt'), 'second\n', 'utf8');
    await git(repoPath, ['add', 'second.txt']);
    await git(repoPath, [
      '-c',
      'user.name=dependabot[bot]',
      '-c',
      'user.email=49699333+dependabot[bot]@users.noreply.github.com',
      'commit',
      '-m',
      'chore: update dependency',
    ]);
    const head = await git(repoPath, ['rev-parse', 'HEAD']);
    await expect(runPolicy(repoPath, ['--range', base, head])).resolves.toMatchObject({
      stdout: 'Commit identities approved.\n',
    });
  });

  it('rejects an unapproved human author in a commit range', async () => {
    await writeFile(join(repoPath, 'first.txt'), 'first\n', 'utf8');
    await git(repoPath, ['add', 'first.txt']);
    await git(repoPath, ['commit', '-m', 'test: first']);
    const base = await git(repoPath, ['rev-parse', 'HEAD']);
    await writeFile(join(repoPath, 'second.txt'), 'second\n', 'utf8');
    await git(repoPath, ['add', 'second.txt']);
    await git(repoPath, ['config', 'user.email', 'test.user@example.com']);
    await git(repoPath, ['commit', '-m', 'test: second']);
    const head = await git(repoPath, ['rev-parse', 'HEAD']);
    await expect(runPolicy(repoPath, ['--range', base, head])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('unapproved author email'),
    });
  });

  it('rejects an unapproved co-author trailer', async () => {
    await writeFile(join(repoPath, 'first.txt'), 'first\n', 'utf8');
    await git(repoPath, ['add', 'first.txt']);
    await git(repoPath, ['commit', '-m', 'test: first']);
    const base = await git(repoPath, ['rev-parse', 'HEAD']);
    await writeFile(join(repoPath, 'second.txt'), 'second\n', 'utf8');
    await git(repoPath, ['add', 'second.txt']);
    await git(repoPath, ['commit', '-m', 'test: second', '-m', 'Co-authored-by: Other User <other@example.com>']);
    const head = await git(repoPath, ['rev-parse', 'HEAD']);
    await expect(runPolicy(repoPath, ['--range', base, head])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('unapproved co-author email'),
    });
  });
});

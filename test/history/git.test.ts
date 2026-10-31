/**
 * The real history port against a temporary repository: it writes history commits with plumbing,
 * leaves the working tree and the index alone, and reads the branch back as objects.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeHistoryGit } from '../../src/history/git.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

describe('makeHistoryGit', () => {
  let repo = '';

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'usabl-history-git-'));
    await git(repo, ['init', '--initial-branch=main']);
    await git(repo, ['config', 'user.name', 'Test User']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await writeFile(join(repo, 'app.tsx'), 'one\n', 'utf8');
    await git(repo, ['add', 'app.tsx']);
    await git(repo, ['commit', '-m', 'one']);
    await writeFile(join(repo, 'app.tsx'), 'two\n', 'utf8');
    await git(repo, ['commit', '-am', 'two']);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('writes a history commit without touching the working tree or the index', async () => {
    const port = makeHistoryGit({ cwd: repo, ref: 'usabl/history' });
    const statusBefore = await git(repo, ['status', '--porcelain']);

    const first = await port.commitFile(null, '2026-10.jsonl', 'one line\n', 'first');
    await port.setBranch('usabl/history', first);
    const second = await port.commitFile(first, '2026-11.jsonl', 'next\n', 'second');
    await port.setBranch('usabl/history', second);

    expect(await git(repo, ['status', '--porcelain'])).toBe(statusBefore);
    expect(await git(repo, ['branch', '--show-current'])).toBe('main');
    expect(await port.resolveCommit('usabl/history')).toBe(second);
    expect(await port.listFiles(second)).toEqual(['2026-10.jsonl', '2026-11.jsonl']);
    expect(await port.readFile(second, '2026-10.jsonl')).toBe('one line\n');
    expect(await port.readFile(second, '2026-12.jsonl')).toBeNull();
  });

  it('resolves a missing ref to null and answers ancestry', async () => {
    const port = makeHistoryGit({ cwd: repo });
    const head = await port.resolveCommit('HEAD');
    const parent = await port.resolveCommit('HEAD~1');

    expect(await port.resolveCommit('origin/usabl/history')).toBeNull();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(await port.isAncestor(parent!, head!)).toBe(true);
    expect(await port.isAncestor(head!, parent!)).toBe(false);
    expect(await port.isAncestor(head!, head!)).toBe(true);
  });
});

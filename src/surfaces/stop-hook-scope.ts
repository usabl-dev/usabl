/**
 * What a Stop hook checks: the commit where this branch left the trusted branch, found with git.
 *
 * CI checks every file changed since the pull request left its base branch. The hook checks the
 * same set, plus changes that are not committed yet, so an agent that commits its work and then
 * stops is still checked. The trusted branch is the default branch git records for origin, in
 * refs/remotes/origin/HEAD. The starting commit is the merge base of that branch and HEAD.
 *
 * This unit reads git and reports what it found. It never decides a verdict, and it never guesses:
 * a starting commit it cannot find is reported as not found, never as "no commits to check".
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { firstLine } from '../primitives/first-line.js';

const execFileAsync = promisify(execFile);

/** The ref git sets on clone to name the default branch of origin. */
export const TRUSTED_BRANCH_POINTER = 'refs/remotes/origin/HEAD';

/** Why a trusted branch is named but its starting commit could not be used. */
export type StartingCommitProblem = 'branch-missing' | 'no-common-commit' | 'not-ancestor' | 'git-failed';

/**
 * What the hook found. `found` carries the trusted branch as git names it (for example
 * origin/main) and the full commit id where HEAD left it. `no-trusted-branch` means git records no
 * default branch for origin. `not-found` means a trusted branch is named and its starting commit
 * could not be found or used; `detail` is git's first line for a git failure.
 */
export type StartingCommit =
  | { kind: 'found'; branch: string; commit: string }
  | { kind: 'no-trusted-branch' }
  | { kind: 'not-found'; branch: string; problem: StartingCommitProblem; detail: string | null };

/** One git call: its exit code (null when git did not run) and what it printed. */
export interface ScopeGitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type ScopeGit = (args: readonly string[]) => Promise<ScopeGitResult>;

// usabl reads git's exit codes here, never its words, but the detail it prints is kept in English.
const ENGLISH_MESSAGES = { LC_ALL: 'C' };

/** git, run in `cwd` with an argument list, never a shell string. */
export function scopeGit(cwd: string): ScopeGit {
  return async (args) => {
    try {
      const { stdout, stderr } = await execFileAsync('git', [...args], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, ...ENGLISH_MESSAGES },
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const code: unknown = typeof err === 'object' && err !== null ? Reflect.get(err, 'code') : null;
      const stdout: unknown = typeof err === 'object' && err !== null ? Reflect.get(err, 'stdout') : '';
      const stderr: unknown = typeof err === 'object' && err !== null ? Reflect.get(err, 'stderr') : '';
      return {
        code: typeof code === 'number' ? code : null,
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : err instanceof Error ? err.message : String(err),
      };
    }
  };
}

// A full commit id, SHA-1 or SHA-256. Anything else is not read as a commit.
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function oneLine(stdout: string): string {
  return stdout.replace(/\r?\n$/, '');
}

function gitFailed(branch: string, result: ScopeGitResult): StartingCommit {
  const detail = firstLine(result.stderr);
  return { kind: 'not-found', branch, problem: 'git-failed', detail: detail.length > 0 ? detail : 'git did not run' };
}

// The branch as a person names it: refs/remotes/origin/main reads as origin/main.
function branchName(ref: string): string {
  return ref.startsWith('refs/remotes/') ? ref.slice('refs/remotes/'.length) : ref;
}

/**
 * The commit where HEAD left the trusted branch, or why there is none to use.
 *
 * Each step reads one git exit code. Exit 1 is git's answer "no" for each of these commands, and
 * every other failure is a git failure, never read as "no".
 */
export async function findStartingCommit(git: ScopeGit): Promise<StartingCommit> {
  const pointer = await git(['symbolic-ref', '--quiet', TRUSTED_BRANCH_POINTER]);
  if (pointer.code === 1) {
    return { kind: 'no-trusted-branch' };
  }
  if (pointer.code !== 0 || oneLine(pointer.stdout).length === 0) {
    return gitFailed('origin/HEAD', pointer);
  }
  const ref = oneLine(pointer.stdout);
  const branch = branchName(ref);

  const tip = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (tip.code === 1) {
    return { kind: 'not-found', branch, problem: 'branch-missing', detail: null };
  }
  const tipCommit = oneLine(tip.stdout);
  if (tip.code !== 0 || !COMMIT_ID.test(tipCommit)) {
    return gitFailed(branch, tip);
  }

  const base = await git(['merge-base', tipCommit, 'HEAD']);
  if (base.code === 1) {
    return { kind: 'not-found', branch, problem: 'no-common-commit', detail: null };
  }
  const commit = oneLine(base.stdout);
  if (base.code !== 0 || !COMMIT_ID.test(commit)) {
    return gitFailed(branch, base);
  }

  // A merge base is an ancestor of HEAD by definition. This is checked anyway, because the scope
  // and the receipt both rest on it, and a commit that is not one would scope the wrong changes.
  const ancestor = await git(['merge-base', '--is-ancestor', commit, 'HEAD']);
  if (ancestor.code === 1) {
    return { kind: 'not-found', branch, problem: 'not-ancestor', detail: null };
  }
  if (ancestor.code !== 0) {
    return gitFailed(branch, ancestor);
  }
  return { kind: 'found', branch, commit };
}

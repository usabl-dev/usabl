/**
 * What a Stop hook checks. CI checks every file changed since the pull request left its base
 * branch, so the hook checks the same set: every file changed since this branch left the trusted
 * branch, plus changes that are not committed yet. An agent that commits its work and then stops
 * is checked, where the hook used to say there was nothing to check.
 *
 * These tests use real git, the real hook ports, and the real run(), with a fake check runner
 * that records which screens it was asked to scan.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Deps, Result, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { makeGitReader } from '../../src/deps/git.js';
import {
  makeStopHookRunnerPorts,
  runStopHookFromStdin,
  type StopHookRunnerPorts,
} from '../../src/surfaces/stop-hook-runner.js';
import {
  branchScopeGapText,
  findStartingCommit,
  type ScopeGit,
  type ScopeGitResult,
  type ScopeProblem,
} from '../../src/surfaces/stop-hook-scope.js';
import { memoryPinStore } from '../support/memory-pin-store.js';
import { REAL_PROCESS_BUDGET_MS } from '../support/timing.js';

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'src/routes.tsx', wideBlastGlobs: [] },
  surfaces: [
    { id: 'home', url: 'http://127.0.0.1:5173/', files: ['src/App.tsx'] },
    { id: 'other', url: 'http://127.0.0.1:5173/other', files: ['src/Other.tsx'] },
  ],
  guardedPaths: [],
};

const CONFIG_TEXT = JSON.stringify(config, null, 2) + '\n';

let repo = '';

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=usabl test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

async function write(path: string, text: string): Promise<void> {
  await mkdir(join(repo, path, '..'), { recursive: true });
  await writeFile(join(repo, path), text);
}

// The trusted branch as a clone records it: origin/main at the local main, named by
// refs/remotes/origin/HEAD.
function recordTrustedBranch(): void {
  git('update-ref', 'refs/remotes/origin/main', 'main');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
}

function commitOf(ref: string): string {
  return git('rev-parse', ref).trim();
}

async function storedReceipt(): Promise<{ baseRevision: unknown }> {
  return JSON.parse(await readFile(join(repo, '.usabl', 'receipt.json'), 'utf8')) as { baseRevision: unknown };
}

// Every folder a test made, so afterEach removes a clone as well as the first repository.
const made: string[] = [];

beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'usabl-hook-scope-')));
  made.push(repo);
  git('init', '-q', '-b', 'main');
  await write('.gitignore', '.usabl/\n');
  await write('usabl.config.json', CONFIG_TEXT);
  await write('src/App.tsx', 'export const App = 1;\n');
  await write('README.md', 'app\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
});

afterEach(async () => {
  for (const folder of made.splice(0)) {
    await rm(folder, { recursive: true, force: true });
  }
});

function blockReason(stdout: string): string {
  const payload = JSON.parse(stdout.trim()) as { decision?: string; reason?: string };
  expect(payload.decision).toBe('block');
  return payload.reason ?? '';
}

function insideFrame(text: string, value: string): boolean {
  const frameStart = text.indexOf('[BEGIN UNTRUSTED TEXT');
  return frameStart > 0 && text.indexOf(value) > frameStart && !text.slice(0, frameStart).includes(value);
}

function hook() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const scanned: string[] = [];
  const base = makeStopHookRunnerPorts({ startDir: repo, env: {} });
  const ports: StopHookRunnerPorts = {
    ...base,
    pins: memoryPinStore(),
    stdoutWrite: async (text) => {
      stdout.push(text);
    },
    stderrWrite: async (text) => {
      stderr.push(text);
    },
    buildDeps: async (): Promise<Deps> => {
      const fake = makeFakeDeps();
      return {
        ...fake,
        git: makeGitReader({ cwd: repo }),
        fs: makeFsGlob({ cwd: repo }),
        checkRunner: {
          scan: async (screen) => {
            scanned.push(screen.id);
            return fake.checkRunner.scan(screen);
          },
        },
      };
    },
  };
  return { ports, scanned, stdout: () => stdout.join(''), stderr: () => stderr.join('') };
}

// Each stop below runs several real git processes, and some tests stop two or three times, so
// they take the shared budget for tests that wait on a real process. See test/support/timing.ts.
describe('the Stop hook checks what CI will check', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  it('scans a UI change the agent committed before it stopped', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('src/App.tsx', 'export const App = 2;\n');
    git('commit', '-q', '-am', 'change the app');
    expect(git('status', '--porcelain')).toBe('');

    const h = hook();
    expect(await runStopHookFromStdin('{}', h.ports)).toBe(0);
    expect(h.scanned).toEqual(['home']);
    expect(h.stderr()).not.toContain('IDLE');
    expect(h.stderr()).toContain('VERIFIED');
  });

  it('still scans an uncommitted UI change on top of the committed ones', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('README.md', 'more\n');
    git('commit', '-q', '-am', 'docs only');
    await write('src/App.tsx', 'export const App = 3;\n');

    const h = hook();
    await runStopHookFromStdin('{}', h.ports);
    expect(h.scanned).toEqual(['home']);
  });

  it('says nothing to check when the branch changed no UI file', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('README.md', 'more\n');
    git('commit', '-q', '-am', 'docs only');

    const h = hook();
    await runStopHookFromStdin('{}', h.ports);
    expect(h.scanned).toEqual([]);
    expect(h.stderr()).toContain('IDLE');
  });
});

describe('the receipt binds the starting commit', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  it('records the commit where the branch left the trusted branch in the receipt it saves', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('src/App.tsx', 'export const App = 2;\n');
    git('commit', '-q', '-am', 'change the app');

    const h = hook();
    await runStopHookFromStdin('{}', h.ports);
    expect(h.stderr()).toContain('VERIFIED');
    expect((await storedReceipt()).baseRevision).toBe(commitOf('main'));
  });

  // The false green this closes: a receipt minted while the stop checked only uncommitted
  // changes matched the same tree on a later stop that also checks committed work, so that work
  // was never scanned.
  it('does not take a receipt minted for a narrower set of changes as proof for a wider one', async () => {
    git('switch', '-q', '-c', 'feature');
    await write('src/Other.tsx', 'export const Other = 2;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'change the other screen');
    await write('src/App.tsx', 'export const App = 2;\n');

    // No trusted branch yet, so this stop checks only the uncommitted change.
    const first = hook();
    await runStopHookFromStdin('{}', first.ports);
    expect(first.scanned).toEqual(['home']);
    expect(first.stderr()).toContain('VERIFIED');
    expect((await storedReceipt()).baseRevision).toBeNull();

    recordTrustedBranch();
    const second = hook();
    await runStopHookFromStdin('{}', second.ports);
    expect(second.stderr()).not.toContain('not re-scanned');
    expect([...second.scanned].sort()).toEqual(['home', 'other']);
    expect(second.stderr()).toContain(
      'The stored receipt for this tree did not verify, so this stop ran a full check instead of using it. ' +
        'Why: the receipt was minted for changes since a different commit on the trusted branch',
    );
    expect((await storedReceipt()).baseRevision).toBe(commitOf('main'));
  });
});

describe('the fast path stays', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  // A stored receipt for the same tree and the same starting commit, with no waiver that ended,
  // answers the stop with no scan, so a long branch does not pay for a full check on every stop.
  it('answers a second stop of an unchanged branch from the stored receipt without a scan', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('src/App.tsx', 'export const App = 2;\n');
    await write('src/Other.tsx', 'export const Other = 2;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'change both screens');

    const first = hook();
    await runStopHookFromStdin('{}', first.ports);
    expect([...first.scanned].sort()).toEqual(['home', 'other']);
    expect(first.stderr().startsWith('VERIFIED (exit 0')).toBe(true);
    expect(first.stderr()).not.toContain('not re-scanned');

    const second = hook();
    await runStopHookFromStdin('{}', second.ports);
    expect(second.scanned).toEqual([]);
    expect(second.stderr().startsWith('VERIFIED (exit 0, stored receipt, not re-scanned')).toBe(true);
    expect(second.stdout()).not.toContain('"decision":"block"');
  });

  it('scans again once the branch has a new commit', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('src/App.tsx', 'export const App = 2;\n');
    git('commit', '-q', '-am', 'change the app');
    await runStopHookFromStdin('{}', hook().ports);

    await write('src/Other.tsx', 'export const Other = 2;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'change the other screen');
    const h = hook();
    await runStopHookFromStdin('{}', h.ports);
    expect([...h.scanned].sort()).toEqual(['home', 'other']);
    expect(h.stderr()).not.toContain('not re-scanned');
  });
});

describe('no trusted branch at all', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  const NOTE =
    'Note: usabl found no trusted branch to compare this branch with, because git records no default branch for origin ' +
    '(refs/remotes/origin/HEAD is not set). So this stop checked only the changes that are not committed. ' +
    'Work already committed on this branch was not checked on this stop.';

  // With no trusted branch there is nothing to compare with, so the stop keeps the uncommitted
  // scope, and says so on every stop, so nothing to check never reads as the whole branch.
  it('checks the uncommitted changes and says that committed work was not checked', async () => {
    git('switch', '-q', '-c', 'feature');
    await write('src/Other.tsx', 'export const Other = 2;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'change the other screen');

    const idle = hook();
    await runStopHookFromStdin('{}', idle.ports);
    expect(idle.scanned).toEqual([]);
    expect(idle.stderr()).toContain('IDLE');
    expect(idle.stderr()).toContain(NOTE);
    const shown = JSON.parse(idle.stdout().trim()) as { systemMessage?: string };
    expect(shown.systemMessage).toContain(NOTE);

    await write('src/App.tsx', 'export const App = 2;\n');
    const h = hook();
    await runStopHookFromStdin('{}', h.ports);
    expect(h.scanned).toEqual(['home']);
    expect(h.stderr()).toContain('VERIFIED');
    expect(h.stderr()).toContain(NOTE);
    expect(h.stderr()).toContain('git remote set-head origin --auto');
    expect((await storedReceipt()).baseRevision).toBeNull();
  });

  it('says so on a stored receipt allow too', async () => {
    await write('src/App.tsx', 'export const App = 2;\n');
    await runStopHookFromStdin('{}', hook().ports);
    const h = hook();
    await runStopHookFromStdin('{}', h.ports);
    expect(h.scanned).toEqual([]);
    expect(h.stderr()).toContain('stored receipt, not re-scanned');
    expect(h.stderr()).toContain(NOTE);
  });
});

describe('no starting commit, no guess', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  function expectScopeGap(h: ReturnType<typeof hook>, reason: string, next = 'Next: fetch the trusted branch'): string {
    const text = blockReason(h.stdout());
    expect(text.startsWith('NOT verified - not covered: usabl could not find where this branch left the trusted branch')).toBe(true);
    expect(text).toContain(reason);
    expect(text).toContain('checked nothing on this stop');
    expect(text).toContain('It did not fall back to the uncommitted changes alone or to the whole history.');
    expect(text).toContain(next);
    expect(text).not.toContain('IDLE');
    expect(text).not.toContain('VERIFIED');
    expect(h.scanned).toEqual([]);
    return text;
  }

  // A shallow clone holds only the newest commit of each branch, so git cannot find where the
  // branch left the trusted branch.
  it('reports a gap in a shallow clone that does not hold the commit the branch left', async () => {
    await write('README.md', 'second\n');
    git('commit', '-q', '-am', 'second on main');
    git('switch', '-q', '-c', 'feature', 'HEAD~1');
    await write('src/App.tsx', 'export const App = 2;\n');
    git('commit', '-q', '-am', 'change the app');
    git('switch', '-q', 'main');

    const source = repo;
    repo = await realpath(await mkdtemp(join(tmpdir(), 'usabl-hook-shallow-')));
    made.push(repo);
    execFileSync('git', ['clone', '-q', '--depth', '1', '--no-single-branch', '--branch', 'feature', `file://${source}`, repo], {
      stdio: 'ignore',
    });
    expect(git('rev-parse', '--is-shallow-repository').trim()).toBe('true');
    expect(git('symbolic-ref', 'refs/remotes/origin/HEAD').trim()).toBe('refs/remotes/origin/main');

    const h = hook();
    expect(await runStopHookFromStdin('{}', h.ports)).toBe(0);
    const text = expectScopeGap(h, 'this branch and the trusted branch share no commit in this clone');
    expect(insideFrame(text, 'trusted branch: origin/main')).toBe(true);
  });

  it('reports a gap when origin names a default branch this clone has no commit for', async () => {
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone');
    git('switch', '-q', '-c', 'feature');
    await write('src/App.tsx', 'export const App = 2;\n');
    git('commit', '-q', '-am', 'change the app');

    const h = hook();
    await runStopHookFromStdin('{}', h.ports);
    // After a default branch rename, origin/HEAD still names the old branch and a fetch does not
    // move it, so the step names git remote set-head origin --auto first.
    const text = expectScopeGap(
      h,
      'this clone has no commit for it',
      'Next: run git remote set-head origin --auto, which records the default branch of origin again, then fetch the trusted branch',
    );
    expect(insideFrame(text, 'trusted branch: origin/gone')).toBe(true);
  });

  it('names git remote set-head origin --auto first in the check text for a missing branch, and only there', () => {
    const gap = (problem: ScopeProblem) => branchScopeGapText({ kind: 'gap', problem, branch: 'origin/gone', detail: null });
    expect(gap('branch-missing')).toContain(
      'Next: run git remote set-head origin --auto, which records the default branch of origin again, then fetch the trusted branch',
    );
    expect(gap('branch-missing')).toContain('then run usabl check --branch-scope again.');
    expect(gap('no-common-commit')).toContain('Next: fetch the trusted branch');
    expect(gap('no-common-commit')).not.toContain('set-head');
  });

  // Only a branch of origin is a trusted branch. origin/HEAD pointed at a local branch or a tag
  // on HEAD made the starting commit HEAD itself, so committed work read as nothing to check.
  for (const [kind, target] of [
    ['a local branch', 'refs/heads/feature'],
    ['a tag', 'refs/tags/here'],
  ] as const) {
    it(`reports a gap when origin/HEAD names ${kind}, not a branch of origin`, async () => {
      git('switch', '-q', '-c', 'feature');
      await write('src/App.tsx', 'export const App = 2;\n');
      git('commit', '-q', '-am', 'change the app');
      git('tag', 'here');
      git('symbolic-ref', 'refs/remotes/origin/HEAD', target);

      const h = hook();
      await runStopHookFromStdin('{}', h.ports);
      const text = expectScopeGap(
        h,
        'which is not a branch of origin under refs/remotes/origin/',
        'Next: run git remote set-head origin --auto, which records the default branch of origin again, then fetch the trusted branch',
      );
      expect(insideFrame(text, `trusted branch: ${target}`)).toBe(true);
    });
  }

  it('reads a target of origin/HEAD outside refs/remotes/origin/ as a gap before any other git call', async () => {
    for (const target of ['refs/heads/main', 'refs/tags/v1', 'refs/remotes/upstream/main', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/']) {
      const calls: string[][] = [];
      const start = await findStartingCommit(async (args) => {
        calls.push([...args]);
        return { code: 0, stdout: `${target}\n`, stderr: '' };
      });
      expect(start).toEqual({ kind: 'not-found', branch: target, problem: 'not-remote-branch', detail: null });
      expect(calls).toHaveLength(1);
    }
  });

  it('reports a gap when the commit is not an ancestor of HEAD', async () => {
    const h = hook();
    h.ports.findStartingCommit = async () => ({ kind: 'not-found', branch: 'origin/main', problem: 'not-ancestor', detail: null });
    await runStopHookFromStdin('{}', h.ports);
    expectScopeGap(h, 'the commit git found is not an ancestor of HEAD');
  });

  it('reports a gap, with git error inside the frame, when git fails while it looks', async () => {
    const h = hook();
    h.ports.findStartingCommit = async () => ({
      kind: 'not-found',
      branch: 'origin/main',
      problem: 'git-failed',
      detail: 'fatal: bad object deadbeef',
    });
    await runStopHookFromStdin('{}', h.ports);
    const text = expectScopeGap(h, 'git failed while it looked for that commit');
    expect(insideFrame(text, 'error: fatal: bad object deadbeef')).toBe(true);
  });

  it('reports a gap when the lookup itself throws', async () => {
    const h = hook();
    h.ports.findStartingCommit = async () => {
      throw new Error('spawn git EAGAIN');
    };
    await runStopHookFromStdin('{}', h.ports);
    const text = expectScopeGap(h, 'git failed while it looked for that commit');
    expect(insideFrame(text, 'error: spawn git EAGAIN')).toBe(true);
  });

  // A listing that fails is never read as nothing to check, and never as a run that failed open.
  it('reports a gap when git cannot list the changes since the starting commit', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    const h = hook();
    const buildDeps = h.ports.buildDeps;
    h.ports.buildDeps = async (loaded) => {
      const deps = await buildDeps(loaded);
      deps.git.diffNameOnly = async () => {
        throw new Error('git diff printed more than usabl reads, so usabl could not list the files it needs');
      };
      return deps;
    };
    await runStopHookFromStdin('{}', h.ports);
    const text = expectScopeGap(h, 'git could not list the files changed since that commit');
    expect(insideFrame(text, 'error: git diff printed more than usabl reads')).toBe(true);
  });

  it('lets one continuation through, marked NOT verified, and names changed guarded files', async () => {
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone');
    await write('.usabl-waivers.json', '{"version":1,"waivers":[]}\n');
    const h = hook();
    await runStopHookFromStdin(JSON.stringify({ stop_hook_active: true }), h.ports);
    expect(h.stdout()).not.toContain('"decision":"block"');
    const text = h.stderr();
    expect(text.startsWith('NOT verified - not covered')).toBe(true);
    expect(text).toContain('continuation already active');
    expect(text).toContain('Guarded file changed: 1');
    expect(insideFrame(text, 'guarded files: .usabl-waivers.json')).toBe(true);
    expect(h.scanned).toEqual([]);
  });
});

describe('the scope in the cases that look like a missing starting commit', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  // A detached HEAD still has a merge base with the trusted branch, so the stop checks every
  // change since HEAD left it, as on a branch.
  it('checks every change since HEAD left the trusted branch on a detached HEAD', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('src/App.tsx', 'export const App = 2;\n');
    git('commit', '-q', '-am', 'change the app');
    git('switch', '-q', '--detach', 'feature');

    const h = hook();
    await runStopHookFromStdin('{}', h.ports);
    expect(h.scanned).toEqual(['home']);
    expect((await storedReceipt()).baseRevision).toBe(commitOf('main'));
  });

  // After a rebase the branch left the trusted branch at its new tip, so the stop checks the
  // rebased commits and not the changes the branch took in from the trusted branch.
  it('checks only the rebased commits after a rebase onto a newer trusted branch', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('src/App.tsx', 'export const App = 2;\n');
    git('commit', '-q', '-am', 'change the app');
    const first = hook();
    await runStopHookFromStdin('{}', first.ports);
    const oldBase = commitOf('main');
    expect((await storedReceipt()).baseRevision).toBe(oldBase);

    git('switch', '-q', 'main');
    await write('src/Other.tsx', 'export const Other = 2;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'the other screen lands on main');
    recordTrustedBranch();
    git('switch', '-q', 'feature');
    git('rebase', '-q', 'main');

    const second = hook();
    await runStopHookFromStdin('{}', second.ports);
    expect(second.scanned).toEqual(['home']);
    expect((await storedReceipt()).baseRevision).toBe(commitOf('main'));
    expect(commitOf('main')).not.toBe(oldBase);
  });

  // On the trusted branch itself, the merge base is the trusted branch's tip when the local
  // branch is level with it or ahead of it. The stop checks the commits not on the trusted branch
  // yet and the uncommitted changes.
  it('checks uncommitted changes on the trusted branch when it is level with origin', async () => {
    recordTrustedBranch();
    const idle = hook();
    await runStopHookFromStdin('{}', idle.ports);
    expect(idle.scanned).toEqual([]);
    expect(idle.stderr()).toContain('IDLE');

    await write('src/App.tsx', 'export const App = 2;\n');
    const h = hook();
    await runStopHookFromStdin('{}', h.ports);
    expect(h.scanned).toEqual(['home']);
    expect((await storedReceipt()).baseRevision).toBe(commitOf('origin/main'));
  });

  it('checks commits not yet on origin when the local trusted branch is ahead of it', async () => {
    recordTrustedBranch();
    const pushed = commitOf('main');
    await write('src/App.tsx', 'export const App = 2;\n');
    git('commit', '-q', '-am', 'not pushed yet');

    const h = hook();
    await runStopHookFromStdin('{}', h.ports);
    expect(h.scanned).toEqual(['home']);
    expect((await storedReceipt()).baseRevision).toBe(pushed);
  });
});

describe('findStartingCommit reads exit codes, never a failure as "no"', () => {
  const COMMIT = 'c'.repeat(40);

  function scripted(answers: Record<string, ScopeGitResult>): ScopeGit {
    return async (args) => answers[args[0] === 'merge-base' && args[1] === '--is-ancestor' ? 'is-ancestor' : args[0]!] ?? {
      code: 0,
      stdout: '',
      stderr: '',
    };
  }

  const ok = (stdout: string): ScopeGitResult => ({ code: 0, stdout: `${stdout}\n`, stderr: '' });
  const no: ScopeGitResult = { code: 1, stdout: '', stderr: '' };
  const broken: ScopeGitResult = { code: 128, stdout: '', stderr: 'fatal: unable to read refs\nmore detail' };

  it('reads exit 1 from symbolic-ref as no trusted branch', async () => {
    await expect(findStartingCommit(scripted({ 'symbolic-ref': no }))).resolves.toEqual({ kind: 'no-trusted-branch' });
  });

  it('reads any other symbolic-ref failure as a git failure, never as no trusted branch', async () => {
    await expect(findStartingCommit(scripted({ 'symbolic-ref': broken }))).resolves.toEqual({
      kind: 'not-found',
      branch: 'origin/HEAD',
      problem: 'git-failed',
      detail: 'fatal: unable to read refs',
    });
  });

  it('reads a merge-base failure other than exit 1 as a git failure', async () => {
    const git = scripted({
      'symbolic-ref': ok('refs/remotes/origin/main'),
      'rev-parse': ok(COMMIT),
      'merge-base': broken,
    });
    await expect(findStartingCommit(git)).resolves.toMatchObject({ kind: 'not-found', problem: 'git-failed' });
  });

  it('refuses a merge base that is not a full commit id', async () => {
    const git = scripted({
      'symbolic-ref': ok('refs/remotes/origin/main'),
      'rev-parse': ok(COMMIT),
      'merge-base': ok('not-a-commit'),
    });
    await expect(findStartingCommit(git)).resolves.toMatchObject({ kind: 'not-found', problem: 'git-failed' });
  });

  it('finds the commit when every step answers', async () => {
    const git = scripted({
      'symbolic-ref': ok('refs/remotes/origin/main'),
      'rev-parse': ok(COMMIT),
      'merge-base': ok(COMMIT),
      'is-ancestor': { code: 0, stdout: '', stderr: '' },
    });
    await expect(findStartingCommit(git)).resolves.toEqual({
      kind: 'found',
      branch: 'origin/main',
      commit: COMMIT,
      policy: 'starting-commit',
    });
  });

  // Where the config is decides where policy is read. The config lookups are the rev-parse calls
  // that name a path: exit 0 means the commit holds the file, exit 1 means it does not.
  function withConfigAt(answers: { start: ScopeGitResult; tip: ScopeGitResult }): ScopeGit {
    const TIP = 'd'.repeat(40);
    return async (args) => {
      if (args[0] === 'symbolic-ref') return ok('refs/remotes/origin/main');
      if (args[0] === 'merge-base') return args[1] === '--is-ancestor' ? { code: 0, stdout: '', stderr: '' } : ok(COMMIT);
      const target = args.at(-1) ?? '';
      if (target === `${COMMIT}:usabl.config.json`) return answers.start;
      if (target === `${TIP}:usabl.config.json`) return answers.tip;
      return ok(TIP);
    };
  }

  it('reads policy from the branch when neither the starting commit nor the trusted branch holds a config', async () => {
    await expect(findStartingCommit(withConfigAt({ start: no, tip: no }))).resolves.toMatchObject({
      kind: 'found',
      policy: 'branch-sets-usabl-up',
    });
  });

  it('reads a branch older than the setup when only the trusted branch holds a config', async () => {
    await expect(findStartingCommit(withConfigAt({ start: no, tip: ok('') }))).resolves.toMatchObject({
      kind: 'found',
      policy: 'branch-older-than-setup',
    });
  });

  it('keeps the starting commit as the policy reference when it holds a config', async () => {
    for (const tip of [ok(''), no]) {
      await expect(findStartingCommit(withConfigAt({ start: ok(''), tip }))).resolves.toMatchObject({
        kind: 'found',
        policy: 'starting-commit',
      });
    }
  });

  it('reads a config lookup that fails as a git failure, never as no config', async () => {
    await expect(findStartingCommit(withConfigAt({ start: broken, tip: no }))).resolves.toMatchObject({
      kind: 'not-found',
      problem: 'git-failed',
      detail: 'fatal: unable to read refs',
    });
    await expect(findStartingCommit(withConfigAt({ start: no, tip: broken }))).resolves.toMatchObject({
      kind: 'not-found',
      problem: 'git-failed',
    });
  });
});

// A plain usabl check receipt never answers a stop that has a starting commit, so advice to run a
// check names the one whose receipt does: usabl check --branch-scope. A stop with no starting
// commit keeps usabl check. Which stops block and which allow does not change.
describe('the advice names the check that answers the next stop', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  type Shape = Partial<Pick<Result, 'verdict' | 'exitCode' | 'accessibilityVerdict'>>;

  // A branch with one committed UI change. With the trusted branch recorded, the stop has a
  // starting commit; without it, the stop keeps the uncommitted scope.
  async function branch(withStart: boolean): Promise<void> {
    if (withStart) {
      recordTrustedBranch();
    }
    git('switch', '-q', '-c', 'feature');
    await write('src/App.tsx', 'export const App = 2;\n');
    git('commit', '-q', '-am', 'change the app');
    await write('src/App.tsx', 'export const App = 3;\n');
  }

  // The hook with the engine's Result reshaped, so each kind of stop can be reached on real git.
  function hookWith(shape: Shape | 'throws') {
    const h = hook();
    const runEngine = h.ports.runEngine;
    h.ports.runEngine = async (deps, loaded, opts) => {
      if (shape === 'throws') {
        throw new Error('the engine stopped');
      }
      return { ...(await runEngine(deps, loaded, opts)), ...shape };
    };
    return h;
  }

  async function stopWith(shape: Shape | 'throws', withStart: boolean, active: boolean) {
    await branch(withStart);
    const h = hookWith(shape);
    expect(await runStopHookFromStdin(JSON.stringify({ stop_hook_active: active }), h.ports)).toBe(0);
    const blocked = h.stdout().includes('"decision":"block"');
    return { blocked, text: blocked ? blockReason(h.stdout()) : h.stderr() };
  }

  const UNRECOGNIZED: Shape = { verdict: 'mystery' as unknown as Result['verdict'], exitCode: 1 };
  const REGRESSION: Shape = { verdict: 'regression', exitCode: 1, accessibilityVerdict: 'regression' };
  const FAILED: Shape = { verdict: null, exitCode: 4 };

  const kinds: Array<{ name: string; shape: Shape | 'throws'; active: boolean; blocks: boolean; step: (check: string) => string }> = [
    {
      name: 'a block on a verdict usabl does not recognize',
      shape: UNRECOGNIZED,
      active: false,
      blocks: true,
      step: (check) => `Next: run ${check} again and stop when it reports a verdict.`,
    },
    {
      name: 'an allow on a verdict usabl does not recognize, continuation active',
      shape: UNRECOGNIZED,
      active: true,
      blocks: false,
      step: (check) => `Next: run ${check} again before you tell the user this change is accessible.`,
    },
    {
      name: 'an allow on a regression, continuation active',
      shape: REGRESSION,
      active: true,
      blocks: false,
      step: (check) => `Next: fix each accessibility barrier usabl reported, then run ${check} before you tell the user`,
    },
    {
      name: 'an allow on a run that did not finish',
      shape: FAILED,
      active: false,
      blocks: false,
      step: (check) => `Next: run ${check} again, or check the change by hand, before you call this change accessible.`,
    },
    {
      name: 'an allow on a stop hook error',
      shape: 'throws',
      active: false,
      blocks: false,
      step: (check) => `Next: run ${check}, or check the change by hand, before you call this change accessible.`,
    },
  ];

  for (const kind of kinds) {
    it(`${kind.name} names usabl check --branch-scope when the stop had a starting commit`, async () => {
      const stop = await stopWith(kind.shape, true, kind.active);
      expect(stop.blocked).toBe(kind.blocks);
      expect(stop.text).toContain(kind.step('usabl check --branch-scope'));
    });

    it(`${kind.name} keeps usabl check when the stop had no starting commit`, async () => {
      const stop = await stopWith(kind.shape, false, kind.active);
      expect(stop.blocked).toBe(kind.blocks);
      expect(stop.text).toContain(kind.step('usabl check'));
      expect(stop.text).not.toContain('--branch-scope');
    });
  }

  // The receipt notice follows a verified allow. A receipt path that is a link is refused.
  for (const withStart of [true, false]) {
    const check = withStart ? 'usabl check --branch-scope' : 'usabl check';
    it(`a receipt that could not be saved says to run ${check} or stop again`, async () => {
      await branch(withStart);
      await mkdir(join(repo, '.usabl'), { recursive: true });
      await symlink(join(repo, 'README.md'), join(repo, '.usabl', 'receipt.json'));
      const h = hook();
      await runStopHookFromStdin('{}', h.ports);
      expect(h.stdout()).not.toContain('"decision":"block"');
      expect(h.stderr()).toContain('NOT saved - usabl did not save the receipt for this run');
      expect(h.stderr()).toContain(`then run ${check} or stop again.`);
      if (!withStart) {
        expect(h.stderr()).not.toContain('--branch-scope');
      }
    });
  }
});

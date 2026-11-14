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
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Deps, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { makeGitReader } from '../../src/deps/git.js';
import {
  makeStopHookRunnerPorts,
  runStopHookFromStdin,
  type StopHookRunnerPorts,
} from '../../src/surfaces/stop-hook-runner.js';
import { findStartingCommit, type ScopeGit, type ScopeGitResult } from '../../src/surfaces/stop-hook-scope.js';
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
  function expectScopeGap(h: ReturnType<typeof hook>, reason: string): string {
    const text = blockReason(h.stdout());
    expect(text.startsWith('NOT verified - not covered: usabl could not find where this branch left the trusted branch')).toBe(true);
    expect(text).toContain(reason);
    expect(text).toContain('checked nothing on this stop');
    expect(text).toContain('It did not fall back to the uncommitted changes alone or to the whole history.');
    expect(text).toContain('Next: fetch the trusted branch');
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
    const text = expectScopeGap(h, 'this clone has no commit for it');
    expect(insideFrame(text, 'trusted branch: origin/gone')).toBe(true);
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
    await expect(findStartingCommit(git)).resolves.toEqual({ kind: 'found', branch: 'origin/main', commit: COMMIT });
  });
});

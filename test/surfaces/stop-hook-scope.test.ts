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
  scopeGit,
  type ScopeGit,
  type ScopeGitOptions,
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

  // A reader can miss a note that comes after the decision, so the VERIFIED line itself says that
  // policy was not compared with a trusted branch. The note still follows with its next step.
  const WARNING = 'no trusted branch found to compare policy with; see the note below';
  // The verdict word and what its parentheses hold, up to the colon that ends them.
  const verdictParentheses = (line: string): string => line.slice(0, line.indexOf('): ') + 1);

  it('puts the warning inside the VERIFIED line of a fresh check', async () => {
    await write('src/App.tsx', 'export const App = 2;\n');
    const h = hook();
    await runStopHookFromStdin('{}', h.ports);
    expect(h.scanned).toEqual(['home']);
    const first = h.stderr().split('\n')[0] ?? '';
    expect(verdictParentheses(first)).toMatch(/^VERIFIED \(exit 0, /);
    expect(verdictParentheses(first)).toContain(WARNING);
    expect(h.stderr()).toContain(NOTE);
    expect(h.stderr()).toContain('git remote set-head origin --auto');
  });

  it('puts the warning inside the VERIFIED line of a stored receipt allow', async () => {
    await write('src/App.tsx', 'export const App = 2;\n');
    await runStopHookFromStdin('{}', hook().ports);
    const h = hook();
    await runStopHookFromStdin('{}', h.ports);
    expect(h.scanned).toEqual([]);
    const first = h.stderr().split('\n')[0] ?? '';
    expect(verdictParentheses(first)).toMatch(/^VERIFIED \(exit 0, stored receipt, not re-scanned, /);
    expect(verdictParentheses(first)).toContain(WARNING);
    expect(h.stderr()).toContain(NOTE);
  });

  // An idle stop here can follow committed UI work, so its line carries the warning too.
  it('puts the warning inside the idle line', async () => {
    git('switch', '-q', '-c', 'feature');
    await write('src/Other.tsx', 'export const Other = 2;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'change the other screen');
    const h = hook();
    await runStopHookFromStdin('{}', h.ports);
    expect(h.scanned).toEqual([]);
    const first = h.stderr().split('\n')[0] ?? '';
    expect(verdictParentheses(first)).toMatch(/^NO VERDICT: IDLE \(exit 0, /);
    expect(verdictParentheses(first)).toContain(WARNING);
    expect(h.stderr()).toContain(NOTE);
  });

  it('leaves the VERIFIED line alone when a trusted branch is recorded', async () => {
    git('update-ref', 'refs/remotes/origin/main', 'main');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    await write('src/App.tsx', 'export const App = 2;\n');
    const h = hook();
    await runStopHookFromStdin('{}', h.ports);
    expect(h.stderr()).toMatch(/^VERIFIED \(exit 0/);
    expect(h.stderr()).not.toContain(WARNING);
    expect(h.stderr()).not.toContain(NOTE);
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

// A clone made while the default branch was master. The project then made main, set usabl up
// there or not, and moved its default branch to main. A fetch brings main in but does not move
// origin/HEAD, so it still names origin/master, which has no usabl.config.json.
describe('a stale origin/HEAD after the default branch moves', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  const STALE_REASON = 'another branch of origin has one at its tip, so origin/HEAD may be stale';
  const SET_HEAD_NEXT =
    'Next: run git remote set-head origin --auto, which records the default branch of origin again, then fetch the trusted branch';

  function gitIn(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=usabl test', '-c', 'user.email=test@example.invalid', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  }

  // Leaves repo set to the clone, on a branch made from origin/main with one UI commit. The branch
  // is named `feature` unless the test names it.
  async function cloneWithStaleHead(options: { configOnMain: boolean; branch?: string }): Promise<void> {
    const work = repo;
    const root = await realpath(await mkdtemp(join(tmpdir(), 'usabl-stale-head-')));
    made.push(root);
    git('branch', '-q', '-m', 'main', 'master');
    git('rm', '-q', 'usabl.config.json');
    git('commit', '-q', '-m', 'old master, before usabl');
    gitIn(root, 'clone', '-q', '--bare', work, join(root, 'origin.git'));
    const clone = join(root, 'clone');
    gitIn(root, 'clone', '-q', join(root, 'origin.git'), clone);

    git('switch', '-q', '-c', 'main');
    await write('docs.md', 'main\n');
    if (options.configOnMain) {
      await write('usabl.config.json', CONFIG_TEXT);
    }
    git('add', '-A');
    git('commit', '-q', '-m', 'main');
    git('push', '-q', join(root, 'origin.git'), 'main');
    gitIn(join(root, 'origin.git'), 'symbolic-ref', 'HEAD', 'refs/heads/main');

    repo = clone;
    git('fetch', '-q', 'origin');
    // git's default: the new branch tracks origin/main, so its upstream is origin/main.
    git('switch', '-q', '-c', options.branch ?? 'feature', 'origin/main');
    if (!options.configOnMain) {
      await write('usabl.config.json', CONFIG_TEXT);
    }
    await write('src/App.tsx', 'export const App = 2;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'change the app');
    expect(git('symbolic-ref', 'refs/remotes/origin/HEAD').trim()).toBe('refs/remotes/origin/master');
  }

  it('does not read a configured repository as a setup branch, and names the other branch', async () => {
    await cloneWithStaleHead({ configOnMain: true });
    await expect(findStartingCommit(scopeGit(repo))).resolves.toEqual({
      kind: 'not-found',
      branch: 'origin/master',
      problem: 'trusted-branch-may-be-stale',
      detail: 'origin/main',
    });
  });

  it('blocks the stop as a gap that names git remote set-head origin --auto', async () => {
    await cloneWithStaleHead({ configOnMain: true });

    const h = hook();
    expect(await runStopHookFromStdin('{}', h.ports)).toBe(0);
    const text = blockReason(h.stdout());
    expect(text.startsWith('NOT verified - not covered: usabl could not find where this branch left the trusted branch')).toBe(true);
    expect(text).toContain(STALE_REASON);
    expect(text).toContain(SET_HEAD_NEXT);
    expect(text).not.toContain('VERIFIED');
    expect(text).not.toContain('this branch sets usabl up');
    expect(insideFrame(text, 'trusted branch: origin/master')).toBe(true);
    expect(insideFrame(text, 'branch with usabl.config.json: origin/main')).toBe(true);
    expect(h.scanned).toEqual([]);
  });

  it('checks the branch as usual once origin/HEAD is recorded again', async () => {
    await cloneWithStaleHead({ configOnMain: true });
    git('remote', 'set-head', 'origin', 'main');

    const h = hook();
    await runStopHookFromStdin('{}', h.ports);
    expect(h.scanned).toEqual(['home']);
    expect(h.stderr()).not.toContain('this branch sets usabl up');
    expect((await storedReceipt()).baseRevision).toBe(commitOf('origin/main'));
  });

  // No branch of origin has a config, so this branch is the one that sets usabl up. The other
  // branch of origin with no config changes nothing.
  it('keeps the setup path when no branch of origin has a config', async () => {
    await cloneWithStaleHead({ configOnMain: false });
    await expect(findStartingCommit(scopeGit(repo))).resolves.toMatchObject({
      kind: 'found',
      branch: 'origin/master',
      policy: 'branch-sets-usabl-up',
      configOnTrustedBranch: false,
    });

    const h = hook();
    await runStopHookFromStdin('{}', h.ports);
    expect(h.stdout()).not.toContain('"decision":"block"');
    expect(h.scanned).toEqual(['home']);
    expect(h.stderr()).toContain('Note: this branch sets usabl up.');
  });

  // Once the setup branch is pushed, its own branch of origin holds the config. That copy is
  // skipped, so the branch still reads as one that sets usabl up.
  it('keeps the setup path for a setup branch pushed to origin', async () => {
    await cloneWithStaleHead({ configOnMain: false });
    git('push', '-q', 'origin', 'feature');
    await expect(findStartingCommit(scopeGit(repo))).resolves.toMatchObject({
      kind: 'found',
      branch: 'origin/master',
      policy: 'branch-sets-usabl-up',
    });

    const h = hook();
    await runStopHookFromStdin('{}', h.ports);
    expect(h.stdout()).not.toContain('"decision":"block"');
    expect(h.scanned).toEqual(['home']);
    expect(h.stderr()).toContain('Note: this branch sets usabl up.');
  });

  // The branch of origin that is this branch's own copy is not evidence that usabl is set up
  // elsewhere: the copy with the same name, and the branch's configured upstream, are skipped.
  // main, master, trunk, and develop always count, so the common stale origin/HEAD still blocks.
  describe('the branch of origin that is this branch', () => {
    async function expectSetupPath(): Promise<void> {
      await expect(findStartingCommit(scopeGit(repo))).resolves.toMatchObject({
        kind: 'found',
        branch: 'origin/master',
        policy: 'branch-sets-usabl-up',
      });
      const h = hook();
      await runStopHookFromStdin('{}', h.ports);
      expect(h.stdout()).not.toContain('"decision":"block"');
      expect(h.scanned).toEqual(['home']);
      expect(h.stderr()).toContain('Note: this branch sets usabl up.');
    }

    async function expectStaleGap(named: string): Promise<void> {
      await expect(findStartingCommit(scopeGit(repo))).resolves.toEqual({
        kind: 'not-found',
        branch: 'origin/master',
        problem: 'trusted-branch-may-be-stale',
        detail: named,
      });
      const h = hook();
      await runStopHookFromStdin('{}', h.ports);
      expect(blockReason(h.stdout())).toContain(STALE_REASON);
      expect(h.scanned).toEqual([]);
    }

    it('takes the setup path again for a pushed setup branch with the same name on origin', async () => {
      await cloneWithStaleHead({ configOnMain: false, branch: 'feature/setup' });
      git('push', '-q', 'origin', 'feature/setup');
      expect(commitOf('origin/feature/setup')).toBe(commitOf('HEAD'));
      await expectSetupPath();
    });

    it('still blocks a local main when origin/HEAD names master and origin/main has a config', async () => {
      await cloneWithStaleHead({ configOnMain: true, branch: 'main' });
      expect(git('symbolic-ref', 'HEAD').trim()).toBe('refs/heads/main');
      await expectStaleGap('origin/main');
    });

    it('skips the upstream of a branch whose upstream has another name', async () => {
      await cloneWithStaleHead({ configOnMain: false, branch: 'work' });
      // Pushed under another name, with no upstream recorded yet: that branch of origin counts.
      git('push', '-q', 'origin', 'work:setup-usabl');
      await expectStaleGap('origin/setup-usabl');

      git('branch', '-q', '--set-upstream-to=origin/setup-usabl');
      await expectSetupPath();
    });

    it('blocks a pushed setup branch named develop, because develop always counts', async () => {
      await cloneWithStaleHead({ configOnMain: false, branch: 'develop' });
      git('push', '-q', '-u', 'origin', 'develop');
      await expectStaleGap('origin/develop');
    });

    it('skips nothing on a detached HEAD', async () => {
      await cloneWithStaleHead({ configOnMain: false, branch: 'feature/setup' });
      git('push', '-q', 'origin', 'feature/setup');
      git('switch', '-q', '--detach');
      await expect(findStartingCommit(scopeGit(repo))).resolves.toMatchObject({
        kind: 'not-found',
        problem: 'trusted-branch-may-be-stale',
        detail: 'origin/feature/setup',
      });
    });
  });

  // A partial clone leaves objects on origin until git needs them, and git then fetches them
  // over the network. The lookup reads only root trees, with lazy fetch off, so it never fetches
  // inside a stop, and an object it cannot read is a gap, never "no config".
  describe('in a partial clone', () => {
    // origin/HEAD names master (no config), and origin/main has the config. The clone was made
    // before main existed, and the branch is made from master with a config of its own in other
    // bytes, so the config blob at the tip of origin/main is not in the clone.
    async function partialCloneWithStaleHead(filter: 'blob:none' | 'tree:0'): Promise<string> {
      const work = repo;
      const root = await realpath(await mkdtemp(join(tmpdir(), 'usabl-partial-')));
      made.push(root);
      const origin = join(root, 'origin.git');
      git('branch', '-q', '-m', 'main', 'master');
      git('rm', '-q', 'usabl.config.json');
      git('commit', '-q', '-m', 'old master, before usabl');
      gitIn(root, 'clone', '-q', '--bare', work, origin);
      gitIn(origin, 'config', 'uploadpack.allowFilter', 'true');
      const clone = join(root, 'clone');
      gitIn(root, 'clone', '-q', `--filter=${filter}`, `file://${origin}`, clone);

      git('switch', '-q', '-c', 'main');
      await write('usabl.config.json', CONFIG_TEXT);
      git('add', '-A');
      git('commit', '-q', '-m', 'set usabl up on main');
      git('push', '-q', origin, 'main');
      gitIn(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');

      repo = clone;
      git('fetch', '-q', 'origin');
      git('switch', '-q', '-c', 'feature');
      await write('usabl.config.json', JSON.stringify(config) + '\n');
      await write('src/App.tsx', 'export const App = 2;\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'change the app with a config of its own');
      expect(git('symbolic-ref', 'refs/remotes/origin/HEAD').trim()).toBe('refs/remotes/origin/master');
      return origin;
    }

    // Whether the clone holds an object, asked with lazy fetch off so the question fetches nothing.
    function holdsObject(name: string): boolean {
      try {
        execFileSync('git', ['cat-file', '-e', name], { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } });
        return true;
      } catch {
        return false;
      }
    }

    const STALE_MAIN = { kind: 'not-found', branch: 'origin/master', problem: 'trusted-branch-may-be-stale', detail: 'origin/main' };

    it('reads the config at origin/main from its tree when lazy fetch is off for the whole process', async () => {
      await partialCloneWithStaleHead('blob:none');
      expect(holdsObject('origin/main:usabl.config.json')).toBe(false);
      const saved = process.env.GIT_NO_LAZY_FETCH;
      process.env.GIT_NO_LAZY_FETCH = '1';
      try {
        await expect(findStartingCommit(scopeGit(repo))).resolves.toEqual(STALE_MAIN);
      } finally {
        if (saved === undefined) delete process.env.GIT_NO_LAZY_FETCH;
        else process.env.GIT_NO_LAZY_FETCH = saved;
      }
    });

    it('answers with no network call: origin cannot be reached, and the blob is still not in the clone after', async () => {
      await partialCloneWithStaleHead('blob:none');
      git('remote', 'set-url', 'origin', 'file:///nonexistent/usabl-origin.git');
      expect(holdsObject('origin/main:usabl.config.json')).toBe(false);

      await expect(findStartingCommit(scopeGit(repo))).resolves.toEqual(STALE_MAIN);
      expect(holdsObject('origin/main:usabl.config.json')).toBe(false);

      const h = hook();
      await runStopHookFromStdin('{}', h.ports);
      expect(blockReason(h.stdout())).toContain(STALE_REASON);
      expect(h.scanned).toEqual([]);
      expect(holdsObject('origin/main:usabl.config.json')).toBe(false);
    });

    // A treeless clone lacks the root tree of origin/main too. The lookup does not fetch it, so the
    // stop is a gap, never the setup path.
    it('reads a root tree that is not in a treeless clone as a gap that names the branch, never as no config', async () => {
      await partialCloneWithStaleHead('tree:0');
      expect(holdsObject('origin/main^{tree}')).toBe(false);
      await expect(findStartingCommit(scopeGit(repo))).resolves.toEqual({
        kind: 'not-found',
        branch: 'origin/master',
        problem: 'tree-not-in-clone',
        detail: 'origin/main',
      });
      expect(holdsObject('origin/main^{tree}')).toBe(false);

      // The step the gap names loads the tree. The lookup then reads it, and the stale
      // origin/HEAD gap follows.
      git('ls-tree', 'origin/main');
      expect(holdsObject('origin/main^{tree}')).toBe(true);
      await expect(findStartingCommit(scopeGit(repo))).resolves.toEqual(STALE_MAIN);
    });

    // A treeless clone of a configured repository, behind origin: a fetch moved origin/main, and
    // its tree stayed on origin. The branch was made from the older main, whose tree is local.
    async function treelessCloneBehindOrigin(): Promise<void> {
      const work = repo;
      const root = await realpath(await mkdtemp(join(tmpdir(), 'usabl-treeless-')));
      made.push(root);
      const origin = join(root, 'origin.git');
      gitIn(root, 'clone', '-q', '--bare', work, origin);
      gitIn(origin, 'config', 'uploadpack.allowFilter', 'true');
      const clone = join(root, 'clone');
      gitIn(root, 'clone', '-q', '--filter=tree:0', `file://${origin}`, clone);

      await write('src/Other.tsx', 'export const Other = 2;\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'main moves on');
      git('push', '-q', origin, 'main');

      repo = clone;
      git('fetch', '-q', 'origin');
      git('switch', '-q', '-c', 'feature', 'main');
      await write('src/App.tsx', 'export const App = 2;\n');
      git('commit', '-q', '-am', 'change the app');
      expect(git('symbolic-ref', 'refs/remotes/origin/HEAD').trim()).toBe('refs/remotes/origin/main');
    }

    // Runs `run` with git's trace of child processes written to a file, and returns the git
    // commands it started as children, for example a lazy fetch.
    async function childCommands(run: () => Promise<unknown>): Promise<string[]> {
      const trace = join(repo, '..', `trace-${made.length}.json`);
      const saved = process.env.GIT_TRACE2_EVENT;
      process.env.GIT_TRACE2_EVENT = trace;
      try {
        await run();
      } finally {
        if (saved === undefined) delete process.env.GIT_TRACE2_EVENT;
        else process.env.GIT_TRACE2_EVENT = saved;
      }
      let text = '';
      try {
        text = await readFile(trace, 'utf8');
      } catch {
        // No git process wrote a trace.
      }
      return text
        .split('\n')
        .filter((line) => line.includes('"event":"child_start"'))
        .map((line) => (JSON.parse(line) as { argv?: string[] }).argv?.join(' ') ?? '');
    }

    // The trusted tip's tree is not local. The check of where policy is read does not fetch it:
    // it is a gap that names the branch, and loading it clears the gap.
    it('does not fetch the tree of the trusted branch, and names the step that loads it', async () => {
      await treelessCloneBehindOrigin();
      expect(holdsObject('origin/main^{tree}')).toBe(false);

      let found: unknown;
      const children = await childCommands(async () => {
        found = await findStartingCommit(scopeGit(repo));
      });
      expect(children.filter((command) => command.includes('fetch'))).toEqual([]);
      expect(found).toEqual({ kind: 'not-found', branch: 'origin/main', problem: 'tree-not-in-clone', detail: 'origin/main' });
      expect(holdsObject('origin/main^{tree}')).toBe(false);

      const h = hook();
      await runStopHookFromStdin('{}', h.ports);
      const text = blockReason(h.stdout());
      expect(text).toContain('a partial clone that does not have the tree');
      expect(text).toContain('Next: run git ls-tree');
      expect(text).not.toContain('git fetch origin');
      expect(insideFrame(text, 'tree not in this clone: origin/main')).toBe(true);
      expect(h.scanned).toEqual([]);

      git('ls-tree', 'origin/main');
      await expect(findStartingCommit(scopeGit(repo))).resolves.toMatchObject({ kind: 'found', policy: 'starting-commit' });
    });

    // A true setup repository in a treeless clone, with another branch of origin whose tree is
    // not local. The gap names that branch; once its tree is loaded, the setup path follows.
    it('names the other branch whose tree is not local, and takes the setup path once it is loaded', async () => {
      const work = repo;
      git('rm', '-q', 'usabl.config.json');
      git('commit', '-q', '-m', 'main has no usabl config yet');
      const root = await realpath(await mkdtemp(join(tmpdir(), 'usabl-treeless-')));
      made.push(root);
      const origin = join(root, 'origin.git');
      gitIn(root, 'clone', '-q', '--bare', work, origin);
      gitIn(origin, 'config', 'uploadpack.allowFilter', 'true');
      git('switch', '-q', '-c', 'docs');
      await write('docs.md', 'docs\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'docs');
      git('push', '-q', origin, 'docs');
      const clone = join(root, 'clone');
      gitIn(root, 'clone', '-q', '--filter=tree:0', `file://${origin}`, clone);
      repo = clone;
      git('switch', '-q', '-c', 'feature', 'main');
      await write('usabl.config.json', CONFIG_TEXT);
      git('add', '-A');
      git('commit', '-q', '-m', 'set usabl up');
      expect(holdsObject('origin/docs^{tree}')).toBe(false);

      await expect(findStartingCommit(scopeGit(repo))).resolves.toEqual({
        kind: 'not-found',
        branch: 'origin/main',
        problem: 'tree-not-in-clone',
        detail: 'origin/docs',
      });
      git('ls-tree', 'origin/docs');
      await expect(findStartingCommit(scopeGit(repo))).resolves.toMatchObject({ kind: 'found', policy: 'branch-sets-usabl-up' });
    });
  });

  // A branch of origin that names a file's object, not a commit, has no tree to read. The gap says
  // what it names, not that the clone lacks a tree.
  it('says a branch of origin names a blob, not a commit', async () => {
    await cloneWithStaleHead({ configOnMain: false });
    git('update-ref', 'refs/remotes/origin/odd', commitOf('HEAD:src/App.tsx'));
    const found = await findStartingCommit(scopeGit(repo));
    expect(found).toMatchObject({ kind: 'not-found', problem: 'git-failed' });
    const detail = found.kind === 'not-found' ? found.detail : null;
    expect(detail).toContain('origin/odd names a blob, not a commit');
    expect(detail).not.toContain('does not have the tree');
  });

  it('names git ls-tree, not a fetch, as the step for a tree that is not in the clone', () => {
    const text = branchScopeGapText({ kind: 'gap', problem: 'tree-not-in-clone', branch: 'origin/main', detail: 'origin/main' });
    expect(text).toContain('Next: run git ls-tree');
    expect(text).toContain('then run usabl check --branch-scope again.');
    expect(text).not.toContain('git fetch origin');
    expect(insideFrame(text, 'tree not in this clone: origin/main')).toBe(true);
  });

  // Branches of origin at the tip of origin/master, made in one git call and packed.
  function addOriginBranches(count: number): number {
    const tip = commitOf('origin/master');
    const refs = Array.from({ length: count }, (_, i) => `refs/remotes/origin/feature/branch-number-${String(i).padStart(5, '0')}`);
    execFileSync('git', ['update-ref', '--stdin'], { cwd: repo, input: refs.map((ref) => `create ${ref} ${tip}\n`).join('') });
    git('pack-refs', '--all');
    // The bytes each branch adds to the listing: the id, the name, and the three separators and
    // the end of line around the empty fields.
    return refs.reduce((sum, ref) => sum + tip.length + ref.length + 5, 0);
  }

  // 15,000 branches of origin print more than 1 MiB. That used to cut git off, and the gap said
  // "git did not run".
  it('reads a listing of 15,000 branches of origin', async () => {
    await cloneWithStaleHead({ configOnMain: false });
    expect(addOriginBranches(15_000)).toBeGreaterThan(1024 * 1024);

    await expect(findStartingCommit(scopeGit(repo))).resolves.toMatchObject({ kind: 'found', policy: 'branch-sets-usabl-up' });
  });

  it('says the answer was too large when git prints more than usabl reads', async () => {
    await cloneWithStaleHead({ configOnMain: false });
    expect(addOriginBranches(50)).toBeGreaterThan(1000);

    const found = await findStartingCommit(scopeGit(repo, { maxBytes: 1000 }));
    expect(found).toMatchObject({ kind: 'not-found', problem: 'git-failed' });
    const detail = found.kind === 'not-found' ? found.detail : null;
    expect(detail).toContain('more than 1000 bytes');
    expect(detail).not.toBe('git did not run');
  });

  it('names the other branch inside the frame in the check text too', () => {
    const text = branchScopeGapText({ kind: 'gap', problem: 'trusted-branch-may-be-stale', branch: 'origin/master', detail: 'origin/main' });
    expect(text).toContain(STALE_REASON);
    expect(text).toContain(`${SET_HEAD_NEXT}`);
    expect(text).toContain('then run usabl check --branch-scope again.');
    expect(insideFrame(text, 'branch with usabl.config.json: origin/main')).toBe(true);
    expect(text).not.toContain('error: origin/main');
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
      'ls-tree': { code: 0, stdout: 'usabl.config.json\0', stderr: '' },
    });
    await expect(findStartingCommit(git)).resolves.toEqual({
      kind: 'found',
      branch: 'origin/main',
      commit: COMMIT,
      policy: 'starting-commit',
      configOnTrustedBranch: true,
    });
  });

  // Where the config is decides where policy is read. Each commit's tree is checked first, then
  // listed for the config at the root: a name means held, no output means absent.
  type ConfigAnswer = 'held' | 'absent' | 'tree-missing' | ScopeGitResult;
  // The other branches of origin, as for-each-ref lists them, and what a batch read of their root
  // trees answers: 'held', 'absent', or 'tree-missing'. `entries` replaces the names in a root
  // tree. `listing` and `batch` replace git's answer. `heads` are the local branches: the one
  // checked out is marked current, and each may have an upstream ref.
  interface OtherBranches {
    refs?: { name: string; commit: string; answer: 'held' | 'absent' | 'tree-missing'; entries?: string[] }[];
    heads?: { name: string; current?: boolean; upstream?: string }[];
    listing?: ScopeGitResult;
    batch?: ScopeGitResult;
  }
  // A root tree as git stores it: "<mode> <name>", a NUL byte, then the 20 bytes of the entry's id.
  // The id bytes are made up, and one of them is a newline, as a real id can hold.
  const ENTRY_ID = 'abcdefghij\nlmnopqrst';
  const treeBytes = (entries: string[]) =>
    entries.map((entry) => (entry.includes(' ') ? entry : `100644 ${entry}`) + `\0${ENTRY_ID}`).join('');
  const treeAnswer = (entries: string[]) => {
    const content = treeBytes(entries);
    return `${'e'.repeat(40)} tree ${content.length}\n${content}\n`;
  };
  function withConfigAt(answers: { start: ConfigAnswer; tip: ConfigAnswer; others?: OtherBranches }): ScopeGit {
    const TIP = 'd'.repeat(40);
    const answerFor = (commit: string): ConfigAnswer => (commit === COMMIT ? answers.start : answers.tip);
    const others = answers.others ?? {};
    const refs = others.refs ?? [];
    return async (args, options) => {
      if (args[0] === 'symbolic-ref') return ok('refs/remotes/origin/main');
      if (args[0] === 'merge-base') return args[1] === '--is-ancestor' ? { code: 0, stdout: '', stderr: '' } : ok(COMMIT);
      if (args[0] === 'for-each-ref') {
        if (others.listing !== undefined) return others.listing;
        const line = (commit: string, ref: string, head = ' ', upstream = '') => `${commit}\t${ref}\t${head}\t${upstream}\n`;
        const listed = [
          line(TIP, 'refs/remotes/origin/HEAD'),
          line(TIP, 'refs/remotes/origin/main'),
          ...refs.map((ref) => line(ref.commit, `refs/remotes/origin/${ref.name}`)),
          ...(others.heads ?? []).map((head) => line(COMMIT, `refs/heads/${head.name}`, head.current === true ? '*' : ' ', head.upstream ?? '')),
        ];
        return { code: 0, stdout: listed.join(''), stderr: '' };
      }
      if (args[0] === 'cat-file' && args[1] === '--batch') {
        if (others.batch !== undefined) return others.batch;
        const lines = (options?.input ?? '').split('\n').filter((line) => line.length > 0);
        const out = lines.map((line) => {
          const ref = refs.find((candidate) => `${candidate.commit}^{tree}` === line);
          const answer = ref?.answer ?? 'absent';
          if (answer === 'tree-missing') return `${line} missing\n`;
          return treeAnswer(ref?.entries ?? (answer === 'held' ? ['README.md', 'usabl.config.json'] : ['README.md', 'src']));
        });
        return { code: 0, stdout: out.join(''), stderr: '' };
      }
      if (args[0] === 'cat-file') {
        const answer = answerFor((args.at(-1) ?? '').replace('^{tree}', ''));
        return answer === 'tree-missing' ? { code: 128, stdout: '', stderr: 'fatal: Not a valid object name' } : { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'ls-tree') {
        const answer = answerFor(args.find((arg) => /^[0-9a-f]{40}$/.test(arg)) ?? '');
        if (answer === 'held') return { code: 0, stdout: 'usabl.config.json\0', stderr: '' };
        if (answer === 'absent') return { code: 0, stdout: '', stderr: '' };
        if (answer === 'tree-missing') return { code: 128, stdout: '', stderr: 'fatal: not a tree object' };
        return answer;
      }
      return ok(TIP);
    };
  }

  it('reads policy from the branch when neither the starting commit nor the trusted branch holds a config', async () => {
    await expect(findStartingCommit(withConfigAt({ start: 'absent', tip: 'absent' }))).resolves.toMatchObject({
      kind: 'found',
      policy: 'branch-sets-usabl-up',
      configOnTrustedBranch: false,
    });
  });

  it('reads a branch older than the setup when only the trusted branch holds a config', async () => {
    await expect(findStartingCommit(withConfigAt({ start: 'absent', tip: 'held' }))).resolves.toMatchObject({
      kind: 'found',
      policy: 'branch-older-than-setup',
      configOnTrustedBranch: true,
    });
  });

  it('keeps the starting commit as the policy reference when it holds a config, and says whether the trusted branch does', async () => {
    for (const tip of ['held', 'absent'] as const) {
      await expect(findStartingCommit(withConfigAt({ start: 'held', tip }))).resolves.toMatchObject({
        kind: 'found',
        policy: 'starting-commit',
        configOnTrustedBranch: tip === 'held',
      });
    }
  });

  it('reads a config lookup that fails as a git failure, never as no config', async () => {
    await expect(findStartingCommit(withConfigAt({ start: broken, tip: 'absent' }))).resolves.toMatchObject({
      kind: 'not-found',
      problem: 'git-failed',
      detail: 'fatal: unable to read refs',
    });
    await expect(findStartingCommit(withConfigAt({ start: 'absent', tip: broken }))).resolves.toMatchObject({
      kind: 'not-found',
      problem: 'git-failed',
    });
    await expect(findStartingCommit(withConfigAt({ start: 'held', tip: broken }))).resolves.toMatchObject({
      kind: 'not-found',
      problem: 'git-failed',
    });
  });

  it('reads a missing tree as a git failure, never as no config', async () => {
    for (const answers of [
      { start: 'tree-missing', tip: 'absent' },
      { start: 'absent', tip: 'tree-missing' },
    ] as const) {
      await expect(findStartingCommit(withConfigAt(answers))).resolves.toMatchObject({
        kind: 'not-found',
        problem: 'git-failed',
      });
    }
  });

  // origin/HEAD can name an old branch after the default branch moves. A config at the tip of any
  // other branch of origin means usabl is set up in this repository, so this is not a setup branch.
  const OTHER = 'a'.repeat(40);
  const SECOND = 'b'.repeat(40);

  it('reads a config at the tip of another branch of origin as a stale origin/HEAD, never as a setup branch', async () => {
    const git = withConfigAt({ start: 'absent', tip: 'absent', others: { refs: [{ name: 'trunk', commit: OTHER, answer: 'held' }] } });
    await expect(findStartingCommit(git)).resolves.toEqual({
      kind: 'not-found',
      branch: 'origin/main',
      problem: 'trusted-branch-may-be-stale',
      detail: 'origin/trunk',
    });
  });

  it('keeps the setup path when the other branches of origin have no config', async () => {
    const git = withConfigAt({ start: 'absent', tip: 'absent', others: { refs: [{ name: 'docs', commit: OTHER, answer: 'absent' }] } });
    await expect(findStartingCommit(git)).resolves.toMatchObject({ kind: 'found', policy: 'branch-sets-usabl-up' });
  });

  it('asks git for the other branches only on the setup path, and in one batch', async () => {
    const calls: string[][] = [];
    const inner = withConfigAt({
      start: 'absent',
      tip: 'absent',
      others: {
        refs: [
          { name: 'docs', commit: OTHER, answer: 'absent' },
          { name: 'copy', commit: OTHER, answer: 'absent' },
          { name: 'wip', commit: SECOND, answer: 'absent' },
        ],
      },
    });
    let input = '';
    const lookupOptions: (ScopeGitOptions | undefined)[] = [];
    await findStartingCommit(async (args, options) => {
      calls.push([...args]);
      if (args[0] === 'for-each-ref' || args[1] === '--batch') lookupOptions.push(options);
      if (args[1] === '--batch') input = options?.input ?? '';
      return inner(args, options);
    });
    expect(calls.filter((args) => args[0] === 'for-each-ref')).toHaveLength(1);
    expect(calls.filter((args) => args[1] === '--batch')).toHaveLength(1);
    // Each commit once, the trusted branch's tip not again, and only the root tree is read.
    expect(input).toBe(`${OTHER}^{tree}\n${SECOND}^{tree}\n`);
    // Both calls run with lazy fetch off, so a partial clone never fetches inside a stop.
    expect(lookupOptions).toHaveLength(2);
    for (const options of lookupOptions) {
      expect(options?.env).toEqual({ GIT_NO_LAZY_FETCH: '1' });
    }

    for (const start of ['held', 'absent'] as const) {
      const seen: string[][] = [];
      const git = withConfigAt({ start, tip: start === 'held' ? 'absent' : 'held' });
      await findStartingCommit(async (args, options) => {
        seen.push([...args]);
        return git(args, options);
      });
      expect(seen.some((args) => args[0] === 'for-each-ref')).toBe(false);
    }
  });

  it('reads a listing or a batch lookup that fails as a git failure, never as no config', async () => {
    const answers: OtherBranches[] = [
      { listing: broken },
      { refs: [{ name: 'trunk', commit: OTHER, answer: 'absent' }], batch: broken },
      { refs: [{ name: 'trunk', commit: OTHER, answer: 'tree-missing' }] },
      // An answer that is not a tree.
      { refs: [{ name: 'trunk', commit: OTHER, answer: 'held' }], batch: ok(`${'f'.repeat(40)} blob 2`) },
      // Fewer answers than questions.
      {
        refs: [
          { name: 'trunk', commit: OTHER, answer: 'absent' },
          { name: 'wip', commit: SECOND, answer: 'absent' },
        ],
        batch: { code: 0, stdout: treeAnswer(['README.md']), stderr: '' },
      },
      // A tree whose size is longer than what git printed.
      { refs: [{ name: 'trunk', commit: OTHER, answer: 'absent' }], batch: ok(`${'e'.repeat(40)} tree 999\n100644 a\0`) },
      // A tree entry cut short.
      {
        refs: [{ name: 'trunk', commit: OTHER, answer: 'absent' }],
        batch: { code: 0, stdout: `${'e'.repeat(40)} tree 10\n100644 abc\n`, stderr: '' },
      },
      // A listing line that is not a commit id and a ref name.
      { listing: ok('not-a-commit refs/remotes/origin/trunk') },
      // Two branches checked out here: the upstream field comes from config, and a newline in it
      // can add a forged line.
      {
        listing: ok(
          `${OTHER}\trefs/heads/feature\t*\trefs/remotes/origin/x\n${OTHER}\trefs/heads/zz\t*\trefs/remotes/origin/release\n${OTHER}\trefs/remotes/origin/release\t \t`,
        ),
      },
    ];
    for (const others of answers) {
      await expect(findStartingCommit(withConfigAt({ start: 'absent', tip: 'absent', others }))).resolves.toMatchObject({
        kind: 'not-found',
        problem: 'git-failed',
      });
    }
  });

  it('names only a plain branch name, and the first in order when several hold a config', async () => {
    const several = withConfigAt({
      start: 'absent',
      tip: 'absent',
      others: {
        refs: [
          { name: 'zeta', commit: OTHER, answer: 'held' },
          { name: 'alpha', commit: SECOND, answer: 'held' },
        ],
      },
    });
    await expect(findStartingCommit(several)).resolves.toMatchObject({ problem: 'trusted-branch-may-be-stale', detail: 'origin/alpha' });

    const strange = withConfigAt({
      start: 'absent',
      tip: 'absent',
      others: { refs: [{ name: 'we"ird$(x)', commit: OTHER, answer: 'held' }] },
    });
    await expect(findStartingCommit(strange)).resolves.toEqual({
      kind: 'not-found',
      branch: 'origin/main',
      problem: 'trusted-branch-may-be-stale',
      detail: null,
    });
  });

  // This branch's own copy on origin is skipped: the same name, and the configured upstream.
  // main, master, trunk, and develop always count. With no current branch nothing is skipped.
  const setupPath = { kind: 'found', policy: 'branch-sets-usabl-up' };
  const staleGap = (name: string) => ({ kind: 'not-found', problem: 'trusted-branch-may-be-stale', detail: `origin/${name}` });
  const pushed = (name: string, heads: NonNullable<OtherBranches['heads']>) =>
    withConfigAt({ start: 'absent', tip: 'absent', others: { refs: [{ name, commit: OTHER, answer: 'held' }], heads } });

  it('skips the branch of origin with the name of the current branch', async () => {
    await expect(findStartingCommit(pushed('setup', [{ name: 'setup', current: true }]))).resolves.toMatchObject(setupPath);
    // The same name on a branch that is not checked out is not skipped.
    await expect(findStartingCommit(pushed('setup', [{ name: 'setup' }, { name: 'other', current: true }]))).resolves.toMatchObject(staleGap('setup'));
  });

  it('skips the upstream of the current branch, and only an upstream on origin', async () => {
    await expect(
      findStartingCommit(pushed('setup-usabl', [{ name: 'work', current: true, upstream: 'refs/remotes/origin/setup-usabl' }])),
    ).resolves.toMatchObject(setupPath);
    await expect(
      findStartingCommit(pushed('setup-usabl', [{ name: 'work', current: true, upstream: 'refs/remotes/fork/setup-usabl' }])),
    ).resolves.toMatchObject(staleGap('setup-usabl'));
    await expect(
      findStartingCommit(pushed('setup-usabl', [{ name: 'work', upstream: 'refs/remotes/origin/setup-usabl' }, { name: 'x', current: true }])),
    ).resolves.toMatchObject(staleGap('setup-usabl'));
  });

  it('never skips main, master, trunk, or develop', async () => {
    for (const name of ['main', 'master', 'trunk', 'develop']) {
      const sameName = withConfigAt({
        start: 'absent',
        tip: 'absent',
        // origin/main is the trusted branch in this fake, so a held main is listed as a second ref.
        others: { refs: [{ name, commit: OTHER, answer: 'held' }], heads: [{ name, current: true, upstream: `refs/remotes/origin/${name}` }] },
      });
      await expect(findStartingCommit(sameName)).resolves.toMatchObject(staleGap(name));
      const asUpstream = pushed(name, [{ name: 'work', current: true, upstream: `refs/remotes/origin/${name}` }]);
      await expect(findStartingCommit(asUpstream)).resolves.toMatchObject(staleGap(name));
    }
  });

  it('skips nothing on a detached HEAD', async () => {
    await expect(findStartingCommit(pushed('setup', [{ name: 'setup' }]))).resolves.toMatchObject(staleGap('setup'));
  });

  it('reads the config from the root tree entry names, never from a name that only starts the same', async () => {
    const answer = (entries: string[]) =>
      findStartingCommit(withConfigAt({ start: 'absent', tip: 'absent', others: { refs: [{ name: 'trunk', commit: OTHER, answer: 'absent', entries }] } }));
    await expect(answer(['usabl.config.json.bak', 'a-usabl.config.json'])).resolves.toMatchObject(setupPath);
    // A folder or a link at the path counts as held, as in the lookup of the trusted branch.
    await expect(answer(['40000 usabl.config.json'])).resolves.toMatchObject(staleGap('trunk'));
    await expect(answer(['120000 usabl.config.json'])).resolves.toMatchObject(staleGap('trunk'));
  });

  it('reads a local branch line it cannot parse as a git failure', async () => {
    for (const stdout of [`${OTHER}\trefs/heads/x\t?\t\n`, `${OTHER}\trefs/heads/x\t*\tnot-a-ref\n`, `${OTHER}\trefs/heads/x\t*\n`]) {
      const git = withConfigAt({ start: 'absent', tip: 'absent', others: { listing: { code: 0, stdout, stderr: '' } } });
      await expect(findStartingCommit(git)).resolves.toMatchObject({ kind: 'not-found', problem: 'git-failed' });
    }
  });
});

// The same lookups on real git: a tree object deleted from the repository is a git failure, and
// the config is found at the root wherever git runs.
describe('findStartingCommit on real git', () => {
  async function deleteTreeOf(commit: string): Promise<void> {
    const tree = git('rev-parse', `${commit}^{tree}`).trim();
    await rm(join(repo, '.git', 'objects', tree.slice(0, 2), tree.slice(2)));
  }

  it('reads a deleted tree object at the starting commit as a git failure', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('src/App.tsx', 'export const App = 2;\n');
    git('commit', '-q', '-am', 'change the app');
    await deleteTreeOf('main');

    await expect(findStartingCommit(scopeGit(repo))).resolves.toMatchObject({ kind: 'not-found', problem: 'git-failed' });
  });

  it('finds the config at the root from a subfolder', async () => {
    recordTrustedBranch();
    await mkdir(join(repo, 'src', 'deep'), { recursive: true });
    await expect(findStartingCommit(scopeGit(join(repo, 'src', 'deep')))).resolves.toMatchObject({
      kind: 'found',
      policy: 'starting-commit',
      configOnTrustedBranch: true,
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

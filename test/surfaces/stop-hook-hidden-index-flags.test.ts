/**
 * An edit to a tracked file marked assume-unchanged or skip-worktree is a change on every surface
 * that lists changes: the Stop hook with and without a trusted branch, `usabl check`, and
 * `usabl check --branch-scope`. git status and git diff hide such an edit, so a stop whose only
 * edit was such a file read "nothing to check".
 *
 * Real git in a temporary folder, the real CLI and hook, and the fake browser the Stop hook tests
 * use: buildDeps is replaced so no browser starts, and the check runner records what it scanned.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Deps, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { makeGitReader } from '../../src/deps/git.js';
import { REAL_PROCESS_BUDGET_MS } from '../support/timing.js';

const state = vi.hoisted(() => ({ scanned: [] as string[] }));

vi.mock('../../src/deps/build.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/deps/build.js')>();
  return {
    ...original,
    buildDeps: async (_config: UsablConfig, options: { cwd?: string } = {}): Promise<Deps> => {
      const cwd = options.cwd ?? process.cwd();
      const fake = makeFakeDeps();
      return {
        ...fake,
        git: makeGitReader({ cwd }),
        fs: makeFsGlob({ cwd }),
        checkRunner: {
          scan: async (screen) => {
            state.scanned.push(screen.id);
            return fake.checkRunner.scan(screen);
          },
        },
      };
    },
  };
});

const { main } = await import('../../src/cli.js');
const { makeStopHookRunnerPorts, runStopHookFromStdin } = await import('../../src/surfaces/stop-hook-runner.js');
const { memoryPinStore } = await import('../support/memory-pin-store.js');

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'src/routes.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'home', url: 'http://127.0.0.1:5173/', files: ['src/App.tsx'] }],
  guardedPaths: [],
};

const NOTHING_TO_CHECK = 'nothing to check';

let repo = '';
let originalCwd = '';

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

/**
 * A committed app on a feature branch with no commits of its own. With `trustedBranch`, origin/HEAD
 * names the commit the branch starts from. The only edit is to src/App.tsx, hidden by `flag`.
 */
async function setUp(flag: '--assume-unchanged' | '--skip-worktree', trustedBranch: boolean): Promise<void> {
  git('init', '-q', '-b', 'main');
  await write('.gitignore', '.usabl/\n');
  await write('usabl.config.json', JSON.stringify(config, null, 2) + '\n');
  await write('src/App.tsx', 'export const App = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  if (trustedBranch) {
    git('update-ref', 'refs/remotes/origin/main', 'main');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  }
  git('switch', '-q', '-c', 'feature');
  git('update-index', flag, 'src/App.tsx');
  await write('src/App.tsx', 'export const App = () => <div onClick={() => 1}>Save</div>;\n');
  // git itself shows nothing.
  expect(git('status', '--porcelain')).toBe('');
}

async function stop(): Promise<{ stderr: string; scanned: string[] }> {
  const out: string[] = [];
  state.scanned = [];
  const ports = {
    ...makeStopHookRunnerPorts({ startDir: repo, env: {} }),
    pins: memoryPinStore(),
    stdoutWrite: async () => {},
    stderrWrite: async (text: string) => {
      out.push(text);
    },
  };
  await runStopHookFromStdin('{}', ports);
  return { stderr: out.join(''), scanned: [...state.scanned] };
}

let printed: string[] = [];

async function check(args: string[]): Promise<{ text: string; scanned: string[] }> {
  printed = [];
  state.scanned = [];
  await main(['check', ...args]);
  return { text: printed.join(''), scanned: [...state.scanned] };
}

beforeEach(async () => {
  originalCwd = process.cwd();
  repo = await realpath(await mkdtemp(join(tmpdir(), 'usabl-hidden-flags-stop-')));
  process.chdir(repo);
  const capture = ((chunk: string | Uint8Array) => {
    printed.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  vi.spyOn(process.stderr, 'write').mockImplementation(capture);
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  await rm(repo, { recursive: true, force: true });
});

describe('an edit hidden by an index flag', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  for (const flag of ['--assume-unchanged', '--skip-worktree'] as const) {
    it(`is checked by a stop with a trusted branch (${flag})`, async () => {
      await setUp(flag, true);
      const result = await stop();
      expect(result.stderr).not.toContain(NOTHING_TO_CHECK);
      expect(result.scanned).toEqual(['home']);
    });

    it(`is checked by a stop with no trusted branch (${flag})`, async () => {
      await setUp(flag, false);
      const result = await stop();
      expect(result.stderr).not.toContain(NOTHING_TO_CHECK);
      expect(result.scanned).toEqual(['home']);
    });

    it(`is checked by usabl check (${flag})`, async () => {
      await setUp(flag, true);
      const result = await check([]);
      expect(result.text).not.toContain(NOTHING_TO_CHECK);
      expect(result.scanned).toEqual(['home']);
    });

    it(`is checked by usabl check --branch-scope (${flag})`, async () => {
      await setUp(flag, true);
      const result = await check(['--branch-scope']);
      expect(result.text).not.toContain(NOTHING_TO_CHECK);
      expect(result.scanned).toEqual(['home']);
    });

    it(`is checked by usabl check with a trusted ref (${flag})`, async () => {
      await setUp(flag, true);
      const result = await check(['--trusted-ref', 'main']);
      expect(result.text).not.toContain(NOTHING_TO_CHECK);
      expect(result.scanned).toEqual(['home']);
    });
  }
});

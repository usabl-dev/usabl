/**
 * `usabl check --branch-scope` runs the check a Stop hook runs: every change since the branch left
 * the trusted branch, plus uncommitted changes, with the same starting commit bound into the
 * receipt. It is the way to finish a check a stop could not finish, so the next stop of the same
 * tree answers from its receipt.
 *
 * Real git in a temporary folder, the real CLI and hook, and the fake browser the Stop hook tests
 * use: buildDeps is replaced so no browser starts, and the check runner records what it scanned.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
  surfaces: [
    { id: 'home', url: 'http://127.0.0.1:5173/', files: ['src/App.tsx'] },
    { id: 'other', url: 'http://127.0.0.1:5173/other', files: ['src/Other.tsx'] },
  ],
  guardedPaths: [],
};

let repo = '';
let originalCwd = '';
let stdout: string[] = [];
let stderr: string[] = [];

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

function recordTrustedBranch(target = 'refs/remotes/origin/main'): void {
  git('update-ref', 'refs/remotes/origin/main', 'main');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', target);
}

async function storedBase(): Promise<unknown> {
  return (JSON.parse(await readFile(join(repo, '.usabl', 'receipt.json'), 'utf8')) as { baseRevision: unknown }).baseRevision;
}

async function check(...args: string[]): Promise<{ code: number; stdout: string; stderr: string; scanned: string[] }> {
  stdout = [];
  stderr = [];
  state.scanned = [];
  const code = await main(['check', ...args]);
  return { code, stdout: stdout.join(''), stderr: stderr.join(''), scanned: [...state.scanned] };
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

beforeEach(async () => {
  originalCwd = process.cwd();
  repo = await realpath(await mkdtemp(join(tmpdir(), 'usabl-branch-scope-')));
  git('init', '-q', '-b', 'main');
  await write('.gitignore', '.usabl/\n');
  await write('usabl.config.json', JSON.stringify(config, null, 2) + '\n');
  await write('src/App.tsx', 'export const App = 1;\n');
  await write('src/Other.tsx', 'export const Other = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  process.chdir(repo);
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  await rm(repo, { recursive: true, force: true });
});

describe('usabl check --branch-scope', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  it('checks the committed work of the branch and leaves a receipt the next stop answers from', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('src/App.tsx', 'export const App = 2;\n');
    git('commit', '-q', '-am', 'change the app');

    const ran = await check('--branch-scope');
    expect(ran.code).toBe(0);
    expect(ran.scanned).toEqual(['home']);
    expect(await storedBase()).toBe(git('rev-parse', 'main').trim());

    const next = await stop();
    expect(next.scanned).toEqual([]);
    expect(next.stderr.startsWith('VERIFIED (exit 0, stored receipt, not re-scanned')).toBe(true);
  });

  it('leaves a receipt that a stop does not use after one more commit or one more UI edit', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('src/App.tsx', 'export const App = 2;\n');
    git('commit', '-q', '-am', 'change the app');
    expect((await check('--branch-scope')).code).toBe(0);

    await write('src/Other.tsx', 'export const Other = 2;\n');
    git('commit', '-q', '-am', 'change the other screen');
    const afterCommit = await stop();
    expect(afterCommit.stderr).not.toContain('not re-scanned');
    expect([...afterCommit.scanned].sort()).toEqual(['home', 'other']);

    expect((await check('--branch-scope')).code).toBe(0);
    await write('src/App.tsx', 'export const App = 3;\n');
    const afterEdit = await stop();
    expect(afterEdit.stderr).not.toContain('not re-scanned');
    expect([...afterEdit.scanned].sort()).toEqual(['home', 'other']);
  });

  // The rule the starting commit binding set: a plain check covered fewer files, so its receipt
  // does not answer a stop that has a starting commit.
  it('a receipt from a plain usabl check still does not answer such a stop', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('src/Other.tsx', 'export const Other = 2;\n');
    git('commit', '-q', '-am', 'change the other screen');
    await write('src/App.tsx', 'export const App = 2;\n');

    const plain = await check();
    expect(plain.code).toBe(0);
    expect(plain.scanned).toEqual(['home']);
    expect(await storedBase()).toBeNull();

    const next = await stop();
    expect(next.stderr).not.toContain('not re-scanned');
    expect([...next.scanned].sort()).toEqual(['home', 'other']);
  });

  it('checks the uncommitted changes and prints the Stop hook note when there is no trusted branch', async () => {
    git('switch', '-q', '-c', 'feature');
    await write('src/Other.tsx', 'export const Other = 2;\n');
    git('commit', '-q', '-am', 'change the other screen');
    await write('src/App.tsx', 'export const App = 2;\n');

    const ran = await check('--branch-scope');
    expect(ran.code).toBe(0);
    expect(ran.scanned).toEqual(['home']);
    expect(ran.stderr).toContain(
      'Note: usabl found no trusted branch to compare this branch with, because git records no default branch for origin',
    );
    expect(ran.stderr).toContain('git remote set-head origin --auto');
    expect(await storedBase()).toBeNull();
  });

  it('scans nothing and exits 4 when the starting commit cannot be found', async () => {
    recordTrustedBranch('refs/remotes/origin/gone');
    git('switch', '-q', '-c', 'feature');
    await write('src/App.tsx', 'export const App = 2;\n');
    git('commit', '-q', '-am', 'change the app');

    const ran = await check('--branch-scope');
    expect(ran.code).toBe(4);
    expect(ran.scanned).toEqual([]);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toContain('usabl could not find where this branch left the trusted branch');
    expect(ran.stderr).toContain('this clone has no commit for it');
    expect(ran.stderr).toContain('It did not fall back to the uncommitted changes alone or to the whole history.');
    await expect(readFile(join(repo, '.usabl', 'receipt.json'), 'utf8')).rejects.toThrow();
  });

  for (const [extra, flag] of [
    [['--ci', '--trusted-ref', 'origin/main'], '--ci'],
    [['--trusted-ref', 'origin/main'], '--trusted-ref'],
    [['--isolated-browser'], '--isolated-browser'],
  ] as const) {
    it(`refuses --branch-scope with ${flag} and says which one to drop`, async () => {
      const ran = await check('--branch-scope', ...extra);
      expect(ran.code).toBe(2);
      expect(ran.scanned).toEqual([]);
      expect(ran.stderr).toContain(`--branch-scope cannot be combined with ${flag}`);
      expect(ran.stderr).toContain(`Drop ${flag}`);
    });
  }

  // The hook reads usabl.config.json at the root, so a receipt from a check planned with another
  // config file would answer a stop it does not match.
  it('refuses --config with another file, says to drop it, and saves no receipt', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('src/App.tsx', 'export const App = 2;\n');
    git('commit', '-q', '-am', 'change the app');
    const weak = join(repo, '..', `${repo.split('/').at(-1) ?? 'repo'}-weak.json`);
    await writeFile(weak, JSON.stringify({ ...config, uiFileGlobs: ['src/Other.tsx'] }, null, 2) + '\n');
    try {
      const ran = await check('--branch-scope', '--config', `../${weak.split('/').at(-1) ?? ''}`);
      expect(ran.code).toBe(2);
      expect(ran.scanned).toEqual([]);
      expect(ran.stderr).toContain('--branch-scope cannot be combined with --config');
      expect(ran.stderr).toContain('Drop --config');
      await expect(readFile(join(repo, '.usabl', 'receipt.json'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(weak, { force: true });
    }
  });

  for (const path of ['usabl.config.json', './usabl.config.json']) {
    it(`still runs with --config ${path}, the root config`, async () => {
      recordTrustedBranch();
      git('switch', '-q', '-c', 'feature');
      await write('src/App.tsx', 'export const App = 2;\n');
      git('commit', '-q', '-am', 'change the app');
      const ran = await check('--branch-scope', '--config', path);
      expect(ran.code).toBe(0);
      expect(ran.scanned).toEqual(['home']);
      expect(await storedBase()).toBe(git('rev-parse', 'main').trim());
    });
  }

  it('is refused on a command other than check', async () => {
    stderr = [];
    const code = await main(['brief', '--branch-scope']);
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('--branch-scope');
  });
});

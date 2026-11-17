/**
 * A stored receipt binds the files the app reads that git does not see: every `.env*` file in the
 * repository root and in each app folder, every path the config lists in `localFiles`, and the
 * bytes of `usabl.config.json`. An edit to any of them after a verified stop makes the next stop
 * check again instead of answering from the receipt. A path that cannot be read never matches.
 *
 * Real git in a temporary folder, the real CLI and hook, and the fake browser the Stop hook tests
 * use: buildDeps is replaced so no browser starts, and the check runner records what it scanned.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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

const FAST_PATH = 'VERIFIED (exit 0, stored receipt, not re-scanned';
const SECRET = 'SECRETPOISON';

let repo = '';
let outside = '';
let originalCwd = '';
let printed: string[] = [];

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

/** A repository on a feature branch with one committed UI change and the given config. */
async function setUp(extra: Partial<UsablConfig> = {}, ignored: string[] = []): Promise<void> {
  git('init', '-q', '-b', 'main');
  await write('.gitignore', ['.usabl/', '.env*', ...ignored].join('\n') + '\n');
  await write('usabl.config.json', JSON.stringify({ ...config, ...extra }, null, 2) + '\n');
  await write('src/App.tsx', 'export const App = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('update-ref', 'refs/remotes/origin/main', 'main');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git('switch', '-q', '-c', 'feature');
  await write('src/App.tsx', 'export const App = 2;\n');
  git('commit', '-q', '-am', 'change the app');
}

async function check(): Promise<number> {
  state.scanned = [];
  return main(['check', '--branch-scope']);
}

async function stop(): Promise<{ stderr: string; scanned: string[] }> {
  const out: string[] = [];
  state.scanned = [];
  const ports = {
    ...makeStopHookRunnerPorts({ startDir: repo, env: {} }),
    pins: memoryPinStore(),
    stdoutWrite: async (text: string) => {
      printed.push(text);
    },
    stderrWrite: async (text: string) => {
      out.push(text);
      printed.push(text);
    },
  };
  await runStopHookFromStdin('{}', ports);
  return { stderr: out.join(''), scanned: [...state.scanned] };
}

beforeEach(async () => {
  originalCwd = process.cwd();
  printed = [];
  repo = await realpath(await mkdtemp(join(tmpdir(), 'usabl-local-files-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'usabl-local-files-outside-')));
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
  await rm(outside, { recursive: true, force: true });
});

describe('the stored receipt and files git does not see', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  it('still answers from the receipt when there is no .env file at all', async () => {
    await setUp();
    expect(await check()).toBe(0);
    const first = await stop();
    expect(first.stderr.startsWith(FAST_PATH)).toBe(true);
    const second = await stop();
    expect(second.stderr.startsWith(FAST_PATH)).toBe(true);
    expect(second.scanned).toEqual([]);
  });

  it('checks again after an edit to an ignored .env file', async () => {
    await setUp();
    await write('.env.local', 'VITE_API=/one\n');
    expect(await check()).toBe(0);
    expect((await stop()).stderr.startsWith(FAST_PATH)).toBe(true);

    // git sees no change: the file is ignored, so the tree and the status stay the same.
    await write('.env.local', 'VITE_API=/two\n');
    expect(git('status', '--porcelain')).toBe('');
    const next = await stop();
    expect(next.stderr).not.toContain('not re-scanned');
    expect(next.scanned).toEqual(['home']);
  });

  it('checks again when a .env file appears', async () => {
    await setUp();
    expect(await check()).toBe(0);
    expect((await stop()).stderr.startsWith(FAST_PATH)).toBe(true);

    await write('.env.production', 'VITE_API=/prod\n');
    const next = await stop();
    expect(next.stderr).not.toContain('not re-scanned');
    expect(next.scanned).toEqual(['home']);
  });

  it('checks again after an edit to an ignored file the config lists', async () => {
    await setUp({ localFiles: ['public/generated.js'] }, ['public/generated.js']);
    await write('public/generated.js', 'window.theme = "light";\n');
    expect(await check()).toBe(0);
    expect((await stop()).stderr.startsWith(FAST_PATH)).toBe(true);

    await write('public/generated.js', 'window.theme = "dark";\n');
    expect(git('status', '--porcelain')).toBe('');
    const next = await stop();
    expect(next.stderr).not.toContain('not re-scanned');
    expect(next.scanned).toEqual(['home']);
  });

  it('never answers from the receipt while a .env file is a link out of the repository', async () => {
    await setUp();
    await writeFile(join(outside, 'shared.env'), 'VITE_API=/one\n');
    await symlink(join(outside, 'shared.env'), join(repo, '.env'));
    expect(await check()).toBe(0);

    // Nothing changed, but usabl cannot read the link as a file of this repository.
    const next = await stop();
    expect(next.stderr).not.toContain('not re-scanned');
    expect(next.scanned).toEqual(['home']);
  });

  it('never answers from the receipt while a listed path is a folder', async () => {
    await setUp({ localFiles: ['public/generated'] }, ['public/generated/']);
    await write('public/generated/theme.js', 'window.theme = "light";\n');
    expect(await check()).toBe(0);

    const next = await stop();
    expect(next.stderr).not.toContain('not re-scanned');
    expect(next.scanned).toEqual(['home']);
  });

  it('never prints or stores what a bound file holds', async () => {
    await setUp({ localFiles: ['public/generated.js'] }, ['public/generated.js']);
    await write('.env.local', `token=${SECRET}\n`);
    await write('public/generated.js', `window.token = "${SECRET}";\n`);
    expect(await check()).toBe(0);
    await stop();
    await write('.env.local', `token=${SECRET}2\n`);
    await stop();

    const receipt = await readFile(join(repo, '.usabl', 'receipt.json'), 'utf8');
    expect(receipt).not.toContain(SECRET);
    expect(receipt).not.toContain('token');
    expect(receipt).not.toContain('.env');
    expect(printed.join('')).not.toContain(SECRET);
  });
});

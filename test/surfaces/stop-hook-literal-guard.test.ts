/**
 * After a verified stop, a new untracked file in the requirements folder is a guarded change at
 * the next stop, whatever characters the folder's name holds. Node's glob has no escape, so a
 * folder named `reqs[1]` put into a pattern lists `reqs1`, and a name past the glob reading bound
 * lists nothing: the stop then answered from the stored receipt. An honest stop with such a name
 * and no change still answers from the receipt.
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

const posixOnly = process.platform === 'win32' ? it.skip : it;

// One approved requirement, so the requirements folder loads.
const REQUIREMENT = [
  'version: 1',
  'requirements:',
  '  - id: other-heading',
  '    kind: content',
  '    surface: other',
  '    description: other heading',
  '    assertion:',
  '      type: content',
  '      selector: h1',
  '      expectedText: Other',
  '    approved: true',
  '',
].join('\n');

const FAST_PATH = 'stored receipt, not re-scanned';
const NOTHING_TO_CHECK = 'nothing to check';

let repo = '';
let home = '';
let originalCwd = '';
// What the CLI printed, so a check that does not pass says why.
const printed: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

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

function configFor(requirements: string): UsablConfig {
  return {
    appBaseUrl: 'http://127.0.0.1:5173',
    uiFileGlobs: ['src/**'],
    discovery: { routerFile: 'src/routes.tsx', wideBlastGlobs: [] },
    surfaces: [
      { id: 'home', url: 'http://127.0.0.1:5173/', files: ['src/App.tsx'] },
      { id: 'other', url: 'http://127.0.0.1:5173/other', files: ['src/Other.tsx'] },
    ],
    guardedPaths: [],
    requirements,
  };
}

/**
 * A feature branch whose one commit changes src/Other.tsx, so a check has a screen to verify and
 * mints a receipt. The requirements folder holds one committed file.
 */
async function setUp(requirements: string): Promise<void> {
  git('init', '-q', '-b', 'main');
  await write('.gitignore', '.usabl/\n');
  await write('usabl.config.json', JSON.stringify(configFor(requirements), null, 2) + '\n');
  await write('src/App.tsx', 'export const App = 1;\n');
  await write('src/Other.tsx', 'export const Other = 1;\n');
  await write(`${requirements}/old.yaml`, REQUIREMENT);
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('update-ref', 'refs/remotes/origin/main', 'main');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git('switch', '-q', '-c', 'feature');
  await write('src/Other.tsx', 'export const Other = 2;\n');
  git('commit', '-q', '-am', 'change the other screen');
}

async function stop(input = '{}', pins = memoryPinStore()): Promise<{ stdout: string; stderr: string; scanned: string[] }> {
  const out: string[] = [];
  const decision: string[] = [];
  state.scanned = [];
  const ports = {
    ...makeStopHookRunnerPorts({ startDir: repo, env: {} }),
    pins,
    stdoutWrite: async (text: string) => {
      decision.push(text);
    },
    stderrWrite: async (text: string) => {
      out.push(text);
    },
  };
  await runStopHookFromStdin(input, ports);
  return { stdout: decision.join(''), stderr: out.join(''), scanned: [...state.scanned] };
}

function blockOf(stdout: string): { decision?: string; reason?: string } {
  return stdout.trim() === '' ? {} : (JSON.parse(stdout) as { decision?: string; reason?: string });
}

/** The verified stop the route starts from: it answers from the receipt the check minted. */
async function verifiedStop(): Promise<void> {
  state.scanned = [];
  printed.length = 0;
  expect(await main(['check', '--branch-scope']), printed.join('')).toBe(0);
  const first = await stop();
  expect(first.stderr).toContain(FAST_PATH);
}

beforeEach(async () => {
  originalCwd = process.cwd();
  home = await realpath(await mkdtemp(join(tmpdir(), 'usabl-literal-stop-home-')));
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) {
    savedEnv[key] = process.env[key];
  }
  await writeFile(join(home, '.gitconfig'), '[core]\n\thooksPath = /dev/null\n');
  process.env['HOME'] = home;
  process.env['XDG_CONFIG_HOME'] = join(home, '.config');
  delete process.env['GIT_CONFIG_GLOBAL'];
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  repo = await realpath(await mkdtemp(join(tmpdir(), 'usabl-literal-stop-')));
  process.chdir(repo);
  const capture = ((text: string | Uint8Array) => {
    printed.push(String(text));
    return true;
  }) as typeof process.stdout.write;
  vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  vi.spyOn(process.stderr, 'write').mockImplementation(capture);
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await rm(repo, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

// A class, a brace group, an extglob group, and a name past the glob reading bound.
const NAMES = ['reqs[1]', 'reqs{a,b}', 'reqs+(x)', 're[q]*s*x'];

describe('a new untracked file in a requirements folder named with glob syntax', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  for (const name of NAMES) {
    posixOnly(`blocks the next stop as a guarded change for ${name}`, async () => {
      await setUp(name);
      await verifiedStop();
      await write(`${name}/new.txt`, 'notes\n');
      const next = await stop();
      expect(next.stderr).not.toContain(FAST_PATH);
      expect(next.stderr).not.toContain(NOTHING_TO_CHECK);
      expect(next.stderr).not.toMatch(/^VERIFIED/mu);
      const block = blockOf(next.stdout);
      expect(block.decision).toBe('block');
      expect(block.reason).toContain(`${name}/new.txt`);
    });
  }

  posixOnly('blocks a later stop of the session as drift for a new file in reqs[1]', async () => {
    const pins = memoryPinStore();
    await setUp('reqs[1]');
    printed.length = 0;
    expect(await main(['check', '--branch-scope']), printed.join('')).toBe(0);
    const first = await stop('{"session_id":"s1"}', pins);
    expect(first.stderr).toContain(FAST_PATH);
    await write('reqs[1]/.hidden/new.txt', 'notes\n');
    const next = await stop('{"session_id":"s1"}', pins);
    expect(next.stderr).not.toContain(FAST_PATH);
    expect(next.stderr).not.toMatch(/^VERIFIED/mu);
    const block = blockOf(next.stdout);
    expect(block.decision).toBe('block');
    expect(block.reason).toContain('reqs[1]/.hidden/new.txt');
  });
});

describe('an honest repository with a requirements folder named with glob syntax', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  posixOnly('answers the next stop from the receipt when nothing changed', async () => {
    await setUp('reqs[1]');
    await verifiedStop();
    const next = await stop();
    expect(next.stderr).toContain(FAST_PATH);
    expect(blockOf(next.stdout).decision).toBeUndefined();
  });

  posixOnly('verifies a stop with a new file in a folder whose name differs only in case', async () => {
    await setUp('reqs[1]');
    await verifiedStop();
    await write('Reqs[1]/new.txt', 'notes\n');
    const next = await stop();
    expect(next.stderr).toMatch(/^VERIFIED/mu);
    expect(blockOf(next.stdout).decision).toBeUndefined();
  });
});

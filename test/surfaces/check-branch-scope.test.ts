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
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Deps, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { makeGitReader } from '../../src/deps/git.js';
import { REAL_PROCESS_BUDGET_MS } from '../support/timing.js';

// What the fake check runner records, and the drafts it reports for each screen id.
// onBuild runs once, inside the next buildDeps, where a real check launches the browser. It stands
// in for a second process that writes while the check runs.
const state = vi.hoisted(() => ({
  scanned: [] as string[],
  drafts: {} as Record<string, unknown[]>,
  onBuild: null as null | (() => Promise<void>),
}));

vi.mock('../../src/deps/build.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/deps/build.js')>();
  return {
    ...original,
    buildDeps: async (_config: UsablConfig, options: { cwd?: string } = {}): Promise<Deps> => {
      const cwd = options.cwd ?? process.cwd();
      if (state.onBuild !== null) {
        const onBuild = state.onBuild;
        state.onBuild = null;
        await onBuild();
      }
      const fake = makeFakeDeps();
      return {
        ...fake,
        git: makeGitReader({ cwd }),
        fs: makeFsGlob({ cwd }),
        checkRunner: {
          scan: async (screen) => {
            state.scanned.push(screen.id);
            const scanned = await fake.checkRunner.scan(screen);
            return { ...scanned, drafts: (state.drafts[screen.id] ?? []) as typeof scanned.drafts };
          },
        },
      };
    },
  };
});

const { main } = await import('../../src/cli.js');
const { makeStopHookRunnerPorts, runStopHookFromStdin } = await import('../../src/surfaces/stop-hook-runner.js');
const { memoryPinStore } = await import('../support/memory-pin-store.js');
const { NO_TRUSTED_BRANCH_WARNING } = await import('../../src/surfaces/stop-hook.js');

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

type RealPorts = ReturnType<typeof makeStopHookRunnerPorts>;
type ConfigBytesRead = Awaited<ReturnType<RealPorts['readConfigBytes']>>;

// overrides.readConfigBytes wraps the real read, so a test can change what one read returns.
async function stop(
  input = '{}',
  pins: ReturnType<typeof memoryPinStore> = memoryPinStore(),
  overrides: { readConfigBytes?: (real: () => Promise<ConfigBytesRead>) => Promise<ConfigBytesRead> } = {},
): Promise<{ stderr: string; stdout: string; scanned: string[] }> {
  const out: string[] = [];
  const said: string[] = [];
  state.scanned = [];
  const real = makeStopHookRunnerPorts({ startDir: repo, env: {} });
  const wrap = overrides.readConfigBytes;
  const ports = {
    ...real,
    ...(wrap === undefined ? {} : { readConfigBytes: () => wrap(() => real.readConfigBytes()) }),
    pins,
    stdoutWrite: async (text: string) => {
      said.push(text);
    },
    stderrWrite: async (text: string) => {
      out.push(text);
    },
  };
  await runStopHookFromStdin(input, ports);
  return { stderr: out.join(''), stdout: said.join(''), scanned: [...state.scanned] };
}

// The block a stop sent, or null when it let the stop through.
function blockReason(stopped: { stdout: string }): string | null {
  for (const line of stopped.stdout.split('\n')) {
    if (line.trim().length === 0) continue;
    const parsed = JSON.parse(line) as { decision?: string; reason?: string };
    if (parsed.decision === 'block') {
      return parsed.reason ?? '';
    }
  }
  return null;
}

beforeEach(async () => {
  state.drafts = {};
  state.onBuild = null;
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

  // A commit that only records changes already checked leaves the tree and the starting commit as
  // they were, and the set of changes is the same, so the receipt still answers the stop.
  it('leaves a receipt the stop still answers from after a commit of the changes it checked', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('src/App.tsx', 'export const App = 2;\n');
    git('commit', '-q', '-am', 'change the app');
    await write('src/Other.tsx', 'export const Other = 2;\n');
    const ran = await check('--branch-scope');
    expect(ran.code).toBe(0);
    expect([...ran.scanned].sort()).toEqual(['home', 'other']);

    git('commit', '-q', '-am', 'record the other screen');
    const next = await stop();
    expect(next.scanned).toEqual([]);
    expect(next.stderr.startsWith('VERIFIED (exit 0, stored receipt, not re-scanned')).toBe(true);
  });

  it('leaves a receipt that a stop does not use after a commit of new content or one more UI edit', async () => {
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

  // From a subfolder, the root config is named by a path that climbs out of that folder. It is
  // the root file, so the check runs at the repository root as the Stop hook does: it reads the
  // same guarded files and leaves its receipt where the next stop looks.
  it('runs from a subfolder with --config naming the root config by its relative path', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('src/App.tsx', 'export const App = 2;\n');
    git('commit', '-q', '-am', 'change the app');
    process.chdir(join(repo, 'src'));
    const ran = await check('--branch-scope', '--config', '../usabl.config.json');
    expect(ran.stderr).not.toContain('--branch-scope cannot be combined with --config');
    expect(ran.code).toBe(0);
    expect(ran.scanned).toEqual(['home']);
    expect(await storedBase()).toBe(git('rev-parse', 'main').trim());
    const stopped = await stop();
    expect(stopped.scanned).toEqual([]);
    expect(blockReason(stopped)).toBeNull();
  });

  it('still refuses from a subfolder a --config file outside the repository', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('src/App.tsx', 'export const App = 2;\n');
    git('commit', '-q', '-am', 'change the app');
    const weak = join(repo, '..', `${repo.split('/').at(-1) ?? 'repo'}-weak.json`);
    await writeFile(weak, JSON.stringify({ ...config, uiFileGlobs: ['src/Other.tsx'] }, null, 2) + '\n');
    try {
      process.chdir(join(repo, 'src'));
      const ran = await check('--branch-scope', '--config', `../../${weak.split('/').at(-1) ?? ''}`);
      expect(ran.code).toBe(2);
      expect(ran.scanned).toEqual([]);
      expect(ran.stderr).toContain('--branch-scope cannot be combined with --config');
    } finally {
      await rm(weak, { force: true });
    }
  });

  // Without --config, a check from a subfolder would read a usabl.config.json in that folder,
  // which is not the file the Stop hook reads.
  it('refuses from a subfolder without --config and says to run from the project root', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('src/usabl.config.json', JSON.stringify({ ...config, uiFileGlobs: ['src/Other.tsx'] }, null, 2) + '\n');
    await write('src/App.tsx', 'export const App = 2;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'change the app');
    process.chdir(join(repo, 'src'));
    const ran = await check('--branch-scope');
    expect(ran.code).toBe(2);
    expect(ran.scanned).toEqual([]);
    expect(ran.stderr).toContain('run it from the project root');
  });

  it('is refused on a command other than check', async () => {
    stderr = [];
    const code = await main(['brief', '--branch-scope']);
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('--branch-scope');
  });
});

// A barrier on the home screen, as the fake check runner reports it.
const homeBarrier = {
  rule: 'color-contrast',
  layer: 'axe',
  severity: 'serious',
  evidenceClass: 'deterministic',
  screenId: 'home',
  elementPath: 'button',
  elementName: 'Save',
  role: 'button',
  whatUserExperiences: 'Save is hard to read',
  why: 'contrast too low',
  fix: 'Increase contrast',
  evidence: { name: { value: 'Save', source: 'ax-tree', fromTree: true } },
  confidence: 'fail',
};

// Live at the fake clock (2026-01-01), so a run that reads it waives the barrier.
const homeWaiver = {
  rule: 'color-contrast',
  surface: 'home',
  scope: '*',
  reason: 'tracked',
  owner: 'team',
  approvedBy: 'owner',
  created: '2025-12-01T00:00:00.000Z',
  expires: '2026-06-01T00:00:00.000Z',
};

// The policy a stop with a starting commit reads is the policy at that commit, as CI reads the
// policy at the pull request's base. A guarded file that differs from it, committed on the branch
// or not, needs approval, so the stop and the check say NOT verified and name the file.
describe('policy changed on the branch since the starting commit', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  function expectApprovalBlock(stopped: { stdout: string; stderr: string }, file: string): void {
    const reason = blockReason(stopped);
    expect(reason).not.toBeNull();
    expect(reason).toContain('NOT verified');
    expect(reason).toContain('APPROVAL REQUIRED');
    expect(reason).toContain(`guarded files: ${file}`);
    expect(reason).toContain('code owner');
    expect(reason).toContain('A guarded file committed on this branch still counts as changed');
    expect(stopped.stderr).not.toContain('VERIFIED (exit 0');
  }

  async function expectApprovalCheck(file: string): Promise<void> {
    const ran = await check('--branch-scope');
    expect(ran.code).toBe(2);
    expect(ran.stdout).toContain(file);
    expect(ran.stdout).not.toContain('then commit them');
    expect(ran.stdout).toContain('with the commit where this');
    expect(ran.stdout).toContain('branch left the trusted branch');
    expect(ran.stdout).toContain('code owner');
    await expect(readFile(join(repo, '.usabl', 'receipt.json'), 'utf8')).rejects.toThrow();
  }

  it('a waiver committed before the first stop is not taken as policy', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    state.drafts = { home: [homeBarrier] };
    await write('src/App.tsx', 'export const App = 2;\n');
    await write('.usabl-waivers.json', JSON.stringify({ version: 1, waivers: [homeWaiver] }, null, 2) + '\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'change the app and waive its barrier');

    const stopped = await stop();
    expect(stopped.scanned).toEqual(['home']);
    expectApprovalBlock(stopped, '.usabl-waivers.json');
    // The waiver is read at the starting commit, where it does not exist, so the barrier counts.
    expect(blockReason(stopped)).toContain('color-contrast');
    await expectApprovalCheck('.usabl-waivers.json');
  });

  it('a floor entry committed before the first stop is not taken as policy', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    state.drafts = { home: [homeBarrier] };
    await write('src/App.tsx', 'export const App = 2;\n');
    git('commit', '-q', '-am', 'change the app');
    expect(await main(['baseline'])).toBe(0);
    git('add', '-A');
    git('commit', '-q', '-m', 'accept the barrier in the floor');
    expect(git('show', '--name-only', '--format=', 'HEAD').trim()).toBe('.usabl-evidence.json');

    const stopped = await stop();
    expect(stopped.scanned).toEqual(['home']);
    expectApprovalBlock(stopped, '.usabl-evidence.json');
    expect(blockReason(stopped)).toContain('color-contrast');
    await expectApprovalCheck('.usabl-evidence.json');
  });

  it('a narrower uiFileGlobs committed before the first stop does not read as nothing to check', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('src/App.tsx', 'export const App = 2;\n');
    await write('usabl.config.json', JSON.stringify({ ...config, uiFileGlobs: ['src/Other.tsx'] }, null, 2) + '\n');
    git('commit', '-q', '-am', 'change the app and narrow the UI globs');

    const stopped = await stop();
    // The scan plans from the config at the starting commit, so the changed screen is checked.
    expect(stopped.scanned).toEqual(['home']);
    expectApprovalBlock(stopped, 'usabl.config.json');
    expect(stopped.stderr).not.toContain('NO VERDICT: IDLE');
    await expectApprovalCheck('usabl.config.json');
  });

  it('a routes edit committed before the first stop is not taken as policy', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('src/App.tsx', 'export const App = 2;\n');
    await write('usabl.routes.json', JSON.stringify({ routes: [] }, null, 2) + '\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'change the app and the routes');

    const stopped = await stop();
    expect(stopped.scanned).toEqual(['home']);
    expectApprovalBlock(stopped, 'usabl.routes.json');
    await expectApprovalCheck('usabl.routes.json');
  });

  it('a waiver already on the trusted branch is policy, and the stop verifies', async () => {
    state.drafts = { home: [homeBarrier] };
    await write('.usabl-waivers.json', JSON.stringify({ version: 1, waivers: [homeWaiver] }, null, 2) + '\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'waive the barrier on main');
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('src/App.tsx', 'export const App = 2;\n');
    git('commit', '-q', '-am', 'change the app');

    const stopped = await stop();
    expect(stopped.scanned).toEqual(['home']);
    expect(blockReason(stopped)).toBeNull();
    expect(stopped.stderr.startsWith('VERIFIED')).toBe(true);
    const ran = await check('--branch-scope');
    expect(ran.code).toBe(0);
    expect(await storedBase()).toBe(git('rev-parse', 'main').trim());
  });

  // A branch that sets usabl up has no trusted policy to compare with, so the stop reads the
  // branch's own policy and says so on the verdict line. CI still asks a code owner to approve it.
  it('a branch that sets usabl up is scanned with its own policy, and the verdict line says so', async () => {
    git('rm', '-q', 'usabl.config.json');
    git('commit', '-q', '-m', 'main has no usabl config yet');
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('usabl.config.json', JSON.stringify(config, null, 2) + '\n');
    await write('src/App.tsx', 'export const App = 2;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'set usabl up');

    const stopped = await stop(JSON.stringify({ session_id: 'session-one' }));
    expect(blockReason(stopped)).toBeNull();
    expect(stopped.scanned).toEqual(['home']);
    expect(stopped.stderr.startsWith('VERIFIED (exit 0, policy from this branch, not approved yet)')).toBe(true);
    expect(stopped.stderr).toContain('Note: this branch sets usabl up.');
  });

  it('a waiver changed only in the working tree is still reported', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    state.drafts = { home: [homeBarrier] };
    await write('src/App.tsx', 'export const App = 2;\n');
    git('commit', '-q', '-am', 'change the app');
    await write('.usabl-waivers.json', JSON.stringify({ version: 1, waivers: [homeWaiver] }, null, 2) + '\n');

    const stopped = await stop();
    expectApprovalBlock(stopped, '.usabl-waivers.json');
    await expectApprovalCheck('.usabl-waivers.json');
  });

  // With no trusted branch there is no starting commit, so policy is read from the working tree
  // and compared with the last commit, as before. A committed waiver is then policy.
  it('keeps the last commit as the policy reference when there is no trusted branch', async () => {
    git('switch', '-q', '-c', 'feature');
    state.drafts = { home: [homeBarrier] };
    await write('.usabl-waivers.json', JSON.stringify({ version: 1, waivers: [homeWaiver] }, null, 2) + '\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'waive the barrier');
    await write('src/App.tsx', 'export const App = 2;\n');

    const stopped = await stop();
    expect(stopped.scanned).toEqual(['home']);
    expect(blockReason(stopped)).toBeNull();
    expect(stopped.stderr.startsWith('VERIFIED')).toBe(true);
    expect(stopped.stderr).toContain('Note: usabl found no trusted branch to compare this branch with');
  });
});

// The receipt binds the bytes of usabl.config.json at the root, the file the Stop hook plans
// from, and not the bytes of the config the check planned with. So a check planned with any other
// config must leave no receipt a stop could answer from, or the stop would trust a scan of other
// screens.
describe('a check planned with another config leaves no receipt a stop can use', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  // A config that maps the changed file to the other screen, so a check planned with it never
  // scans home, where the barrier is.
  const elsewhere = {
    ...config,
    surfaces: [
      { id: 'home', url: 'http://127.0.0.1:5173/', files: ['src/Other.tsx'] },
      { id: 'other', url: 'http://127.0.0.1:5173/other', files: ['src/App.tsx'] },
    ],
  };
  let outside = '';

  beforeEach(async () => {
    outside = await realpath(await mkdtemp(join(tmpdir(), 'usabl-outside-config-')));
    await mkdir(join(outside, 'sub'));
    await writeFile(join(outside, 'usabl.config.json'), JSON.stringify(elsewhere, null, 2) + '\n');
    // x/../usabl.config.json names the root file on paper, and the outside file once x is followed.
    await symlink(join(outside, 'sub'), join(repo, 'x'));
    state.drafts = { home: [homeBarrier] };
  });

  afterEach(async () => {
    await rm(outside, { recursive: true, force: true });
  });

  async function expectStopChecksHome(): Promise<void> {
    const next = await stop();
    expect(next.scanned).toEqual(['home']);
    expect(next.stderr).not.toContain('not re-scanned');
    expect(blockReason(next)).not.toBeNull();
  }

  for (const [where, path] of [
    ['the project root', 'x/../usabl.config.json'],
    ['a subfolder', '../x/../usabl.config.json'],
  ] as const) {
    it(`refuses --branch-scope with --config ${path} from ${where}, when x links outside the repository`, async () => {
      recordTrustedBranch();
      git('switch', '-q', '-c', 'feature');
      await write('src/App.tsx', 'export const App = 2;\n');
      git('commit', '-q', '-am', 'change the app');
      if (where === 'a subfolder') process.chdir(join(repo, 'src'));

      const ran = await check('--branch-scope', '--config', path);
      expect(ran.code).toBe(2);
      expect(ran.scanned).toEqual([]);
      expect(ran.stderr).toContain('--branch-scope cannot be combined with --config');
      await expect(readFile(join(repo, '.usabl', 'receipt.json'), 'utf8')).rejects.toThrow();
      await expectStopChecksHome();
    });
  }

  // With no trusted branch a stop has no starting commit, and a plain check's receipt records
  // none either, so before this rule such a receipt answered the stop.
  for (const path of ['other.json', 'x/../usabl.config.json']) {
    it(`saves no receipt from a plain check with --config ${path}, so the next stop checks home`, async () => {
      await writeFile(join(repo, 'other.json'), JSON.stringify(elsewhere, null, 2) + '\n');
      await write('src/App.tsx', 'export const App = 2;\n');

      const ran = await check('--config', path);
      expect(ran.code).toBe(0);
      expect(ran.scanned).toEqual(['other']);
      expect(ran.stderr).toContain('usabl: saved no receipt for this run');
      await expect(readFile(join(repo, '.usabl', 'receipt.json'), 'utf8')).rejects.toThrow();
      await expectStopChecksHome();
    });
  }

  it('still saves a receipt the stop answers from when the check reads the root config', async () => {
    state.drafts = {};
    await write('src/App.tsx', 'export const App = 2;\n');

    for (const args of [[], ['--config', 'usabl.config.json'], ['--config', join(repo, 'usabl.config.json')]]) {
      await rm(join(repo, '.usabl'), { recursive: true, force: true });
      const ran = await check(...args);
      expect(ran.code, args.join(' ')).toBe(0);
      expect(ran.scanned).toEqual(['home']);
      expect(ran.stderr).not.toContain('saved no receipt');
      const next = await stop();
      expect(next.scanned, args.join(' ')).toEqual([]);
      expect(next.stderr).toContain('not re-scanned');
    }
  });
});

// The check reads the config before it builds deps, and the run binds the root config's bytes into
// the receipt when it starts. A second process that puts the committed config back in between
// makes the check plan from weak bytes and mint a receipt bound to the committed bytes. The tree is
// then clean, so the next stop would answer from that receipt.
describe('a config swapped while usabl checks leaves no receipt', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  const committedText = JSON.stringify(config, null, 2) + '\n';
  const weakText =
    JSON.stringify(
      {
        ...config,
        surfaces: [
          { id: 'home', url: 'http://127.0.0.1:5173/', files: ['src/Other.tsx'] },
          { id: 'other', url: 'http://127.0.0.1:5173/other', files: ['src/App.tsx'] },
        ],
      },
      null,
      2,
    ) + '\n';

  async function expectSwapLeavesNoReceipt(args: string[]): Promise<void> {
    state.drafts = { home: [homeBarrier] };
    await writeFile(join(repo, 'usabl.config.json'), weakText);
    state.onBuild = async () => {
      await writeFile(join(repo, 'usabl.config.json'), committedText);
    };

    const ran = await check(...args);
    expect(ran.scanned).toEqual(['other']);
    expect(ran.stderr).toContain('usabl: saved no receipt for this run');
    expect(ran.stderr).toContain('usabl.config.json at the repository root changed while usabl was checking');
    await expect(readFile(join(repo, '.usabl', 'receipt.json'), 'utf8')).rejects.toThrow();
    expect(git('status', '--porcelain', '--', 'usabl.config.json')).toBe('');

    const next = await stop();
    expect(next.scanned).toEqual(['home']);
    expect(next.stderr).not.toContain('not re-scanned');
    expect(blockReason(next)).not.toBeNull();
  }

  it('on a --branch-scope check with a trusted branch', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('src/App.tsx', 'export const App = 2;\n');
    git('commit', '-q', '-am', 'change the app');
    await expectSwapLeavesNoReceipt(['--branch-scope']);
  });

  it('on a plain check with no trusted branch', async () => {
    await write('src/App.tsx', 'export const App = 2;\n');
    await expectSwapLeavesNoReceipt([]);
  });

  it('still saves a receipt when nothing changes the config during the check', async () => {
    state.drafts = {};
    await write('src/App.tsx', 'export const App = 2;\n');
    state.onBuild = async () => {
      await writeFile(join(repo, 'usabl.config.json'), committedText);
    };
    const ran = await check();
    expect(ran.code).toBe(0);
    expect(ran.stderr).not.toContain('saved no receipt');
    const next = await stop();
    expect(next.scanned).toEqual([]);
    expect(next.stderr).toContain('not re-scanned');
  });

  // The receipt binds the bytes on disk. A byte that is not valid UTF-8 reads as a replacement
  // character, so a check that compared or hashed the decoded text saw a changed config on every run.
  // The byte is a Latin-1 e with an acute accent, inside a uiFileGlobs string, which the parser takes.
  function configWithLatin1Byte(): Buffer {
    const text = JSON.stringify({ ...config, uiFileGlobs: ['src/**', 'docs-@@/**'] }, null, 2) + '\n';
    const [before = '', after = ''] = text.split('@@');
    return Buffer.concat([Buffer.from(before, 'utf8'), Buffer.from([0xe9]), Buffer.from(after, 'utf8')]);
  }

  it('saves a receipt for a stable config with a byte that is not valid UTF-8, and the next stop uses it', async () => {
    await writeFile(join(repo, 'usabl.config.json'), configWithLatin1Byte());
    git('commit', '-q', '-am', 'a config with a Latin-1 byte');
    expect((await readFile(join(repo, 'usabl.config.json'))).includes(0xe9)).toBe(true);
    state.drafts = {};
    await write('src/App.tsx', 'export const App = 2;\n');

    const ran = await check();
    expect(ran.code).toBe(0);
    expect(ran.scanned).toEqual(['home']);
    expect(ran.stderr).not.toContain('saved no receipt');
    await expect(readFile(join(repo, '.usabl', 'receipt.json'), 'utf8')).resolves.toContain('localFilesHash');
    const next = await stop();
    expect(next.scanned).toEqual([]);
    expect(next.stderr).toContain('not re-scanned');
  });

  // The Stop hook binds the same bytes, so its own receipt answers the next stop too.
  it('lets a stop save a receipt for such a config, and the next stop answers from it', async () => {
    await writeFile(join(repo, 'usabl.config.json'), configWithLatin1Byte());
    git('commit', '-q', '-am', 'a config with a Latin-1 byte');
    state.drafts = {};
    await write('src/App.tsx', 'export const App = 2;\n');

    const first = await stop();
    expect(first.scanned).toEqual(['home']);
    expect(first.stderr).not.toContain('saved no receipt');
    const next = await stop();
    expect(next.scanned).toEqual([]);
    expect(next.stderr).toContain('not re-scanned');
  });

  // The stop plans from the bytes it read and compared with the last commit. It reads the file once
  // more before it saves its receipt, and saves none when the file holds other bytes by then.
  it('a stop whose config changes while it checks saves no receipt, and the next stop checks again', async () => {
    state.drafts = {};
    await write('src/App.tsx', 'export const App = 2;\n');
    let reads = 0;
    const first = await stop('{}', memoryPinStore(), {
      readConfigBytes: async (real) => {
        reads += 1;
        const bytes = await real();
        return reads === 1 || bytes.working.status !== 'found' ? bytes : { ...bytes, working: { status: 'found', text: weakText } };
      },
    });
    expect(reads).toBe(2);
    expect(first.scanned).toEqual(['home']);
    expect(first.stderr).toContain('saved no receipt for this run');
    expect(first.stderr).toContain('usabl.config.json at the repository root changed while usabl was checking');
    await expect(readFile(join(repo, '.usabl', 'receipt.json'), 'utf8')).rejects.toThrow();

    const next = await stop();
    expect(next.scanned).toEqual(['home']);
    expect(next.stderr).not.toContain('not re-scanned');
  });
});

// What the verdict line of a stop or a check carries when the policy came from the branch.
const SETUP_VERDICT = 'policy from this branch, not approved yet';
const SETUP_NOTE = 'Note: this branch sets usabl up.';
const OLD_BRANCH = 'usabl is set up on the trusted branch but not on this branch';
const OLD_BRANCH_NEXT = 'Next: update this branch from the trusted branch (merge it or rebase onto it), then';
const REMOVED = 'this branch removes usabl.config.json';
const UPDATE_AFTER_DROP =
  'The trusted branch has no usabl.config.json either. If usabl was removed there, update this branch from the trusted branch (merge it or rebase onto it), then stop again.';

function stopInput(options: { active?: boolean; session?: string } = {}): string {
  return JSON.stringify({
    stop_hook_active: options.active === true,
    ...(options.session === undefined ? {} : { session_id: options.session }),
  });
}

// A stop with a session id, so the session pins are compared and the verdict line carries no
// note about them. The tests below use it as their stop.
function stopInSession(
  input = stopInput({ session: 'session-one' }),
  pins: ReturnType<typeof memoryPinStore> = memoryPinStore(),
): ReturnType<typeof stop> {
  return stop(input, pins);
}

// main with no usabl config, recorded as the trusted branch, and a branch that sets usabl up.
async function setUpOnBranch(): Promise<void> {
  git('rm', '-q', 'usabl.config.json');
  git('commit', '-q', '-m', 'main has no usabl config yet');
  recordTrustedBranch();
  git('switch', '-q', '-c', 'feature');
  await write('usabl.config.json', JSON.stringify(config, null, 2) + '\n');
  await write('src/App.tsx', 'export const App = 2;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'set usabl up');
}

// A branch made before usabl was set up on main. main sets usabl up after the branch left it.
async function branchOlderThanSetup(options: { ownConfig: boolean }): Promise<void> {
  git('rm', '-q', 'usabl.config.json');
  git('commit', '-q', '-m', 'main has no usabl config yet');
  git('switch', '-q', '-c', 'feature');
  await write('src/App.tsx', 'export const App = 2;\n');
  if (options.ownConfig) {
    await write('usabl.config.json', JSON.stringify(config, null, 2) + '\n');
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'change the app');
  git('switch', '-q', 'main');
  await write('usabl.config.json', JSON.stringify(config, null, 2) + '\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'set usabl up on main');
  recordTrustedBranch();
  git('switch', '-q', 'feature');
}

async function hasReceipt(): Promise<boolean> {
  try {
    await readFile(join(repo, '.usabl', 'receipt.json'), 'utf8');
    return true;
  } catch {
    return false;
  }
}

describe('a branch that sets usabl up', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  const stop = stopInSession;

  it('is scanned at every stop, and the verdict line and a note say the policy is not approved yet', async () => {
    await setUpOnBranch();

    const stopped = await stop();
    expect(blockReason(stopped)).toBeNull();
    expect(stopped.scanned).toEqual(['home']);
    expect(stopped.stderr.startsWith(`VERIFIED (exit 0, ${SETUP_VERDICT}): the gate verified this change.`)).toBe(true);
    expect(stopped.stderr).toContain(SETUP_NOTE);
    expect(stopped.stderr).toContain('a code owner must approve it');
    expect(stopped.stderr).not.toContain('APPROVAL REQUIRED');
    // An allow with a note is shown to the person, so the note is never only on stderr.
    expect(stopped.stdout).toContain(SETUP_VERDICT);
    expect(await storedBase()).toBe(git('rev-parse', 'main').trim());

    // The next stop answers from the stored receipt, and its line carries the same words.
    const next = await stop();
    expect(next.scanned).toEqual([]);
    expect(next.stderr.startsWith(`VERIFIED (exit 0, stored receipt, not re-scanned, ${SETUP_VERDICT})`)).toBe(true);
    expect(next.stderr).toContain(SETUP_NOTE);
  });

  it('reads a barrier on the changed screen as a regression, not as approval required', async () => {
    await setUpOnBranch();
    state.drafts = { home: [homeBarrier] };

    const stopped = await stop();
    const reason = blockReason(stopped);
    expect(reason).not.toBeNull();
    expect(reason).toContain('REGRESSION');
    expect(reason).not.toContain('APPROVAL REQUIRED');
    expect(stopped.stderr).toContain(SETUP_NOTE);
  });

  it('is checked the same way by usabl check --branch-scope', async () => {
    await setUpOnBranch();

    const ran = await check('--branch-scope');
    expect(ran.code).toBe(0);
    expect(ran.scanned).toEqual(['home']);
    expect(ran.stdout.split('\n')[0]).toContain(`VERIFIED (exit 0, ${SETUP_VERDICT})`);
    expect(ran.stderr).toContain(SETUP_NOTE);
    expect(await storedBase()).toBe(git('rev-parse', 'main').trim());
  });

  // Before the first commit of the config, the guard compares the working tree with the last
  // commit, as it does with no trusted branch, so the new config waits for approval.
  it('holds a config that is not committed yet for approval, as before', async () => {
    git('rm', '-q', 'usabl.config.json');
    git('commit', '-q', '-m', 'main has no usabl config yet');
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('usabl.config.json', JSON.stringify(config, null, 2) + '\n');
    await write('src/App.tsx', 'export const App = 2;\n');

    const stopped = await stop();
    const reason = blockReason(stopped);
    expect(reason).toContain('APPROVAL REQUIRED');
    expect(reason).toContain('guarded files: usabl.config.json');
    expect(stopped.stderr).toContain(SETUP_NOTE);
  });

  it('a branch with a config at the starting commit has no setup note', async () => {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('src/App.tsx', 'export const App = 2;\n');
    git('commit', '-q', '-am', 'change the app');

    const stopped = await stop();
    expect(stopped.stderr.startsWith('VERIFIED (exit 0): the gate verified this change.')).toBe(true);
    expect(stopped.stderr).not.toContain(SETUP_VERDICT);
    expect(stopped.stderr).not.toContain(SETUP_NOTE);
    const ran = await check('--branch-scope');
    expect(ran.code).toBe(0);
    expect(ran.stdout).not.toContain(SETUP_VERDICT);
    expect(ran.stderr).not.toContain(SETUP_NOTE);
  });
});

describe('a branch made before usabl was set up on the trusted branch', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  const stop = stopInSession;

  for (const ownConfig of [false, true]) {
    const label = ownConfig ? 'with a config of its own' : 'with no config';
    it(`blocks once ${label}, then lets the continuation through with the same notice`, async () => {
      await branchOlderThanSetup({ ownConfig });

      const stopped = await stop();
      const reason = blockReason(stopped);
      expect(reason).not.toBeNull();
      expect(reason?.startsWith('NOT verified')).toBe(true);
      expect(reason).toContain(OLD_BRANCH);
      expect(reason).toContain(`${OLD_BRANCH_NEXT} stop again.`);
      expect(stopped.scanned).toEqual([]);
      expect(stopped.stderr).not.toContain('usabl is not configured here');

      const again = await stop(stopInput({ active: true }));
      expect(blockReason(again)).toBeNull();
      expect(again.stderr.startsWith('NOT verified')).toBe(true);
      expect(again.stderr).toContain(OLD_BRANCH);
      expect(again.stderr).toContain('continuation already active');
      expect(again.scanned).toEqual([]);
    });
  }

  it('usabl check --branch-scope checks nothing and exits 4', async () => {
    await branchOlderThanSetup({ ownConfig: true });

    const ran = await check('--branch-scope');
    expect(ran.code).toBe(4);
    expect(ran.scanned).toEqual([]);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toContain(OLD_BRANCH);
    expect(ran.stderr).toContain(`${OLD_BRANCH_NEXT} run usabl check --branch-scope again.`);
    expect(await hasReceipt()).toBe(false);
  });

  it('is checked as usual once the branch is updated from the trusted branch', async () => {
    await branchOlderThanSetup({ ownConfig: false });
    git('merge', '-q', '--no-edit', 'main');

    const stopped = await stop();
    expect(blockReason(stopped)).toBeNull();
    expect(stopped.scanned).toEqual(['home']);
    expect(stopped.stderr.startsWith('VERIFIED (exit 0): the gate verified this change.')).toBe(true);
  });

  // A receipt from a stop on a setup branch binds the starting commit, which has no config. When
  // the trusted branch gains one later, that receipt must not answer: the branch is now older than
  // the setup.
  it('a receipt from before the trusted branch was set up does not answer the stop', async () => {
    await setUpOnBranch();
    expect((await stop()).stderr.startsWith(`VERIFIED (exit 0, ${SETUP_VERDICT})`)).toBe(true);
    git('switch', '-q', 'main');
    await write('usabl.config.json', JSON.stringify(config, null, 2) + '\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'set usabl up on main');
    git('update-ref', 'refs/remotes/origin/main', 'main');
    git('switch', '-q', 'feature');

    const stopped = await stop();
    expect(blockReason(stopped)).toContain(OLD_BRANCH);
    expect(stopped.stderr).not.toContain('stored receipt');
  });
});

// A config at the starting commit that is gone from the working tree and the last commit is a
// policy change, as CI reads it, never a repository that does not use usabl.
describe('a config removed on the branch', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  const stop = stopInSession;

  async function removeOnBranch(): Promise<void> {
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    git('rm', '-q', 'usabl.config.json');
    await write('src/App.tsx', 'export const App = 2;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'remove usabl');
  }

  it('reads approval required at the first stop of a session, with a plain next step', async () => {
    await removeOnBranch();

    const stopped = await stop(stopInput({ session: 'session-one' }));
    const reason = blockReason(stopped);
    expect(reason).not.toBeNull();
    expect(reason?.startsWith('NOT verified - approval required')).toBe(true);
    expect(reason).toContain(REMOVED);
    expect(reason).toContain('restore usabl.config.json as it is at that commit');
    expect(reason).toContain('code owner');
    expect(stopped.stderr).not.toContain('usabl is not configured here');
    expect(stopped.scanned).toEqual([]);

    const again = await stop(stopInput({ session: 'session-one', active: true }));
    expect(blockReason(again)).toBeNull();
    expect(again.stderr).toContain(REMOVED);
    expect(again.stderr).toContain('continuation already active');
  });

  it('reads approval required in a new session, and with no session id', async () => {
    await removeOnBranch();
    for (const input of [stopInput({ session: 'session-two' }), stopInput()]) {
      const stopped = await stop(input);
      expect(blockReason(stopped)).toContain(REMOVED);
      expect(stopped.stderr).not.toContain('usabl is not configured here');
    }
  });

  it('does not suggest an update from the trusted branch while the trusted branch still has a config', async () => {
    await removeOnBranch();
    expect(blockReason(await stop())).not.toContain(UPDATE_AFTER_DROP);
  });

  // The trusted branch dropped usabl too, so updating the branch from it clears the block.
  it('also suggests the update when the trusted branch removed its config too', async () => {
    git('switch', '-q', '-c', 'feature');
    git('rm', '-q', 'usabl.config.json');
    git('commit', '-q', '-m', 'remove usabl on the branch');
    git('switch', '-q', 'main');
    git('rm', '-q', 'usabl.config.json');
    git('commit', '-q', '-m', 'remove usabl on main');
    recordTrustedBranch();
    git('switch', '-q', 'feature');

    const reason = blockReason(await stop());
    expect(reason?.startsWith('NOT verified - approval required')).toBe(true);
    expect(reason).toContain(REMOVED);
    expect(reason).toContain(UPDATE_AFTER_DROP);
  });

  // A tree object the starting commit needs is gone, so git cannot say whether it holds a config.
  // That is never read as plain "not configured".
  it('says it could not tell when the starting commit tree cannot be read', async () => {
    await removeOnBranch();
    const tree = git('rev-parse', 'main^{tree}').trim();
    await rm(join(repo, '.git', 'objects', tree.slice(0, 2), tree.slice(2)));

    const stopped = await stop();
    expect(blockReason(stopped)).toBeNull();
    expect(stopped.stderr).toContain('usabl is not configured here');
    expect(stopped.stderr).toContain('could not tell whether the trusted branch has a usabl.config.json');
  });
});

// A session started in a parent folder that is not a repository sets CLAUDE_PROJECT_DIR there.
// The hook then checks the repository it runs in, which follows the assistant, so every decision
// says which repository it checked.
describe('a project folder outside any repository', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  const OWN_REPOSITORY_VERDICT = 'checked the repository the assistant stopped in';
  const OWN_REPOSITORY_NOTE = 'Note: the project folder (CLAUDE_PROJECT_DIR) is outside any git repository';
  // These repositories record no trusted branch, so an allow line carries both notes, in the fixed
  // order: the repository note, then the no trusted branch warning. A block line carries only the
  // repository note.
  const OWN_REPOSITORY_PASS = `${OWN_REPOSITORY_VERDICT}, ${NO_TRUSTED_BRANCH_WARNING}`;

  let parent = '';

  function gitIn(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=usabl test', '-c', 'user.email=test@example.invalid', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  }

  async function makeRepository(name: string): Promise<string> {
    const folder = join(parent, name);
    await mkdir(join(folder, 'src'), { recursive: true });
    gitIn(folder, 'init', '-q', '-b', 'main');
    await writeFile(join(folder, '.gitignore'), '.usabl/\n');
    await writeFile(join(folder, 'usabl.config.json'), JSON.stringify(config, null, 2) + '\n');
    await writeFile(join(folder, 'src', 'App.tsx'), 'export const App = 1;\n');
    await writeFile(join(folder, 'src', 'Other.tsx'), 'export const Other = 1;\n');
    gitIn(folder, 'add', '-A');
    gitIn(folder, 'commit', '-q', '-m', 'init');
    return folder;
  }

  async function stopIn(folder: string, projectDir: string | null): Promise<{ stderr: string; stdout: string; scanned: string[] }> {
    const out: string[] = [];
    const said: string[] = [];
    state.scanned = [];
    const ports = {
      ...makeStopHookRunnerPorts({ startDir: folder, env: projectDir === null ? {} : { CLAUDE_PROJECT_DIR: projectDir } }),
      pins: memoryPinStore(),
      stdoutWrite: async (text: string) => {
        said.push(text);
      },
      stderrWrite: async (text: string) => {
        out.push(text);
      },
    };
    await runStopHookFromStdin(stopInput({ session: 'session-one' }), ports);
    return { stderr: out.join(''), stdout: said.join(''), scanned: [...state.scanned] };
  }

  function expectNamed(text: string, name: string): void {
    const frameStart = text.indexOf('[BEGIN UNTRUSTED TEXT', text.indexOf(OWN_REPOSITORY_NOTE));
    expect(frameStart).toBeGreaterThan(0);
    expect(text.indexOf(`repository checked: ${name}`)).toBeGreaterThan(frameStart);
    expect(text).toContain('If the work was in another repository, run usabl check there.');
  }

  beforeEach(async () => {
    parent = await realpath(await mkdtemp(join(tmpdir(), 'usabl-parent-')));
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it('an idle stop in a clean sibling repository names it and does not read as a plain idle line', async () => {
    const app = await makeRepository('app');
    const other = await makeRepository('other');
    state.drafts = { home: [homeBarrier] };
    await writeFile(join(app, 'src', 'App.tsx'), 'export const App = 2;\n');

    const stopped = await stopIn(other, parent);
    expect(blockReason(stopped)).toBeNull();
    expect(stopped.scanned).toEqual([]);
    expect(stopped.stderr.startsWith(`NO VERDICT: IDLE (exit 0, ${OWN_REPOSITORY_PASS})`)).toBe(true);
    expect(stopped.stderr).toContain(OWN_REPOSITORY_NOTE);
    expectNamed(stopped.stderr, 'other');
    // The person sees it too: an allow with a note is sent as a systemMessage.
    expect(stopped.stdout).toContain(OWN_REPOSITORY_NOTE);
  });

  it('a block, a verified stop, and a stored receipt stop each carry the note', async () => {
    const app = await makeRepository('app');
    await writeFile(join(app, 'src', 'App.tsx'), 'export const App = 2;\n');

    state.drafts = { home: [homeBarrier] };
    const blocked = await stopIn(app, parent);
    const reason = blockReason(blocked) ?? '';
    expect(reason.startsWith(`REGRESSION (exit 1, ${OWN_REPOSITORY_VERDICT})`)).toBe(true);
    expect(blocked.stderr).toContain(OWN_REPOSITORY_NOTE);
    expectNamed(blocked.stderr, 'app');

    state.drafts = {};
    const verified = await stopIn(app, parent);
    expect(verified.stderr.startsWith(`VERIFIED (exit 0, ${OWN_REPOSITORY_PASS})`)).toBe(true);
    expectNamed(verified.stderr, 'app');

    const stored = await stopIn(app, parent);
    expect(stored.scanned).toEqual([]);
    expect(stored.stderr.startsWith(`VERIFIED (exit 0, stored receipt, not re-scanned, ${OWN_REPOSITORY_PASS})`)).toBe(
      true,
    );
    expectNamed(stored.stderr, 'app');
  });

  it('adds nothing when CLAUDE_PROJECT_DIR is the repository or is not set', async () => {
    const app = await makeRepository('app');
    await writeFile(join(app, 'src', 'App.tsx'), 'export const App = 2;\n');
    for (const projectDir of [app, null]) {
      const stopped = await stopIn(join(app, 'src'), projectDir);
      expect(stopped.stderr).not.toContain(OWN_REPOSITORY_VERDICT);
      expect(stopped.stderr).not.toContain(OWN_REPOSITORY_NOTE);
    }
  });
});

// What a session could do to make a normal branch look like a branch that sets usabl up. None of
// them reaches a VERIFIED line that does not say the policy came from the branch.
describe('a session cannot make a configured branch read as a setup branch', { timeout: REAL_PROCESS_BUDGET_MS }, () => {
  const stop = stopInSession;

  // main: a commit with no config, then the config. The branch waives the barrier it adds.
  async function configuredBranchWithWaiver(): Promise<string> {
    git('rm', '-q', 'usabl.config.json');
    git('commit', '-q', '-m', 'before usabl');
    const beforeSetup = git('rev-parse', 'HEAD').trim();
    await write('usabl.config.json', JSON.stringify(config, null, 2) + '\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'set usabl up');
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    state.drafts = { home: [homeBarrier] };
    await write('src/App.tsx', 'export const App = 2;\n');
    await write('.usabl-waivers.json', JSON.stringify({ version: 1, waivers: [homeWaiver] }, null, 2) + '\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'change the app and waive its barrier');
    return beforeSetup;
  }

  it('blocks the waiver for approval when nothing is moved', async () => {
    await configuredBranchWithWaiver();
    const stopped = await stop();
    expect(blockReason(stopped)).toContain('APPROVAL REQUIRED');
    expect(stopped.stderr).not.toContain(SETUP_NOTE);
  });

  it('origin/HEAD pointed at an origin branch from before the setup gives the setup notice on the verdict line', async () => {
    const beforeSetup = await configuredBranchWithWaiver();
    git('update-ref', 'refs/remotes/origin/old', beforeSetup);
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/old');

    const stopped = await stop();
    expect(blockReason(stopped)).toBeNull();
    expect(stopped.stderr.startsWith(`VERIFIED (exit 0, ${SETUP_VERDICT})`)).toBe(true);
    expect(stopped.stderr).toContain(SETUP_NOTE);
  });

  it('origin/main moved back to before the setup gives the setup notice on the verdict line', async () => {
    const beforeSetup = await configuredBranchWithWaiver();
    git('update-ref', 'refs/remotes/origin/main', beforeSetup);

    const stopped = await stop();
    expect(blockReason(stopped)).toBeNull();
    expect(stopped.stderr.startsWith(`VERIFIED (exit 0, ${SETUP_VERDICT})`)).toBe(true);
    expect(stopped.stderr).toContain(SETUP_NOTE);
  });

  it('origin/HEAD deleted keeps the no trusted branch path and its note', async () => {
    await configuredBranchWithWaiver();
    git('symbolic-ref', '-d', 'refs/remotes/origin/HEAD');

    const stopped = await stop();
    expect(stopped.stderr).not.toContain(SETUP_NOTE);
    expect(stopped.stderr).not.toContain(SETUP_VERDICT);
    expect(stopped.stderr).toContain('Note: usabl found no trusted branch to compare this branch with');
  });

  it('origin/HEAD pointed at a branch that does not exist is a gap', async () => {
    await configuredBranchWithWaiver();
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone');

    const stopped = await stop();
    expect(blockReason(stopped)).toContain('usabl could not find where this branch left the trusted branch');
    expect(stopped.scanned).toEqual([]);
  });

  it('a config deleted from the working tree only blocks', async () => {
    await configuredBranchWithWaiver();
    await rm(join(repo, 'usabl.config.json'));

    const stopped = await stop();
    expect(blockReason(stopped)).toContain('missing from the working tree');
    expect(stopped.scanned).toEqual([]);
  });

  it('a config removed in a commit blocks for approval', async () => {
    await configuredBranchWithWaiver();
    git('rm', '-q', 'usabl.config.json');
    git('commit', '-q', '-m', 'remove usabl');

    const stopped = await stop();
    expect(blockReason(stopped)).toContain(REMOVED);
  });

  it('a config removed in a commit with origin/HEAD deleted is never read as verified', async () => {
    await configuredBranchWithWaiver();
    git('rm', '-q', 'usabl.config.json');
    git('commit', '-q', '-m', 'remove usabl');
    git('symbolic-ref', '-d', 'refs/remotes/origin/HEAD');

    const stopped = await stop();
    expect(stopped.stderr.startsWith('NOT verified')).toBe(true);
    expect(stopped.stderr).not.toContain('VERIFIED (exit 0');
    expect(stopped.scanned).toEqual([]);
  });

  it('a branch rebuilt on a commit from before the setup reads as older than the setup', async () => {
    const beforeSetup = await configuredBranchWithWaiver();
    git('switch', '-q', '-c', 'rebuilt', beforeSetup);
    await write('src/App.tsx', 'export const App = 2;\n');
    await write('usabl.config.json', JSON.stringify(config, null, 2) + '\n');
    await write('.usabl-waivers.json', JSON.stringify({ version: 1, waivers: [homeWaiver] }, null, 2) + '\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'the same change on the old base');

    const stopped = await stop();
    expect(blockReason(stopped)).toContain(OLD_BRANCH);
    expect(stopped.scanned).toEqual([]);
  });
});

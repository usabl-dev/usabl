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
    pins: memoryPinStore(),
    stdoutWrite: async (text: string) => {
      said.push(text);
    },
    stderrWrite: async (text: string) => {
      out.push(text);
    },
  };
  await runStopHookFromStdin('{}', ports);
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

  it('a branch that sets usabl up is a guarded change until the config is on the trusted branch', async () => {
    git('rm', '-q', 'usabl.config.json');
    git('commit', '-q', '-m', 'main has no usabl config yet');
    recordTrustedBranch();
    git('switch', '-q', '-c', 'feature');
    await write('usabl.config.json', JSON.stringify(config, null, 2) + '\n');
    await write('src/App.tsx', 'export const App = 2;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'set usabl up');

    const stopped = await stop();
    expectApprovalBlock(stopped, 'usabl.config.json');
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

  // The stop plans from the bytes it read and compared with the last commit. It reads the file once
  // more before it saves its receipt, and saves none when the file holds other bytes by then.
  it('a stop whose config changes while it checks saves no receipt, and the next stop checks again', async () => {
    state.drafts = {};
    await write('src/App.tsx', 'export const App = 2;\n');
    let reads = 0;
    const first = await stop({
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

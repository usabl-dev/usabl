/**
 * The Stop hook blocks when it cannot tell whether guarded policy changed.
 *
 * The hook's outer catch allows, because a wedged hook is worse than an honest unverified allow.
 * But the guard and the session pins are what tell the hook whether guarded policy diverged. When
 * one of them fails, the hook does not know, so it blocks once with the reason and lets the
 * continuation through marked NOT verified, as it does for diverged files.
 *
 * The first two cases are a reviewer's inputs on a real repository: a config that matches HEAD
 * and a session that edits the waiver ledger. The guard used to throw on both entries, and the
 * hook allowed with "stop hook error".
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { Deps, Result, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { mintReceipt } from '../../src/evidence/receipt.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { makeGitReader } from '../../src/deps/git.js';
import { run } from '../../src/run.js';
import { evaluateStopDecision } from '../../src/surfaces/stop-hook.js';
import {
  makeStopHookRunnerPorts,
  runStopHookFromStdin,
  type StopHookRunnerPorts,
} from '../../src/surfaces/stop-hook-runner.js';
import { testConfig } from '../helpers.js';
import { committedConfigBytes } from '../support/config-bytes.js';
import { memoryPinStore } from '../support/memory-pin-store.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

async function write(root: string, path: string, contents: string): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), contents, 'utf8');
}

function configWith(extra: Record<string, unknown>): UsablConfig {
  return {
    appBaseUrl: 'http://127.0.0.1:5173',
    uiFileGlobs: ['src/**'],
    discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
    surfaces: [],
    guardedPaths: [],
    ...extra,
  } as UsablConfig;
}

describe('the Stop hook on a config the guard reads wide or as a path', { timeout: 30_000 }, () => {
  let root = '';

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function hookOutput(config: UsablConfig): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'usabl-hook-guard-'));
    await git(root, ['init', '--initial-branch=main']);
    await git(root, ['config', 'user.name', 'Test User']);
    await git(root, ['config', 'user.email', 'test@example.com']);
    await write(root, 'usabl.config.json', JSON.stringify(config, null, 2));
    await write(root, '.usabl-waivers.json', '{"waivers":[]}\n');
    await write(root, 'policy/rule1.json', '{}\n');
    await write(root, 'src/App.tsx', 'x\n');
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-m', 'main']);
    await write(root, '.usabl-waivers.json', '{"waivers":["accept everything"]}\n');

    const out: string[] = [];
    const deps: Deps = { ...makeFakeDeps(), git: makeGitReader({ cwd: root }), fs: makeFsGlob({ cwd: root }) };
    const ports: StopHookRunnerPorts = {
      ...makeStopHookRunnerPorts({ startDir: root, env: {} }),
      pins: memoryPinStore(),
      stdoutWrite: async (text) => {
        out.push(text);
      },
      stderrWrite: async (text) => {
        out.push(text);
      },
      buildDeps: async () => deps,
      runEngine: async (engineDeps, engineConfig) => run(engineDeps, engineConfig),
    };
    await runStopHookFromStdin(JSON.stringify({ session_id: 'guard-wide', stop_hook_active: false }), ports);
    return out.join('');
  }

  it('blocks a waiver edit when the requirements folder is named requirements (v2)', async () => {
    const output = await hookOutput(configWith({ requirements: 'requirements (v2)' }));
    expect(output).toContain('"decision":"block"');
    expect(output).not.toContain('stop hook error');
  });

  it('blocks a waiver edit when a guardedPaths entry holds a .. after a wildcard', async () => {
    const output = await hookOutput(configWith({ guardedPaths: ['policy/*/..'] }));
    expect(output).toContain('"decision":"block"');
    expect(output).not.toContain('stop hook error');
  });
});

describe('the Stop hook when the guard itself fails', () => {
  const config = testConfig({});
  const configBytes = '{}';

  /** Fake deps whose guard listing throws on the given calls, counted from 1. */
  function failingDeps(failOn: (call: number) => boolean): Deps {
    const deps = makeFakeDeps({
      files: { 'usabl.config.json': configBytes },
      headContents: { 'usabl.config.json': configBytes },
    });
    let calls = 0;
    return {
      ...deps,
      git: {
        ...deps.git,
        lsFilesUnder: async (ref, prefixes) => {
          calls += 1;
          if (failOn(calls)) {
            throw new Error('git ls-tree printed more than usabl reads\nsecond line token=SECRETPOISON');
          }
          return deps.git.lsFilesUnder(ref, prefixes);
        },
      },
    };
  }

  function ports(stdout: string[], stderr: string[], deps: Deps): StopHookRunnerPorts {
    return {
      fs: { readFile: async () => null, writeFile: async () => {}, mkdir: async () => {}, unlink: async () => {} },
      pins: memoryPinStore(),
      cwd: () => '/repo/one',
      stdoutWrite: async (text) => {
        stdout.push(text);
      },
      stderrWrite: async (text) => {
        stderr.push(text);
      },
      readConfigBytes: async () => committedConfigBytes(configBytes),
      loadConfig: async () => config,
      buildDeps: async () => deps,
      runEngine: async (engineDeps, engineConfig) => run(engineDeps, engineConfig),
      evaluateDecision: evaluateStopDecision,
    };
  }

  for (const [label, failOn] of [
    ['the guard check', (call: number) => call === 1],
    ['the session pins', (call: number) => call === 2],
  ] as const) {
    it(`blocks once when ${label} fails, then lets the continuation through marked NOT verified`, async () => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      await runStopHookFromStdin(
        JSON.stringify({ session_id: 'guard-fails', stop_hook_active: false }),
        ports(stdout, stderr, failingDeps(failOn)),
      );
      const payload = JSON.parse(stdout.join('').trim()) as { decision: string; reason: string };
      expect(payload.decision).toBe('block');
      expect(payload.reason).toContain('could not tell whether guarded policy files changed');
      expect(payload.reason).toContain('git ls-tree printed more than usabl reads');
      // Only the first line of the error is carried.
      expect(payload.reason).not.toContain('SECRETPOISON');

      const again: string[] = [];
      const againErr: string[] = [];
      await runStopHookFromStdin(
        JSON.stringify({ session_id: 'guard-fails', stop_hook_active: true }),
        ports(again, againErr, failingDeps(failOn)),
      );
      expect(again.join('')).not.toContain('"decision":"block"');
      const text = againErr.join('');
      expect(text).toContain('NOT verified');
      expect(text).toContain('continuation already active');
      expect(text).not.toContain('stop hook error');
    });
  }
});

/**
 * A stored receipt only offers a fast allow. When the hook cannot read or check it, the hook drops
 * the fast path and runs the full check, and the decision is the run's.
 */
describe('the Stop hook when the stored receipt cannot be checked', () => {
  const config = testConfig({});
  const configBytes = '{}';
  const files = { 'usabl.config.json': configBytes };

  const result = (over: Partial<Result>): Result => ({
    schemaVersion: 'usabl.result.v1',
    verdict: 'verified',
    summary: 'verified: 0 gating finding(s)',
    screens: [],
    coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
    findings: [],
    receipt: null,
    dirtyGuardedPaths: [],
    exitCode: 0,
    accessibilityVerdict: 'verified',
    accessibilityExitCode: 0,
    paidDownCount: 0,
    floorHeadroom: [],
    floorUnconfirmed: [],
    ...over,
  });

  async function storedReceipt(): Promise<string> {
    const receipt = await mintReceipt(makeFakeDeps({ files, headContents: { ...files } }), config, {
      surfaces: ['cli'],
      checked: ['clusters'],
      notCovered: [],
      applicability: [],
      findingsSummary: { new: 0, carried: 0, fixed: 0, unverified: 0 },
      activeWaivers: 0,
    });
    return JSON.stringify(receipt, null, 2);
  }

  /** Deps whose third guard listing, the one the receipt check makes, throws. */
  function depsFailingReceiptCheck(): Deps {
    const deps = makeFakeDeps({ files, headContents: { ...files } });
    let calls = 0;
    return {
      ...deps,
      git: {
        ...deps.git,
        lsFilesUnder: async (ref, prefixes) => {
          calls += 1;
          if (calls === 3) {
            throw new Error('git ls-tree failed while checking the receipt');
          }
          return deps.git.lsFilesUnder(ref, prefixes);
        },
      },
    };
  }

  async function stop(
    readReceipt: () => Promise<string | null>,
    deps: Deps,
    engineResult: Result,
  ): Promise<{ engineRan: boolean; stdout: string; stderr: string }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let engineRan = false;
    const ports: StopHookRunnerPorts = {
      fs: {
        readFile: async (path) => (path === '.usabl/receipt.json' ? readReceipt() : null),
        writeFile: async () => {},
        mkdir: async () => {},
        unlink: async () => {},
      },
      pins: memoryPinStore(),
      cwd: () => '/repo/one',
      stdoutWrite: async (text) => {
        stdout.push(text);
      },
      stderrWrite: async (text) => {
        stderr.push(text);
      },
      readConfigBytes: async () => committedConfigBytes(configBytes),
      loadConfig: async () => config,
      buildDeps: async () => deps,
      runEngine: async () => {
        engineRan = true;
        return engineResult;
      },
      evaluateDecision: evaluateStopDecision,
    };
    await runStopHookFromStdin(JSON.stringify({ session_id: 'receipt-fails', stop_hook_active: false }), ports);
    return { engineRan, stdout: stdout.join(''), stderr: stderr.join('') };
  }

  const cases: Array<[string, () => Promise<{ read: () => Promise<string | null>; deps: Deps }>]> = [
    [
      'reading the receipt throws',
      async () => ({
        read: async () => {
          throw new Error('EIO: the receipt could not be read');
        },
        deps: makeFakeDeps({ files, headContents: { ...files } }),
      }),
    ],
    [
      'checking the receipt throws',
      async () => {
        const raw = await storedReceipt();
        return { read: async () => raw, deps: depsFailingReceiptCheck() };
      },
    ],
  ];

  for (const [label, setup] of cases) {
    it(`runs the full check when ${label}, and allows on the run's verified result`, async () => {
      const { read, deps } = await setup();
      const out = await stop(read, deps, result({}));
      expect(out.engineRan).toBe(true);
      expect(out.stdout).not.toContain('"decision":"block"');
      expect(out.stderr).toContain('VERIFIED');
      expect(out.stderr).not.toContain('stored receipt');
      expect(out.stderr).not.toContain('could not tell whether guarded policy files changed');
    });

    it(`runs the full check when ${label}, and blocks on the run's regression`, async () => {
      const { read, deps } = await setup();
      const out = await stop(read, deps, result({ verdict: 'regression', exitCode: 1, accessibilityVerdict: 'regression', accessibilityExitCode: 1 }));
      expect(out.engineRan).toBe(true);
      expect(out.stdout).toContain('"decision":"block"');
      expect(out.stdout).not.toContain('could not tell whether guarded policy files changed');
    });
  }
});

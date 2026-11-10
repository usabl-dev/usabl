/**
 * The Stop hook reads usabl.config.json at the repository root and compares its raw bytes with
 * the last commit before it parses anything.
 *
 * A config that differs from the last commit, or that cannot be read or parsed, is guarded policy
 * that changed, so the stop blocks as approval required. Like every other block, it lets one
 * continuation through while stop_hook_active is set, so a person who edits the config on purpose
 * is never trapped in a loop. A repository with no config in the working tree or the last commit
 * is not set up for usabl, and the stop goes through with a plain note that says so.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Deps, Result, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { BYPASS_ONCE_PATH } from '../../src/surfaces/receipt-store.js';
import { evaluateStopDecision } from '../../src/surfaces/stop-hook.js';
import {
  makeStopHookRunnerPorts,
  runStopHookFromStdin,
  type ConfigBytes,
  type StopHookRunnerPorts,
} from '../../src/surfaces/stop-hook-runner.js';
import { memoryPinStore } from '../support/memory-pin-store.js';

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'src/routes.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: [],
};

const COMMITTED = JSON.stringify(config, null, 2);
const EDITED = JSON.stringify({ ...config, guardedPaths: ['src/policy.ts'] }, null, 2);
const CORRUPT = '{not-json';

const verified = (): Result => ({
  schemaVersion: 'usabl.result.v1',
  verdict: 'verified',
  summary: 'verified: 0 gating finding(s)',
  screens: [],
  coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
  findings: [],
  receipt: null,
  dirtyGuardedPaths: [],
  exitCode: 0,
  accessibilityVerdict: null,
  accessibilityExitCode: 0,
  paidDownCount: 0,
  floorHeadroom: [],
  floorUnconfirmed: [],
});

const found = (text: string) => ({ status: 'found' as const, text });
const missing = { status: 'missing' as const };
const unreadable = (reason: string) => ({ status: 'unreadable' as const, reason });

function harness(bytes: ConfigBytes) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const parsed: string[] = [];
  let engineRuns = 0;
  const files = new Map<string, string>();
  const deps = makeFakeDeps({
    files: bytes.working.status === 'found' ? { 'usabl.config.json': bytes.working.text } : {},
    headContents: bytes.head.status === 'found' ? { 'usabl.config.json': bytes.head.text } : {},
  });
  const ports: StopHookRunnerPorts = {
    fs: {
      readFile: async (path) => files.get(path) ?? null,
      writeFile: async (path, contents) => {
        files.set(path, contents);
      },
      mkdir: async () => {},
      unlink: async (path) => {
        files.delete(path);
      },
    },
    pins: memoryPinStore(),
    cwd: () => '/repo/one',
    stdoutWrite: async (text) => {
      stdout.push(text);
    },
    stderrWrite: async (text) => {
      stderr.push(text);
    },
    readConfigBytes: async () => bytes,
    loadConfig: async (text: string) => {
      parsed.push(text);
      JSON.parse(text);
      return config;
    },
    buildDeps: async () => deps,
    runEngine: async () => {
      engineRuns += 1;
      return verified();
    },
    evaluateDecision: evaluateStopDecision,
  };
  return {
    ports,
    stdout: () => stdout.join(''),
    stderr: () => stderr.join(''),
    parsed,
    engineRuns: () => engineRuns,
  };
}

function stopInput(active: boolean): string {
  return JSON.stringify({ stop_hook_active: active });
}

function blockReason(stdout: string): string {
  const payload = JSON.parse(stdout.trim()) as { decision: string; reason: string };
  expect(payload.decision).toBe('block');
  return payload.reason;
}

describe('Stop hook compares usabl.config.json with the last commit before it parses it', () => {
  it('blocks a corrupt config as approval required once, then lets the continuation through', async () => {
    const first = harness({ working: found(CORRUPT), head: found(COMMITTED) });
    expect(await runStopHookFromStdin(stopInput(false), first.ports)).toBe(0);
    const reason = blockReason(first.stdout());
    expect(reason).toContain('approval required');
    expect(reason).toContain('usabl.config.json');
    expect(reason).toContain('differs from the last commit');
    expect(reason).toContain('so usabl did not parse it');
    expect(reason).toContain('Do not edit the file to clear this block.');
    expect(reason).toContain('Next:');
    expect(reason).toContain('usabl bypass');
    // The working copy was never parsed and nothing ran.
    expect(first.parsed).toEqual([]);
    expect(first.engineRuns()).toBe(0);
    expect(first.stderr()).not.toContain('stop hook error');

    const second = harness({ working: found(CORRUPT), head: found(COMMITTED) });
    expect(await runStopHookFromStdin(stopInput(true), second.ports)).toBe(0);
    expect(second.stdout()).not.toContain('"decision":"block"');
    expect(second.stderr()).toContain('NOT verified');
    expect(second.stderr()).toContain('approval required');
    expect(second.stderr()).toContain('continuation already active');
    // The stop went through, so nothing here is a block to clear.
    expect(second.stderr()).not.toContain('to clear this block');
    expect(second.stderr()).toContain('Do not edit the file to make a later stop pass.');
    expect(second.engineRuns()).toBe(0);
  });

  it('blocks a config edited on purpose once, then lets the continuation through', async () => {
    const first = harness({ working: found(EDITED), head: found(COMMITTED) });
    await runStopHookFromStdin(stopInput(false), first.ports);
    const reason = blockReason(first.stdout());
    expect(reason).toContain('approval required');
    expect(reason).toContain('differs from the last commit');
    expect(reason).toContain('Do not edit');
    expect(first.parsed).toEqual([]);
    expect(first.engineRuns()).toBe(0);

    const second = harness({ working: found(EDITED), head: found(COMMITTED) });
    await runStopHookFromStdin(stopInput(true), second.ports);
    expect(second.stdout()).not.toContain('"decision":"block"');
    expect(second.stderr()).toContain('continuation already active');
    expect(second.engineRuns()).toBe(0);
  });

  it('blocks a config that is in the last commit but missing from the working tree', async () => {
    const h = harness({ working: missing, head: found(COMMITTED) });
    await runStopHookFromStdin(stopInput(false), h.ports);
    const reason = blockReason(h.stdout());
    expect(reason).toContain('approval required');
    expect(reason).toContain('missing from the working tree');
    expect(h.engineRuns()).toBe(0);
  });

  it('blocks a config the hook cannot read, with the error inside the untrusted frame', async () => {
    const h = harness({ working: unreadable('EACCES: permission denied, open usabl.config.json'), head: found(COMMITTED) });
    await runStopHookFromStdin(stopInput(false), h.ports);
    const reason = blockReason(h.stdout());
    expect(reason).toContain('approval required');
    expect(reason).toContain('cannot be read');
    const frameStart = reason.indexOf('[BEGIN UNTRUSTED TEXT');
    expect(frameStart).toBeGreaterThan(0);
    expect(reason.indexOf('EACCES')).toBeGreaterThan(frameStart);
    expect(h.engineRuns()).toBe(0);
  });

  it('blocks a committed config that matches the last commit but does not parse', async () => {
    const h = harness({ working: found(CORRUPT), head: found(CORRUPT) });
    await runStopHookFromStdin(stopInput(false), h.ports);
    const reason = blockReason(h.stdout());
    expect(reason).toContain('approval required');
    expect(reason).toContain('does not parse');
    // usabl init refuses to overwrite a config without --force, so the step names the flag.
    expect(reason).toContain('usabl init --force');
    expect(h.engineRuns()).toBe(0);
    expect(h.stderr()).not.toContain('stop hook error');

    const again = harness({ working: found(CORRUPT), head: found(CORRUPT) });
    await runStopHookFromStdin(stopInput(true), again.ports);
    expect(again.stdout()).not.toContain('"decision":"block"');
    expect(again.stderr()).toContain('continuation already active');
    expect(again.stderr()).not.toContain('to clear this block');
    expect(again.stderr()).toContain('Do not edit the file to make a later stop pass.');
  });

  it('goes on as before when the working config matches the last commit', async () => {
    const h = harness({ working: found(COMMITTED), head: found(COMMITTED) });
    await runStopHookFromStdin(stopInput(false), h.ports);
    expect(h.parsed).toEqual([COMMITTED]);
    expect(h.engineRuns()).toBe(1);
    expect(h.stdout()).not.toContain('"decision":"block"');
    expect(h.stderr()).toContain('VERIFIED');
  });

  it('allows with a plain note when the repository has no usabl config at all', async () => {
    const h = harness({ working: missing, head: missing });
    await runStopHookFromStdin(stopInput(false), h.ports);
    expect(h.stdout()).not.toContain('"decision":"block"');
    expect(h.stderr()).toContain('NOT verified');
    expect(h.stderr()).toContain('usabl is not configured here');
    expect(h.stderr()).toContain('usabl init');
    expect(h.stderr()).not.toContain('stop hook error');
    expect(h.parsed).toEqual([]);
    expect(h.engineRuns()).toBe(0);
  });

  it('answers Cursor with {} when the repository has no usabl config', async () => {
    const h = harness({ working: missing, head: missing });
    await runStopHookFromStdin('{}', h.ports, { cursorMode: true });
    expect(h.stdout().trim()).toBe('{}');
    expect(h.stderr()).toContain('usabl is not configured here');
  });

  it('loops Cursor once with a followup message on a diverged config', async () => {
    const h = harness({ working: found(EDITED), head: found(COMMITTED) });
    await runStopHookFromStdin(JSON.stringify({ loop_count: 0 }), h.ports, { cursorMode: true });
    const payload = JSON.parse(h.stdout().trim()) as { followup_message?: string };
    expect(payload.followup_message).toContain('approval required');

    const again = harness({ working: found(EDITED), head: found(COMMITTED) });
    await runStopHookFromStdin(JSON.stringify({ loop_count: 1 }), again.ports, { cursorMode: true });
    expect(again.stdout().trim()).toBe('{}');
    expect(again.stderr()).toContain('continuation already active');
  });

  it('treats a new, uncommitted config as the guard does: it runs, and the guard holds it for approval', async () => {
    const h = harness({ working: found(COMMITTED), head: missing });
    h.ports.runEngine = async (deps: Deps, engineConfig: UsablConfig) => {
      const { run } = await import('../../src/run.js');
      return run(deps, engineConfig);
    };
    await runStopHookFromStdin(stopInput(false), h.ports);
    expect(h.parsed).toEqual([COMMITTED]);
    const reason = blockReason(h.stdout());
    expect(reason).toContain('APPROVAL REQUIRED');
    expect(reason).toContain('usabl.config.json');
  });

  it('blocks a new, uncommitted config that does not parse, as approval required', async () => {
    const h = harness({ working: found(CORRUPT), head: missing });
    await runStopHookFromStdin(stopInput(false), h.ports);
    const reason = blockReason(h.stdout());
    expect(reason).toContain('approval required');
    expect(reason).toContain('does not parse');
    expect(h.engineRuns()).toBe(0);
  });

  it('keeps failing open with disclosure when git cannot read the last commit', async () => {
    const h = harness({ working: found(COMMITTED), head: unreadable('git exploded') });
    await runStopHookFromStdin(stopInput(false), h.ports);
    expect(h.stdout()).not.toContain('"decision":"block"');
    expect(h.stderr()).toContain('NOT verified - stop hook error');
    expect(h.stderr()).toContain('git exploded');
    expect(h.engineRuns()).toBe(0);
  });
});

describe('Stop hook reads the config at the repository root, through the real ports', () => {
  let repo = '';

  function git(...args: string[]): void {
    execFileSync('git', ['-c', 'user.name=usabl test', '-c', 'user.email=test@example.invalid', ...args], {
      cwd: repo,
      stdio: 'ignore',
    });
  }

  beforeEach(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), 'usabl-hook-root-')));
    git('init', '-q');
    await mkdir(join(repo, 'packages', 'web'), { recursive: true });
    await writeFile(join(repo, 'packages', 'web', 'index.ts'), 'export {};\n');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  function realPorts(startDir: string, env: Record<string, string | undefined> = {}) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const configs: UsablConfig[] = [];
    const base = makeStopHookRunnerPorts({ startDir, env });
    const ports: StopHookRunnerPorts = {
      ...base,
      pins: memoryPinStore(),
      stdoutWrite: async (text) => {
        stdout.push(text);
      },
      stderrWrite: async (text) => {
        stderr.push(text);
      },
      buildDeps: async (loaded) => {
        configs.push(loaded);
        return makeFakeDeps({
          files: { 'usabl.config.json': COMMITTED },
          headContents: { 'usabl.config.json': COMMITTED },
        });
      },
      runEngine: async () => verified(),
    };
    return { ports, base, configs, stdout: () => stdout.join(''), stderr: () => stderr.join('') };
  }

  it('reads the root config when the session stops in a subfolder', async () => {
    await writeFile(join(repo, 'usabl.config.json'), COMMITTED);
    git('add', '-A');
    git('commit', '-q', '-m', 'init');

    const h = realPorts(join(repo, 'packages', 'web'));
    expect(h.base.cwd()).toBe(repo);
    expect(await h.base.readConfigBytes()).toEqual({ working: found(COMMITTED), head: found(COMMITTED) });

    await runStopHookFromStdin('{}', h.ports);
    expect(h.stdout()).not.toContain('"decision":"block"');
    expect(h.stderr()).toContain('VERIFIED');
    expect(h.configs).toEqual([config]);
  });

  it('reads the bypass file at the repository root, not in the subfolder', async () => {
    await writeFile(join(repo, 'usabl.config.json'), COMMITTED);
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    await mkdir(join(repo, '.usabl'), { recursive: true });
    await writeFile(join(repo, BYPASS_ONCE_PATH), 'now');

    const h = realPorts(join(repo, 'packages', 'web'));
    await runStopHookFromStdin('{}', h.ports);
    expect(h.stderr()).toContain('BYPASS consumed');
    await expect(readFile(join(repo, BYPASS_ONCE_PATH), 'utf8')).rejects.toThrow();
  });

  it('allows with the not-configured note in a repository with no usabl config', async () => {
    git('add', '-A');
    git('commit', '-q', '-m', 'init');

    const h = realPorts(join(repo, 'packages', 'web'));
    expect(await h.base.readConfigBytes()).toEqual({ working: missing, head: missing });
    await runStopHookFromStdin('{}', h.ports);
    expect(h.stdout()).not.toContain('"decision":"block"');
    expect(h.stderr()).toContain('usabl is not configured here');
    expect(h.configs).toEqual([]);
  });

  // Outside a work tree the hook could not look, so it says that, and never that the folder has
  // no config. The folder is a path from the environment, so it is printed only inside the frame.
  it('says it could not find the repository in a folder that is in no repository', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'usabl-hook-norepo-')));
    try {
      const h = realPorts(outside);
      expect(await h.base.readConfigBytes()).toEqual({ working: missing, head: { status: 'no-work-tree' } });
      await runStopHookFromStdin('{}', h.ports);
      expect(h.stdout()).not.toContain('"decision":"block"');
      const stderr = h.stderr();
      expect(stderr).toContain('outside any git work tree');
      expect(stderr).toContain('could not find the repository and checked nothing on this stop');
      expect(stderr).toContain('run usabl check from the project root');
      expect(stderr).not.toContain('usabl is not configured here');
      const frameStart = stderr.indexOf('[BEGIN UNTRUSTED TEXT');
      expect(frameStart).toBeGreaterThan(0);
      expect(stderr.indexOf(`folder: ${outside}`)).toBeGreaterThan(frameStart);
      expect(stderr.slice(0, frameStart)).not.toContain(outside);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('says it could not find the repository when it starts inside .git and CLAUDE_PROJECT_DIR is unset', async () => {
    await writeFile(join(repo, 'usabl.config.json'), CORRUPT);
    git('add', '-A');
    git('commit', '-q', '-m', 'init');

    const h = realPorts(join(repo, '.git'));
    await runStopHookFromStdin(stopInput(false), h.ports);
    expect(h.stdout()).not.toContain('"decision":"block"');
    expect(h.stderr()).toContain('outside any git work tree');
    expect(h.stderr()).not.toContain('usabl is not configured here');
  });

  it('starts at CLAUDE_PROJECT_DIR when it names a folder, so a stop inside .git still blocks', async () => {
    await writeFile(join(repo, 'usabl.config.json'), CORRUPT);
    git('add', '-A');
    git('commit', '-q', '-m', 'init');

    const h = realPorts(join(repo, '.git'), { CLAUDE_PROJECT_DIR: repo });
    expect(h.base.cwd()).toBe(repo);
    await runStopHookFromStdin(stopInput(false), h.ports);
    const reason = blockReason(h.stdout());
    expect(reason).toContain('approval required');
    expect(reason).toContain('does not parse');
  });

  it('ignores a CLAUDE_PROJECT_DIR that does not name a folder', async () => {
    await writeFile(join(repo, 'usabl.config.json'), COMMITTED);
    git('add', '-A');
    git('commit', '-q', '-m', 'init');

    for (const projectDir of [join(repo, 'no-such-folder'), join(repo, 'packages', 'web', 'index.ts'), '']) {
      const h = realPorts(join(repo, 'packages', 'web'), { CLAUDE_PROJECT_DIR: projectDir });
      expect(h.base.cwd()).toBe(repo);
      await runStopHookFromStdin('{}', h.ports);
      expect(h.stdout()).not.toContain('"decision":"block"');
      expect(h.stderr()).toContain('VERIFIED');
    }
  });

  // A config removed and committed during the session is the strongest form of policy drift. The
  // session pins hold the committed config from an earlier stop, so the stop goes through the
  // drift block, not the "not configured" allow.
  it('blocks once as drift when the config is removed and committed during the session', async () => {
    await writeFile(join(repo, 'usabl.config.json'), COMMITTED);
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const pins = memoryPinStore();
    const session = (active: boolean) => JSON.stringify({ stop_hook_active: active, session_id: 'session-one' });

    const first = realPorts(repo);
    first.ports.pins = pins;
    await runStopHookFromStdin(session(false), first.ports);
    expect(first.stderr()).toContain('VERIFIED');
    expect(pins.files.size).toBe(1);

    git('rm', '-q', 'usabl.config.json');
    git('commit', '-q', '-m', 'remove usabl');

    const second = realPorts(join(repo, 'packages', 'web'));
    second.ports.pins = pins;
    expect(await second.base.readConfigBytes()).toEqual({ working: missing, head: missing });
    await runStopHookFromStdin(session(false), second.ports);
    const reason = blockReason(second.stdout());
    expect(reason).toContain('guarded policy drift during this session');
    expect(reason).toContain('drifted files: usabl.config.json');
    expect(second.stderr()).not.toContain('usabl is not configured here');
    expect(second.configs).toEqual([]);

    const third = realPorts(repo);
    third.ports.pins = pins;
    await runStopHookFromStdin(session(true), third.ports);
    expect(third.stdout()).not.toContain('"decision":"block"');
    expect(third.stderr()).toContain('guarded policy drift during this session');
    expect(third.stderr()).toContain('continuation already active');
    expect(third.stderr()).not.toContain('to clear this');
    expect(third.stderr()).toContain('Do not edit those files to make a later stop pass.');
    // The pins are kept, so the next stop that is not a continuation blocks again.
    expect(pins.files.size).toBe(1);
  });

  it('still allows with the not-configured note in a repository that never had a config, with a session id', async () => {
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const h = realPorts(repo);
    await runStopHookFromStdin(JSON.stringify({ stop_hook_active: false, session_id: 'session-one' }), h.ports);
    expect(h.stdout()).not.toContain('"decision":"block"');
    expect(h.stderr()).toContain('usabl is not configured here');
  });

  // With no HEAD the guard cannot read the last commit, so the stop fails open with git's own
  // "make a first commit" step. It does not block. These cases pin that outcome with real git and
  // the real guard.
  function realGuardPorts(startDir: string) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let engineRuns = 0;
    const base = makeStopHookRunnerPorts({ startDir, env: {} });
    const ports: StopHookRunnerPorts = {
      ...base,
      pins: memoryPinStore(),
      stdoutWrite: async (text) => {
        stdout.push(text);
      },
      stderrWrite: async (text) => {
        stderr.push(text);
      },
      runEngine: async () => {
        engineRuns += 1;
        return verified();
      },
    };
    return { ports, stdout: () => stdout.join(''), stderr: () => stderr.join(''), engineRuns: () => engineRuns };
  }

  function expectNoHeadFailOpen(h: ReturnType<typeof realGuardPorts>): void {
    expect(h.stdout()).not.toContain('"decision":"block"');
    const stderr = h.stderr();
    expect(stderr.startsWith('NOT verified - stop hook error')).toBe(true);
    const frameStart = stderr.indexOf('[BEGIN UNTRUSTED TEXT');
    expect(frameStart).toBeGreaterThan(0);
    expect(stderr.indexOf('make a first commit')).toBeGreaterThan(frameStart);
    expect(h.engineRuns()).toBe(0);
    const payload = JSON.parse(h.stdout().trim()) as { systemMessage?: string };
    expect(payload.systemMessage).toContain('NOT verified - stop hook error');
  }

  it('fails open with the "make a first commit" disclosure in a repository with no commits', async () => {
    await writeFile(join(repo, 'usabl.config.json'), COMMITTED);
    const h = realGuardPorts(repo);
    expect(await runStopHookFromStdin(stopInput(false), h.ports)).toBe(0);
    expectNoHeadFailOpen(h);
  });

  it('fails open with the same disclosure on an orphan branch with no commit yet', async () => {
    await writeFile(join(repo, 'usabl.config.json'), COMMITTED);
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    git('checkout', '-q', '--orphan', 'fresh');
    const h = realGuardPorts(repo);
    expect(await runStopHookFromStdin(stopInput(false), h.ports)).toBe(0);
    expectNoHeadFailOpen(h);
  });

  it('blocks a corrupt root config read from a subfolder, through the real ports', async () => {
    await writeFile(join(repo, 'usabl.config.json'), COMMITTED);
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    await writeFile(join(repo, 'usabl.config.json'), CORRUPT);

    const h = realPorts(join(repo, 'packages', 'web'));
    await runStopHookFromStdin(stopInput(false), h.ports);
    expect(blockReason(h.stdout())).toContain('approval required');
    expect(h.configs).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import type { Deps, Result, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { mintReceipt } from '../../src/evidence/receipt.js';
import { BYPASS_ONCE_PATH } from '../../src/surfaces/receipt-store.js';
import { evaluateStopDecision } from '../../src/surfaces/stop-hook.js';
import { runStopHookFromStdin } from '../../src/surfaces/stop-hook-runner.js';

class MemoryRunnerFs {
  private readonly files = new Map<string, string>();
  readonly deleted: string[] = [];
  readonly writes: string[] = [];

  async readFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async writeFile(path: string, contents: string): Promise<void> {
    this.writes.push(path);
    this.files.set(path, contents);
  }

  async mkdir(_path: string): Promise<void> {}

  async unlink(path: string): Promise<void> {
    this.deleted.push(path);
    this.files.delete(path);
  }

  set(path: string, contents: string): void {
    this.files.set(path, contents);
  }
}

const configFixture: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['fixtures/app/src/**'],
  discovery: { routerFile: 'fixtures/app/src/routes.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: ['usabl.config.json'],
};

const baseResult = (over: Partial<Result>): Result => ({
  schemaVersion: 'usabl.result.v1',
  verdict: 'verified',
  summary: 'verified: 0 gating finding(s)',
  screens: [],
  coverage: {
    changedFiles: [],
    affected: [],
    unresolvedFiles: [],
    gaps: [],
    nothingToCheck: false,
  },
  findings: [],
  receipt: null,
  dirtyGuardedPaths: [],
  exitCode: 0,
  ...over,
});

function makePorts(overrides: {
  runEngine?: (deps: Deps, config: UsablConfig) => Promise<Result>;
  loadConfig?: () => Promise<UsablConfig>;
  buildDeps?: (config: UsablConfig) => Promise<Deps>;
  tmpDir?: () => string;
} = {}) {
  const fs = new MemoryRunnerFs();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps = makeFakeDeps();

  return {
    fs,
    stdout,
    stderr,
    ports: {
      fs,
      tmpDir: overrides.tmpDir ?? (() => '/tmp'),
      writeTree: () => deps.git.writeTree(),
      stdoutWrite: async (text: string) => {
        stdout.push(text);
      },
      stderrWrite: async (text: string) => {
        stderr.push(text);
      },
      loadConfig: overrides.loadConfig ?? (async () => configFixture),
      buildDeps: overrides.buildDeps ?? (async (_config: UsablConfig) => deps),
      runEngine: overrides.runEngine ?? (async () => baseResult({ verdict: 'verified' })),
      evaluateDecision: evaluateStopDecision,
    },
  };
}

describe('stop-hook-runner protocol', () => {
  it('allows invalid stdin json and discloses NOT verified', async () => {
    const { ports, stdout, stderr } = makePorts({
      loadConfig: async () => {
        throw new Error('invalid json should fail open before config load');
      },
    });

    const exitCode = await runStopHookFromStdin('{not-json}', ports);

    expect(exitCode).toBe(0);
    expect(stdout.join('')).not.toContain('"decision":"block"');
    expect(stderr.join('')).toContain('NOT verified');
  });

  it('consumes one-shot bypass file and allows', async () => {
    const { ports, fs, stdout, stderr } = makePorts();
    fs.set(BYPASS_ONCE_PATH, '2026-08-23T15:00:00.000Z');

    const exitCode = await runStopHookFromStdin('{}', ports);

    expect(exitCode).toBe(0);
    expect(fs.deleted).toContain(BYPASS_ONCE_PATH);
    expect(stdout.join('')).not.toContain('"decision":"block"');
    expect(stderr.join('')).toContain('BYPASS');
    expect(stderr.join('')).toContain('NOT verified');
  });

  it('blocks only by emitting one decision json object to stdout', async () => {
    const { ports, stdout, stderr } = makePorts({
      runEngine: async () =>
        baseResult({
          verdict: 'regression',
          summary: 'regression: 1 new deterministic finding(s)',
          findings: [
            {
              rule: 'color-contrast',
              layer: 'axe',
              severity: 'serious',
              evidenceClass: 'deterministic',
              screenId: 'clusters',
              elementPath: 'button',
              elementName: 'Save',
              role: 'button',
              whatUserExperiences: 'Save button text is hard to read',
              why: 'contrast too low',
              fix: 'increase contrast',
              evidence: {},
              confidence: 'fail',
              elementKey: 'button-save',
              identityBasis: 'name',
              status: 'new',
            },
          ],
          exitCode: 1,
        }),
    });

    const exitCode = await runStopHookFromStdin('{}', ports);

    expect(exitCode).toBe(0);
    const output = stdout.join('').trim();
    const payload = JSON.parse(output) as { decision: string; reason: string };
    expect(payload.decision).toBe('block');
    expect(typeof payload.reason).toBe('string');
    expect(payload.reason.length).toBeGreaterThan(0);
    expect(stderr.join('')).not.toContain('NOT verified - BYPASS');
  });

  it('allows when decision is not block and emits no block json', async () => {
    const { ports, stdout } = makePorts({
      runEngine: async () => baseResult({ verdict: 'verified', receipt: null }),
    });

    const exitCode = await runStopHookFromStdin('{}', ports);

    expect(exitCode).toBe(0);
    expect(stdout.join('')).not.toContain('"decision":"block"');
  });

  it('blocks on session pin drift and keeps previous pins unchanged', async () => {
    const { ports, fs, stdout } = makePorts({
      runEngine: async () => {
        throw new Error('drift should block before engine run');
      },
    });
    const previousPins = {
      'usabl.config.json': 'pin-old',
      '.usabl-evidence.json': 'pin-old-evidence',
    };
    fs.set('/tmp/usabl-pins-session-a.json', JSON.stringify(previousPins, null, 2));

    const exitCode = await runStopHookFromStdin(
      JSON.stringify({ session_id: 'session-a', stop_hook_active: false }),
      ports,
    );

    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdout.join('').trim()) as { decision: string; reason: string };
    expect(payload.decision).toBe('block');
    expect(payload.reason).toContain('NOT verified');
    expect(payload.reason).toContain('guarded policy drift');
    await expect(fs.readFile('/tmp/usabl-pins-session-a.json')).resolves.toBe(JSON.stringify(previousPins, null, 2));
  });

  it('allows active continuation on drift and still keeps previous pins', async () => {
    const { ports, fs, stdout, stderr } = makePorts({
      runEngine: async () => {
        throw new Error('active drift should not run engine');
      },
    });
    const previousPins = {
      'usabl.config.json': 'pin-old',
      '.usabl-waivers.json': 'pin-old-waiver',
    };
    fs.set('/tmp/usabl-pins-session-b.json', JSON.stringify(previousPins, null, 2));

    const exitCode = await runStopHookFromStdin(
      JSON.stringify({ session_id: 'session-b', stop_hook_active: true }),
      ports,
    );

    expect(exitCode).toBe(0);
    expect(stdout.join('')).not.toContain('"decision":"block"');
    expect(stderr.join('')).toContain('NOT verified');
    expect(stderr.join('')).toContain('continuation already active');
    await expect(fs.readFile('/tmp/usabl-pins-session-b.json')).resolves.toBe(JSON.stringify(previousPins, null, 2));
  });

  it('skips receipt fast path when guarded files are dirty', async () => {
    const config: UsablConfig = {
      ...configFixture,
      guardedPaths: ['usabl.config.json'],
    };
    const deps = makeFakeDeps({
      writeTree: 'tree-clean',
      runnerVersion: '0.1.0',
      files: {
        'usabl.config.json': '{"guardedPaths":["usabl.config.json"],"appBaseUrl":"http://dirty"}',
      },
      headContents: {
        'usabl.config.json': '{"guardedPaths":["usabl.config.json"],"appBaseUrl":"http://clean"}',
      },
      headBlobs: {
        'usabl.config.json': 'blob-config',
        '.usabl-evidence.json': 'blob-evidence',
        '.usabl-waivers.json': 'blob-waivers',
        'usabl.routes.json': 'blob-routes',
      },
    });
    const receipt = await mintReceipt(deps, config, {
      surfaces: ['cli'],
      checked: ['clusters'],
      notCovered: [],
      findingsSummary: { new: 0, carried: 0, fixed: 0, unverified: 0 },
      activeWaivers: 0,
    });

    const { ports, fs, stderr } = makePorts({
      loadConfig: async () => config,
      buildDeps: async () => deps,
    });
    fs.set('.usabl/receipt.json', JSON.stringify(receipt, null, 2));
    let runEngineCalled = false;
    ports.runEngine = async () => {
      runEngineCalled = true;
      return baseResult({ verdict: 'verified', receipt: null });
    };

    const exitCode = await runStopHookFromStdin('{}', ports);

    expect(exitCode).toBe(0);
    expect(runEngineCalled).toBe(true);
    expect(stderr.join('')).not.toContain('verified receipt sourceTree');
  });

  it('ignores unsafe session ids and avoids unsafe writes', async () => {
    const { ports, fs, stderr } = makePorts({
      tmpDir: () => '/tmp/safe-root',
      runEngine: async () => baseResult({ verdict: 'verified', receipt: null }),
    });

    const exitCode = await runStopHookFromStdin(
      JSON.stringify({ session_id: '../../etc/passwd', stop_hook_active: false }),
      ports,
    );

    expect(exitCode).toBe(0);
    expect(stderr.join('')).toContain('NOT verified');
    expect(stderr.join('')).toContain('session_id');
    expect(fs.writes.every((path) => !path.includes('..'))).toBe(true);
    expect(fs.writes.every((path) => !path.includes('/etc/passwd'))).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import type { Deps, Result, UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { BYPASS_ONCE_PATH } from '../../src/surfaces/receipt-store.js';
import { evaluateStopDecision } from '../../src/surfaces/stop-hook.js';
import { runStopHookFromStdin } from '../../src/surfaces/stop-hook-runner.js';

class MemoryRunnerFs {
  private readonly files = new Map<string, string>();
  readonly deleted: string[] = [];

  async readFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async writeFile(path: string, contents: string): Promise<void> {
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
      tmpDir: () => '/tmp',
      writeTree: () => deps.git.writeTree(),
      stdoutWrite: async (text: string) => {
        stdout.push(text);
      },
      stderrWrite: async (text: string) => {
        stderr.push(text);
      },
      loadConfig: overrides.loadConfig ?? (async () => configFixture),
      buildDeps: async (_config: UsablConfig) => deps,
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
});

/**
 * Diverged guarded policy blocks the stop whatever the run's exit code.
 *
 * run() refuses a run where every screen was unseen with no verdict and exit 4, the channel a
 * crash uses, and the Stop hook fails open on exit 4. The guard still reported the diverged
 * guarded files on that run, so allowing it lost the approval block the threat model promises.
 * The hook now blocks whenever the guard reports diverged paths, with the same one-continuation
 * rule as every other block. A crash with clean policy still fails open, as decided.
 */
import { describe, expect, it } from 'vitest';
import type { Result, ScreenScan, TranscriptStop } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { run } from '../../src/run.js';
import { evaluateStopDecision } from '../../src/surfaces/stop-hook.js';
import { runStopHookFromStdin, type StopHookRunnerPorts } from '../../src/surfaces/stop-hook-runner.js';
import { testConfig } from '../helpers.js';
import { committedConfigBytes } from '../support/config-bytes.js';
import { memoryPinStore } from '../support/memory-pin-store.js';

const baseResult = (over: Partial<Result>): Result => ({
  schemaVersion: 'usabl.result.v1',
  verdict: null,
  summary: 'unhandled error: read ECONNRESET',
  screens: [],
  coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
  findings: [],
  receipt: null,
  dirtyGuardedPaths: [],
  exitCode: 4,
  accessibilityVerdict: null,
  accessibilityExitCode: 4,
  paidDownCount: 0,
  floorHeadroom: [],
  floorUnconfirmed: [],
  ...over,
});

const UNTRUSTED_START = '[BEGIN UNTRUSTED TEXT';

describe('evaluateStopDecision on exit 4 with diverged guarded policy', () => {
  it('blocks when the Result names diverged guarded files', () => {
    const decision = evaluateStopDecision(
      baseResult({ summary: 'every screen unseen', dirtyGuardedPaths: ['.usabl-waivers.json'] }),
      { stopHookActive: false },
    );
    expect(decision.block).toBe(true);
    expect(decision.message.startsWith('NO VERDICT: RUN FAILED (exit 4): NOT verified.')).toBe(true);
    expect(decision.message).toContain('approval');
    expect(decision.message).toContain('Do not edit those files to clear this block.');
    expect(decision.message).toContain('usabl bypass');
    // The path is a carried value, so it is printed inside the frame only.
    const frame = decision.message.indexOf(UNTRUSTED_START);
    expect(frame).toBeGreaterThan(0);
    expect(decision.message.indexOf('.usabl-waivers.json')).toBeGreaterThan(frame);
  });

  it('blocks when the hook guard reported diverged files and the crashed run carried none', () => {
    const decision = evaluateStopDecision(baseResult({}), {
      stopHookActive: false,
      guardDivergedPaths: ['usabl.routes.json'],
    });
    expect(decision.block).toBe(true);
    expect(decision.message).toContain('usabl.routes.json');
  });

  it('lets one continuation through, marked NOT verified, and still names the files', () => {
    const decision = evaluateStopDecision(baseResult({ dirtyGuardedPaths: ['.usabl-waivers.json'] }), {
      stopHookActive: true,
    });
    expect(decision.block).toBe(false);
    expect(decision.message).toContain('NOT verified');
    expect(decision.message).toContain('continuation already active');
    expect(decision.message).toContain('.usabl-waivers.json');
  });

  it('still fails open on a crash when no guarded file diverged', () => {
    const decision = evaluateStopDecision(baseResult({}), { stopHookActive: false, guardDivergedPaths: [] });
    expect(decision.block).toBe(false);
    expect(decision.message).toContain('usabl is not blocking this stop');
  });

  it('blocks a verdict usabl does not recognize even with exit 4', () => {
    const decision = evaluateStopDecision(
      baseResult({ verdict: 'mystery' as unknown as Result['verdict'], summary: 'crash' }),
      { stopHookActive: false },
    );
    expect(decision.block).toBe(true);
    expect(decision.message.startsWith('UNRECOGNIZED VERDICT (exit 4): NOT verified. ')).toBe(true);
  });
});

describe('Stop hook on a run where every screen is unseen and guarded policy diverged', () => {
  const config = testConfig({
    surfaces: [{ id: 'overview', url: 'http://127.0.0.1:4200/overview', files: ['fixtures/app/src/OverviewPage.tsx'] }],
  });
  const bodyOnly: TranscriptStop[] = [
    { index: 0, elementPath: 'html > body:nth-child(2)', announcement: [], onBody: true },
  ];
  const blank: ScreenScan = {
    screenId: 'overview',
    url: 'http://127.0.0.1:4200/overview',
    stops: bodyOnly,
    drafts: [],
    gaps: [],
    applicability: [],
    reachedSelectorPresent: null,
  };
  const configBytes = '{}';
  const deps = () =>
    makeFakeDeps({
      files: { 'usabl.config.json': configBytes, '.usabl-waivers.json': '{"version":1,"waivers":[{"weakened":true}]}' },
      headContents: { 'usabl.config.json': configBytes, '.usabl-waivers.json': '{"version":1,"waivers":[]}' },
      changed: [{ code: 'M', path: 'fixtures/app/src/OverviewPage.tsx' }],
      scans: { overview: blank },
    });

  function ports(stdout: string[], stderr: string[]): StopHookRunnerPorts {
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
      buildDeps: async () => deps(),
      runEngine: async (engineDeps, engineConfig) => run(engineDeps, engineConfig),
      evaluateDecision: evaluateStopDecision,
    };
  }

  it('the run itself exits 4 with no verdict and names the diverged file', async () => {
    const result = await run(deps(), config);
    expect(result.verdict).toBeNull();
    expect(result.exitCode).toBe(4);
    expect(result.dirtyGuardedPaths).toContain('.usabl-waivers.json');
  });

  it('blocks the stop, then lets the continuation through', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    await runStopHookFromStdin(JSON.stringify({ stop_hook_active: false }), ports(stdout, stderr));
    const payload = JSON.parse(stdout.join('').trim()) as { decision: string; reason: string };
    expect(payload.decision).toBe('block');
    expect(payload.reason).toContain('.usabl-waivers.json');

    const again: string[] = [];
    const againErr: string[] = [];
    await runStopHookFromStdin(JSON.stringify({ stop_hook_active: true }), ports(again, againErr));
    expect(again.join('')).not.toContain('"decision":"block"');
    expect(againErr.join('')).toContain('continuation already active');
  });
});

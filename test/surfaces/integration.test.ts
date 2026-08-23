import { describe, expect, it } from 'vitest';
import type { Result } from '../../src/contracts/index.js';
import { projectCli } from '../../src/surfaces/cli.js';
import { assertUsablVerdict } from '../../src/surfaces/playwright-helper.js';
import { projectPrComment } from '../../src/surfaces/pr-comment.js';
import { projectSelfCheck } from '../../src/surfaces/self-check.js';
import { evaluateStopDecision } from '../../src/surfaces/stop-hook.js';
import { projectOverlay } from '../../src/surfaces/vite-plugin.js';

const POISON = 'token=SECRETPOISON';

const baseResult = (over: Partial<Result>): Result => ({
  schemaVersion: 'usabl.result.v1',
  verdict: 'regression',
  summary: 'regression: 1 new deterministic finding(s)',
  screens: [],
  coverage: {
    changedFiles: ['src/app.tsx'],
    affected: [],
    unresolvedFiles: [],
    gaps: [],
    nothingToCheck: false,
  },
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
      whatUserExperiences: `Page text contains ${POISON}`,
      why: 'Color ratio is too low',
      fix: 'Raise contrast to 4.5:1',
      evidence: {},
      confidence: 'fail',
      elementKey: 'k',
      identityBasis: 'name',
      status: 'new',
    },
  ],
  receipt: {
    schemaVersion: 1,
    sourceTree: 'tree-abc',
    baseRevision: 'origin/main',
    policyHash: 'policy-123',
    runnerVersion: '0.0.0-test',
    scannerVersions: { axeCore: '4.13.0', playwright: '1.62.1', chromium: 'revision-123' },
    surfaces: ['clusters'],
    coverage: { checked: ['clusters'], notCovered: [] },
    verdict: 'verified',
    findingsSummary: { new: 1, carried: 0, fixed: 0, unverified: 0 },
    activeWaivers: 0,
    mintedAt: '2026-08-22T12:00:00.000Z',
  },
  dirtyGuardedPaths: [],
  exitCode: 1,
  ...over,
});

describe('surface integration projections', () => {
  it('keeps gate and stop-hook behavior aligned with one regression result', () => {
    const regression = baseResult({ verdict: 'regression', exitCode: 1 });

    const cliProjection = projectCli(regression);
    const decision = evaluateStopDecision(regression, { stopHookActive: false });

    expect(cliProjection.exitCode).toBe(1);
    expect(decision.block).toBe(true);
  });

  it('keeps advisory surfaces non-gating while reporting the same verdict', () => {
    const regression = baseResult({ verdict: 'regression', exitCode: 1 });

    const overlay = projectOverlay(regression);
    const selfCheck = projectSelfCheck(regression);
    const helper = assertUsablVerdict(regression, ['verified']);

    expect(overlay.advisory).toBe(true);
    expect(overlay.displayExitCode).toBe(0);
    expect(overlay.verdict).toBe('regression');

    expect(selfCheck.advisoryExitCode).toBe(0);
    expect(selfCheck.verdict).toBe('regression');

    expect(helper.passed).toBe(false);
    expect(helper.exitCode).toBe(1);
    expect(helper.verdict).toBe('regression');
  });

  it('scrubs poison tokens at every projection egress', () => {
    const regression = baseResult({ verdict: 'regression', exitCode: 1 });
    const cliProjection = projectCli(regression);
    const stopDecision = evaluateStopDecision(regression, { stopHookActive: false });
    const prComment = projectPrComment(regression);
    const overlay = projectOverlay(regression);
    const helper = assertUsablVerdict(regression, ['verified']);
    const selfCheck = projectSelfCheck(regression);

    expect(cliProjection.text).not.toContain(POISON);
    expect(cliProjection.json).not.toContain(POISON);
    expect(stopDecision.message).not.toContain(POISON);
    expect(prComment).not.toContain(POISON);
    expect(JSON.stringify(overlay)).not.toContain(POISON);
    expect(JSON.stringify(helper.safeResult)).not.toContain(POISON);
    expect(selfCheck.message).not.toContain(POISON);
  });

  it('keeps verdict-specific gating behavior and stop-hook continuation rules', () => {
    const verified = baseResult({ verdict: 'verified', exitCode: 0 });
    const notCovered = baseResult({ verdict: 'not_covered', exitCode: 3 });
    const approvalRequired = baseResult({ verdict: 'approval_required', exitCode: 2 });
    const regression = baseResult({ verdict: 'regression', exitCode: 1 });

    expect(evaluateStopDecision(verified, { stopHookActive: false }).block).toBe(false);

    expect(projectCli(notCovered).exitCode).toBe(3);
    expect(evaluateStopDecision(notCovered, { stopHookActive: false }).block).toBe(true);

    expect(projectCli(approvalRequired).exitCode).toBe(2);
    expect(evaluateStopDecision(approvalRequired, { stopHookActive: false }).block).toBe(true);

    const continuation = evaluateStopDecision(regression, { stopHookActive: true });
    expect(continuation.block).toBe(false);
    expect(continuation.message).toContain('NOT verified');
  });

  it('propagates schemaVersion through all projected payloads', () => {
    const regression = baseResult({ verdict: 'regression', exitCode: 1 });
    const cliProjection = projectCli(regression);
    const prComment = projectPrComment(regression);
    const overlay = projectOverlay(regression);
    const helper = assertUsablVerdict(regression, ['verified']);

    expect(JSON.parse(cliProjection.json).schemaVersion).toBe('usabl.result.v1');
    expect(prComment).toContain('usabl.result.v1');
    expect(overlay.schemaVersion).toBe('usabl.result.v1');
    expect(helper.safeResult.schemaVersion).toBe('usabl.result.v1');
  });
});

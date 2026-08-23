import { describe, expect, it } from 'vitest';
import type { Result } from '../../src/contracts/index.js';
import { evaluateStopDecision } from '../../src/surfaces/stop-hook.js';

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

describe('evaluateStopDecision', () => {
  it('allows verified results', () => {
    const decision = evaluateStopDecision(
      baseResult({
        verdict: 'verified',
        receipt: {
          schemaVersion: 1,
          sourceTree: 'tree-verified',
          baseRevision: null,
          policyHash: 'hash',
          runnerVersion: '0.0.0-test',
          scannerVersions: { axeCore: '4.13.0', playwright: '1.62.1', chromium: 'revision-123' },
          surfaces: ['cli'],
          coverage: { checked: ['clusters'], notCovered: [] },
          verdict: 'verified',
          findingsSummary: { new: 0, carried: 0, fixed: 0, unverified: 0 },
          activeWaivers: 0,
          mintedAt: '2026-08-23T00:00:00.000Z',
        },
      }),
      { stopHookActive: false },
    );

    expect(decision.block).toBe(false);
    expect(decision.message).toContain('tree-verified');
  });

  it('allows when there is nothing to check', () => {
    const decision = evaluateStopDecision(
      baseResult({
        verdict: null,
        summary: 'nothing to check (no UI-touching files)',
        coverage: {
          changedFiles: [],
          affected: [],
          unresolvedFiles: [],
          gaps: [],
          nothingToCheck: true,
        },
      }),
      { stopHookActive: false },
    );

    expect(decision.block).toBe(false);
    expect(decision.message).toContain('nothing to check');
  });

  it('blocks regression, approval_required, and not_covered', () => {
    const verdicts: Array<'regression' | 'approval_required' | 'not_covered'> = [
      'regression',
      'approval_required',
      'not_covered',
    ];
    for (const verdict of verdicts) {
      const decision = evaluateStopDecision(baseResult({ verdict, summary: `${verdict} summary` }), {
        stopHookActive: false,
      });
      expect(decision.block).toBe(true);
      expect(decision.message.length).toBeGreaterThan(0);
    }
  });

  it('does not block while stop hook continuation is active', () => {
    const decision = evaluateStopDecision(baseResult({ verdict: 'regression' }), { stopHookActive: true });

    expect(decision.block).toBe(false);
    expect(decision.message).toContain('NOT verified');
  });

  it('allows exitCode 4 with explicit disclosure', () => {
    const decision = evaluateStopDecision(
      baseResult({
        verdict: null,
        exitCode: 4,
        summary: 'unhandled error: read ECONNRESET',
      }),
      { stopHookActive: false },
    );

    expect(decision.block).toBe(false);
    expect(decision.message).toContain('NOT verified');
    expect(decision.message).toContain('error');
  });

  it('frames page text and scrubs secret-looking values in block reasons', () => {
    const decision = evaluateStopDecision(
      baseResult({
        verdict: 'regression',
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
            whatUserExperiences: 'Error shown with token=secretvalue',
            why: 'token=secretvalue leaked from page',
            fix: 'Increase contrast',
            evidence: {},
            confidence: 'fail',
            elementKey: 'button-save',
            identityBasis: 'name',
            status: 'new',
          },
        ],
      }),
      { stopHookActive: false },
    );

    expect(decision.block).toBe(true);
    expect(decision.message).toContain('UNTRUSTED PAGE TEXT');
    expect(decision.message).not.toContain('secretvalue');
  });
});

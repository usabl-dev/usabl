import { describe, expect, it } from 'vitest';
import type { Result } from '../../src/contracts/index.js';
import { assertUsablVerdict } from '../../src/surfaces/playwright-helper.js';

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
  accessibilityVerdict: null,
  accessibilityExitCode: 0,
  paidDownCount: 0,
  ...over,
});

describe('assertUsablVerdict', () => {
  it('passes when verdict is in the allowed list', () => {
    const outcome = assertUsablVerdict(baseResult({ verdict: 'verified', exitCode: 0 }), ['verified']);

    expect(outcome.passed).toBe(true);
    expect(outcome.verdict).toBe('verified');
    expect(outcome.exitCode).toBe(0);
  });

  it('fails when verdict is not allowed', () => {
    const outcome = assertUsablVerdict(
      baseResult({ verdict: 'regression', summary: 'regression: 1 new deterministic finding(s)', exitCode: 1 }),
      ['verified'],
    );

    expect(outcome.passed).toBe(false);
    expect(outcome.verdict).toBe('regression');
    expect(outcome.exitCode).toBe(1);
  });

  it('allows not_covered when callers opt into that verdict', () => {
    const outcome = assertUsablVerdict(
      baseResult({ verdict: 'not_covered', summary: 'not_covered: unresolved surfaces', exitCode: 3 }),
      ['verified', 'not_covered'],
    );

    expect(outcome.passed).toBe(true);
    expect(outcome.verdict).toBe('not_covered');
  });

  it('returns a scrubbed safeResult for egress', () => {
    const outcome = assertUsablVerdict(
      baseResult({
        verdict: 'regression',
        exitCode: 1,
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
            whatUserExperiences: 'token=SECRETPOISON in page text',
            why: 'token=SECRETPOISON in explanation',
            fix: 'raise contrast',
            evidence: {},
            confidence: 'fail',
            elementKey: 'k',
            identityBasis: 'name',
            status: 'new',
          },
        ],
      }),
      ['verified'],
    );

    expect(JSON.stringify(outcome.safeResult)).not.toContain('SECRETPOISON');
  });
});

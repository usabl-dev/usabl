import { describe, it, expect } from 'vitest';
import {
  coverageIncomplete,
  decideAccessibilityVerdict,
  notEvaluatedCounts,
} from '../../src/coverage/completeness.js';
import type { CoverageGap } from '../../src/contracts/index.js';

const gap = (over: Partial<CoverageGap> = {}): CoverageGap => ({
  ref: 'provider:pf-rulepack',
  state: 'not-covered',
  reason: 'provider pf-rulepack failed: boom',
  ...over,
});

const coverage = (
  over: Partial<{ unresolvedFiles: string[]; gaps: CoverageGap[] }> = {},
): { unresolvedFiles: string[]; gaps: CoverageGap[] } => ({
  unresolvedFiles: [],
  gaps: [],
  ...over,
});

describe('coverageIncomplete', () => {
  it('calls a run with no unresolved files and no gaps complete', () => {
    expect(coverageIncomplete(coverage())).toBe(false);
  });

  it('calls a run with an unresolved file incomplete', () => {
    expect(coverageIncomplete(coverage({ unresolvedFiles: ['src/Page.tsx'] }))).toBe(true);
  });

  it('calls a run with a coverage gap incomplete', () => {
    expect(coverageIncomplete(coverage({ gaps: [gap()] }))).toBe(true);
  });

  it('calls a run with both an unresolved file and a gap incomplete', () => {
    expect(coverageIncomplete(coverage({ unresolvedFiles: ['src/Page.tsx'], gaps: [gap()] }))).toBe(true);
  });
});

describe('notEvaluatedCounts', () => {
  it('reports zero on both counts for a complete run', () => {
    expect(notEvaluatedCounts(coverage())).toEqual({ unresolvedFiles: 0, gaps: 0 });
  });

  it('counts every unresolved file and every gap', () => {
    const counts = notEvaluatedCounts(
      coverage({
        unresolvedFiles: ['src/Page.tsx', 'src/Other.tsx'],
        gaps: [gap(), gap({ ref: 'clusters', state: 'skipped', reason: 'surface not reachable' })],
      }),
    );

    expect(counts).toEqual({ unresolvedFiles: 2, gaps: 2 });
  });

  it('agrees with coverageIncomplete on the same input', () => {
    const cases = [
      coverage(),
      coverage({ unresolvedFiles: ['src/Page.tsx'] }),
      coverage({ gaps: [gap()] }),
      coverage({ unresolvedFiles: ['src/Page.tsx'], gaps: [gap()] }),
    ];

    for (const input of cases) {
      const counts = notEvaluatedCounts(input);
      expect(coverageIncomplete(input)).toBe(counts.unresolvedFiles > 0 || counts.gaps > 0);
    }
  });
});

describe('decideAccessibilityVerdict', () => {
  it('reports verified and exit 0 for a clean, fully covered run', () => {
    expect(decideAccessibilityVerdict({ hasBlockingFailure: false, hasUnverified: false })).toEqual({
      verdict: 'verified',
      exitCode: 0,
    });
  });

  it('reports not_covered and exit 3 when something was left unverified', () => {
    expect(decideAccessibilityVerdict({ hasBlockingFailure: false, hasUnverified: true })).toEqual({
      verdict: 'not_covered',
      exitCode: 3,
    });
  });

  it('reports regression and exit 1 for a blocking failure', () => {
    expect(decideAccessibilityVerdict({ hasBlockingFailure: true, hasUnverified: false })).toEqual({
      verdict: 'regression',
      exitCode: 1,
    });
  });

  it('lets a blocking failure outrank missing coverage', () => {
    expect(decideAccessibilityVerdict({ hasBlockingFailure: true, hasUnverified: true })).toEqual({
      verdict: 'regression',
      exitCode: 1,
    });
  });
});

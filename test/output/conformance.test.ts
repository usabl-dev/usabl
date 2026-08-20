import { describe, it, expect } from 'vitest';
import { computeConformance } from '../../src/output/conformance.js';
import type { Finding, Result } from '../../src/contracts/index.js';

function finding(over: Partial<Finding>): Finding {
  return {
    rule: 'r', layer: 'axe', severity: 'serious', evidenceClass: 'deterministic',
    screenId: 'clusters', elementPath: 'button', elementName: null, role: 'button',
    whatUserExperiences: '', why: '', fix: '', evidence: {}, confidence: 'fail',
    elementKey: null, identityBasis: 'count', status: 'new', ...over,
  };
}
const result = (over: Partial<Result>): Result => ({
  schemaVersion: 'usabl.result.v1',
  verdict: 'verified', summary: '', screens: [],
  coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
  findings: [], receipt: null, dirtyGuardedPaths: [], exitCode: 0, ...over,
});

describe('computeConformance', () => {
  it('counts deterministic buckets and flags a blocker on a new failure', () => {
    const c = computeConformance(result({
      verdict: 'regression', exitCode: 1,
      findings: [
        finding({ status: 'new', confidence: 'fail' }),
        finding({ status: 'carried' }),
        finding({ status: 'waived' }),
        finding({ status: 'fixed' }),
      ],
    }));
    expect(c.deterministic).toEqual({ newFailures: 1, carried: 1, waived: 1, fixed: 1 });
    expect(c.blocked).toBe(true);
    expect(c.verdict).toBe('regression');
  });

  it('separates judged (model-judgment + preview) from the gating buckets', () => {
    const c = computeConformance(result({
      findings: [
        finding({ evidenceClass: 'model-judgment', status: 'new' }),
        finding({ evidenceClass: 'preview', status: 'new' }),
      ],
    }));
    expect(c.judged).toEqual({ modelJudgment: 1, preview: 1 });
    expect(c.deterministic.newFailures).toBe(0);
    expect(c.blocked).toBe(false); // judged findings never block
  });

  it('surfaces the not-evaluated denominator from coverage', () => {
    const c = computeConformance(result({
      verdict: 'not_covered', exitCode: 3,
      coverage: { changedFiles: ['x'], affected: [], unresolvedFiles: ['a.tsx', 'b.tsx'], gaps: [], nothingToCheck: false },
    }));
    expect(c.notEvaluated.unresolvedFiles).toBe(2);
  });

  it('counts coverage gaps in the not-evaluated bucket', () => {
    const c = computeConformance(result({
      verdict: 'not_covered', exitCode: 3,
      coverage: {
        changedFiles: ['x'], affected: [], unresolvedFiles: [],
        gaps: [
          { ref: 'clusters', state: 'capability-denied', reason: 'static mode: provider needs live' },
          { ref: 'fixtures/app/src/Orphan.tsx', state: 'not-covered', reason: 'file maps to no surface' },
        ],
        nothingToCheck: false,
      },
    }));
    expect(c.notEvaluated.gaps).toBe(2);
    expect(c.notEvaluated.unresolvedFiles).toBe(0);
  });
});

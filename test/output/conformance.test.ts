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
  findings: [], receipt: null, dirtyGuardedPaths: [], exitCode: 0,
  accessibilityVerdict: null, accessibilityExitCode: 0, paidDownCount: 0, floorHeadroom: [], ...over,
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
    expect(c.deterministic).toEqual({
      new: 1, newFailing: 1, newUnconfirmed: 0, carried: 1, waived: 1, fixed: 1,
    });
    expect(c.blocked).toBe(true);
    expect(c.verdict).toBe('regression');
  });

  it('counts every new deterministic finding, not only the failing ones', () => {
    // The rehearsal case: three new deterministic findings, two unconfirmed and one failing. The
    // headline used to count the one failure and sit directly above a list of three.
    const c = computeConformance(result({
      verdict: 'regression', exitCode: 1,
      findings: [
        finding({ status: 'new', confidence: 'unverified', rule: 'a' }),
        finding({ status: 'new', confidence: 'unverified', rule: 'b' }),
        finding({ status: 'new', confidence: 'fail', rule: 'c' }),
      ],
    }));

    expect(c.deterministic.new).toBe(3);
    expect(c.deterministic.newFailing).toBe(1);
    expect(c.deterministic.newUnconfirmed).toBe(2);
    // The split adds up to the headline, so the parenthetical can never contradict it either.
    expect(c.deterministic.newFailing + c.deterministic.newUnconfirmed).toBe(c.deterministic.new);
  });

  it('reports a run held at not_covered by unconfirmed findings as blocked', () => {
    // `blocked` was recomputed from new failures, so a run with no failing finding said "no"
    // while the gate had stopped the work at exit 3 and the heading above it said NOT COVERED.
    const c = computeConformance(result({
      verdict: 'not_covered', exitCode: 3,
      findings: [finding({ status: 'new', confidence: 'unverified' })],
    }));

    expect(c.deterministic.new).toBe(1);
    expect(c.deterministic.newFailing).toBe(0);
    expect(c.blocked).toBe(true);
  });

  it('reports a crashed run as blocked, because a run that proved nothing is not a pass', () => {
    const c = computeConformance(result({ verdict: null, exitCode: 4, findings: [] }));

    expect(c.blocked).toBe(true);
  });

  it('reports an idle run as not blocked', () => {
    const c = computeConformance(result({ verdict: null, exitCode: 0, findings: [] }));

    expect(c.blocked).toBe(false);
  });

  it('separates judged (model-judgment + preview) from the gating buckets', () => {
    const c = computeConformance(result({
      findings: [
        finding({ evidenceClass: 'model-judgment', status: 'new' }),
        finding({ evidenceClass: 'preview', status: 'new' }),
      ],
    }));
    expect(c.judged).toEqual({ modelJudgment: 1, preview: 1 });
    expect(c.deterministic.new).toBe(0);
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

/**
 * The page helper and the gate must never disagree about precedence.
 *
 * summarizePageCheck used to carry its own copy of the ordering. Editing the gate and missing
 * that copy would have been silently wrong, and no test would have caught it. This table drives
 * the same logical inputs through both and demands the same verdict, and it pins the exit code
 * to a literal so a change to the shared decision cannot move both sides at once.
 *
 * These cases are built so the two callers see the same blocking failures: an empty floor, no
 * waivers, and deterministic drafts only. Off that ground the two can legitimately differ, since
 * a page check has no floor to call a barrier already accepted.
 */
import { describe, it, expect } from 'vitest';
import { gate } from '../../src/gate/index.js';
import { decideAccessibilityVerdict } from '../../src/coverage/completeness.js';
import { summarizePageCheck } from '../../src/surfaces/playwright-helper.js';
import type { Coverage, CoverageGap, Draft, EvidenceFloor } from '../../src/contracts/index.js';

const emptyFloor: EvidenceFloor = { version: 1, entries: [] };
const base = {
  guardDivergedPaths: [] as string[],
  floor: emptyFloor,
  waivers: [],
  now: '2026-01-01T00:00:00.000Z',
  cleanlyScannedScreens: new Set<string>(),
};

function d(over: Partial<Draft>): Draft {
  return {
    rule: 'r',
    layer: 'axe',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId: 'clusters',
    elementPath: 'button',
    elementName: 'Save',
    role: 'button',
    whatUserExperiences: '',
    why: '',
    fix: '',
    evidence: { name: { value: 'Save', source: 'ax-tree', fromTree: true } },
    confidence: 'fail',
    ...over,
  };
}

const gap = (over: Partial<CoverageGap> = {}): CoverageGap => ({
  ref: 'provider:pf-rulepack',
  state: 'not-covered',
  reason: 'provider pf-rulepack failed: boom',
  ...over,
});

function coverageFor(gaps: CoverageGap[]): Coverage {
  return {
    changedFiles: ['fixtures/app/src/ClustersPage.tsx'],
    affected: [{ screenId: 'clusters', url: 'http://x/clusters', provenance: 'manual' }],
    unresolvedFiles: [],
    gaps,
    nothingToCheck: false,
  };
}

const failure = d({ rule: 'button-name', confidence: 'fail' });
const unverified = d({ rule: 'color-contrast', elementName: 'Cancel', confidence: 'unverified' });

interface AgreementCase {
  name: string;
  drafts: Draft[];
  gaps: CoverageGap[];
  expectedVerdict: 'verified' | 'regression' | 'not_covered';
  // A literal on purpose. Reading this back off the shared decision would move both sides of the
  // comparison together and let a changed exit code pass unnoticed.
  expectedExit: 0 | 1 | 3;
}

const cases: AgreementCase[] = [
  { name: 'clean page, nothing missing', drafts: [], gaps: [], expectedVerdict: 'verified', expectedExit: 0 },
  { name: 'a deterministic fail alone', drafts: [failure], gaps: [], expectedVerdict: 'regression', expectedExit: 1 },
  { name: 'an unverified draft alone', drafts: [unverified], gaps: [], expectedVerdict: 'not_covered', expectedExit: 3 },
  { name: 'a coverage gap alone', drafts: [], gaps: [gap()], expectedVerdict: 'not_covered', expectedExit: 3 },
  {
    name: 'an unverified draft and a coverage gap',
    drafts: [unverified],
    gaps: [gap()],
    expectedVerdict: 'not_covered',
    expectedExit: 3,
  },
  // The case a one-sided edit would break: a gap must never demote a real new barrier.
  {
    name: 'a deterministic fail plus a coverage gap',
    drafts: [failure],
    gaps: [gap()],
    expectedVerdict: 'regression',
    expectedExit: 1,
  },
  {
    name: 'a deterministic fail plus an unverified draft plus a coverage gap',
    drafts: [failure, unverified],
    gaps: [gap()],
    expectedVerdict: 'regression',
    expectedExit: 1,
  },
];

describe('summarizePageCheck agrees with gate', () => {
  for (const testCase of cases) {
    it(`reports the same verdict and exit code for ${testCase.name}`, () => {
      const page = summarizePageCheck(testCase.drafts, testCase.gaps);
      const gated = gate({ ...base, coverage: coverageFor(testCase.gaps), drafts: testCase.drafts });

      expect(page.verdict).toBe(testCase.expectedVerdict);
      expect(gated.accessibilityVerdict).toBe(testCase.expectedVerdict);
      expect(page.verdict).toBe(gated.accessibilityVerdict);

      expect(gated.accessibilityExitCode).toBe(testCase.expectedExit);

      // The helper reports no exit code of its own. Ask the shared decision what the helper's own
      // inputs earn, and hold that to the same literal the gate was held to.
      const decided = decideAccessibilityVerdict({
        hasBlockingFailure: page.failures.length > 0,
        hasUnverified: page.needsReview.length > 0 || page.gaps.length > 0,
      });

      expect(decided.verdict).toBe(page.verdict);
      expect(decided.exitCode).toBe(testCase.expectedExit);
    });
  }
});

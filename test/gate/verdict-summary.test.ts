/**
 * The verdict summary is often the only line an operator reads. It has to say what blocked the
 * run, not just how many findings there were.
 *
 * The reported defect: a run blocked because screens went unchecked said
 * "not_covered: 0 gating finding(s)", which names a count of zero and no cause at all. The rule
 * these tests hold the summary to is that the line alone tells you whether the block came from a
 * finding or from coverage the run never reached.
 */
import { describe, it, expect } from 'vitest';
import { gate } from '../../src/gate/index.js';
import type { Coverage, CoverageGap, Draft, EvidenceFloor } from '../../src/contracts/index.js';

const emptyFloor: EvidenceFloor = { version: 1, entries: [] };
const base = {
  guardDivergedPaths: [] as string[],
  floor: emptyFloor,
  waivers: [],
  now: '2026-01-01T00:00:00.000Z',
};

function d(over: Partial<Draft> = {}): Draft {
  return {
    rule: 'button-name',
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
  ref: 'clusters',
  state: 'not-covered',
  reason: 'provider pf-rulepack failed: boom',
  ...over,
});

function coverage(over: Partial<Coverage> = {}): Coverage {
  return {
    changedFiles: ['fixtures/app/src/ClustersPage.tsx'],
    affected: [{ screenId: 'clusters', url: 'http://x/clusters', provenance: 'manual' }],
    unresolvedFiles: [],
    gaps: [],
    nothingToCheck: false,
    ...over,
  };
}

describe('verdict summary names unseen coverage', () => {
  it('names the gaps that held back a run with no findings at all', () => {
    // The case the operator complained about. "0 gating finding(s)" on its own reads as a bug in
    // the tool, because the number it reports is not the reason the run blocked.
    const out = gate({
      ...base,
      coverage: coverage({ gaps: [gap(), gap({ ref: 'jobs' })] }),
      drafts: [],
    });

    expect(out.accessibilityVerdict).toBe('not_covered');
    expect(out.accessibilityExitCode).toBe(3);
    expect(out.summary).toBe('not_covered: 0 gating finding(s), 2 gap(s)');
  });

  it('still names unseen coverage when a new failure sets the verdict', () => {
    // Precedence is unchanged: the failure wins the verdict. The summary has to disclose that the
    // run was also incomplete, or the operator fixes the barrier and believes the run was whole.
    const out = gate({
      ...base,
      coverage: coverage({ gaps: [gap()] }),
      drafts: [d()],
    });

    expect(out.accessibilityVerdict).toBe('regression');
    expect(out.accessibilityExitCode).toBe(1);
    expect(out.summary).toBe('regression: 1 gating finding(s), 1 gap(s)');
  });

  it('says nothing about coverage on a clean run that reached everything', () => {
    const out = gate({ ...base, coverage: coverage(), drafts: [] });

    expect(out.accessibilityVerdict).toBe('verified');
    expect(out.summary).toBe('verified: 0 gating finding(s)');
    expect(out.summary).not.toContain('gap');
  });

  it('counts a file it could not map to a screen once, not twice', () => {
    // Both coverage planners record an unmapped file in unresolvedFiles and disclose the same
    // file as a gap. Adding the two counts would report one problem as two.
    const out = gate({
      ...base,
      coverage: coverage({
        affected: [],
        unresolvedFiles: ['fixtures/app/src/Orphan.tsx'],
        gaps: [
          gap({
            ref: 'fixtures/app/src/Orphan.tsx',
            state: 'unresolved',
            reason: 'changed UI file was not in any route closure, wide-blast glob, or manual surface mapping',
          }),
        ],
      }),
      drafts: [],
    });

    expect(out.accessibilityVerdict).toBe('not_covered');
    expect(out.summary).toBe('not_covered: 0 gating finding(s), 1 gap(s)');
  });

  it('blocks on an unverified finding without inventing coverage language', () => {
    // not_covered can also come from a finding usabl could not confirm. That is a finding cause,
    // not a coverage cause, and the summary must not suggest a screen went unvisited.
    const out = gate({
      ...base,
      coverage: coverage(),
      drafts: [d({ confidence: 'unverified' })],
    });

    expect(out.accessibilityVerdict).toBe('not_covered');
    expect(out.summary).toBe('not_covered: 1 gating finding(s)');
    expect(out.summary).not.toContain('gap');
  });

  it('names an unmapped file even if it was never paired with a gap', () => {
    // Both planners disclose an unmapped file as a gap as well, so this coverage shape does not
    // arise today. The gate is held to it anyway: the promise that a blocked run names its cause
    // should not depend on a pairing rule that lives in another module.
    const out = gate({
      ...base,
      coverage: coverage({ affected: [], unresolvedFiles: ['src/Orphan.tsx'], gaps: [] }),
      drafts: [],
    });

    expect(out.accessibilityVerdict).toBe('not_covered');
    expect(out.summary).toBe('not_covered: 0 gating finding(s), 1 unmapped file(s)');
  });

  it('never reports not_covered without naming a cause', () => {
    // not_covered is reachable through a finding or through coverage, and every route now leaves
    // a trace in the line. The bare string the defect produced can no longer be built.
    const coverages: Coverage[] = [
      coverage(),
      coverage({ gaps: [gap()] }),
      coverage({ affected: [], unresolvedFiles: ['src/Orphan.tsx'], gaps: [gap({ state: 'unresolved' })] }),
      coverage({ affected: [], unresolvedFiles: ['src/Orphan.tsx'], gaps: [] }),
    ];
    const draftSets: Draft[][] = [[], [d({ confidence: 'unverified' })], [d()]];

    let sawNotCovered = false;
    for (const cov of coverages) {
      for (const drafts of draftSets) {
        const out = gate({ ...base, coverage: cov, drafts });
        if (out.accessibilityVerdict !== 'not_covered') {
          continue;
        }
        sawNotCovered = true;
        expect(out.summary).not.toBe('not_covered: 0 gating finding(s)');
      }
    }

    // Guard the guard: a loop that never reached the verdict would pass while proving nothing.
    expect(sawNotCovered).toBe(true);
  });
});

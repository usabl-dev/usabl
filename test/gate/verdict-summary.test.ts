/**
 * The verdict summary is often the only line an operator reads, and the only one a model is given
 * on the stop hook and the self check. It has to say what blocked the run, not just how many
 * findings there were, and every number in it has to mean what the verdict means.
 *
 * The first reported defect: a run blocked because screens went unchecked said
 * "not_covered: 0 gating finding(s)", which names a count of zero and no cause at all. The rule
 * these tests hold the summary to is that the line alone tells you whether the block came from a
 * finding or from coverage the run never reached.
 *
 * The second: the count called gating held carried debt, which does not gate. A verified run
 * carrying an accepted floor read "verified: 29 gating finding(s)" while the panel under it said
 * none of the 29 blocked anything. The line and the surface contradicted each other on one
 * screen. The count is now the blocking set, the set the verdict itself was decided from, and
 * accepted debt is named separately.
 */
import { describe, it, expect } from 'vitest';
import { gate } from '../../src/gate/index.js';
import { computeIdentity } from '../../src/primitives/identity.js';
import type { Coverage, CoverageGap, Draft, EvidenceFloor, Waiver } from '../../src/contracts/index.js';

const emptyFloor: EvidenceFloor = { version: 1, entries: [] };
const base = {
  guardDivergedPaths: [] as string[],
  floor: emptyFloor,
  waivers: [],
  now: '2026-01-01T00:00:00.000Z',
  cleanlyScannedScreens: new Set<string>(),
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
    expect(out.summary).toBe('not_covered: nothing blocking, 2 gap(s)');
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
    expect(out.summary).toBe('regression: 1 blocking finding(s), 1 gap(s)');
  });

  it('says nothing about coverage on a clean run that reached everything', () => {
    const out = gate({ ...base, coverage: coverage(), drafts: [] });

    expect(out.accessibilityVerdict).toBe('verified');
    expect(out.summary).toBe('verified: nothing blocking');
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
    expect(out.summary).toBe('not_covered: nothing blocking, 1 gap(s)');
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
    expect(out.summary).toBe('not_covered: 1 blocking finding(s)');
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
    expect(out.summary).toBe('not_covered: nothing blocking, 1 unmapped file(s)');
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
        expect(out.summary).not.toBe('not_covered: nothing blocking');
      }
    }

    // Guard the guard: a loop that never reached the verdict would pass while proving nothing.
    expect(sawNotCovered).toBe(true);
  });
});

// A floor that accepts exactly the drafts handed to it, so those findings come back carried.
function floorAccepting(drafts: Draft[]): EvidenceFloor {
  return {
    version: 2,
    entries: drafts.map((draft) => {
      const identity = computeIdentity(draft);
      return {
        screenId: draft.screenId,
        layer: draft.layer,
        rule: draft.rule,
        elementKey: identity.elementKey,
        identityBasis: identity.identityBasis,
        count: 1,
      };
    }),
  };
}

const waiverFor = (rule: string): Waiver => ({
  rule,
  surface: 'clusters',
  scope: '*',
  reason: 'tracked',
  owner: 'team',
  approvedBy: 'owner',
  created: '2025-01-01T00:00:00.000Z',
  expires: '2027-01-01T00:00:00.000Z',
});

describe('verdict summary counts only what blocks', () => {
  it('says nothing is blocking on a verified run that carries an accepted floor', () => {
    // The line as it appears under a VERIFIED verdict on a real application. It used to read
    // "verified: 29 gating finding(s)" while the panel below it said none of the 29 blocked.
    const drafts = Array.from({ length: 29 }, (_, i) => d({ rule: `rule-${i}` }));
    const out = gate({ ...base, floor: floorAccepting(drafts), coverage: coverage(), drafts });

    expect(out.accessibilityVerdict).toBe('verified');
    expect(out.summary).toBe('verified: nothing blocking, 29 recorded');
    // The word the surfaces reserve for work never attaches to a number on a verified run.
    expect(out.summary).not.toMatch(/\d+ blocking/);
  });

  it('counts the new finding as blocking and the floor as recorded on a regression', () => {
    const carried = Array.from({ length: 29 }, (_, i) => d({ rule: `rule-${i}` }));
    const out = gate({
      ...base,
      floor: floorAccepting(carried),
      coverage: coverage(),
      drafts: [...carried, d({ rule: 'brand-new' })],
    });

    expect(out.accessibilityVerdict).toBe('regression');
    // One barrier caused this verdict, so the line says one. It used to say 30.
    expect(out.summary).toBe('regression: 1 blocking finding(s), 29 recorded');
  });

  it('counts a waived finding as recorded, the way every surface groups it', () => {
    // The terminal report and the inspector panel list carried and waived together under
    // "recorded, not blocking". The gate's own line has to reach the same number they do.
    const out = gate({
      ...base,
      coverage: coverage(),
      drafts: [d({ rule: 'waived-rule' })],
      waivers: [waiverFor('waived-rule')],
    });

    expect(out.accessibilityVerdict).toBe('verified');
    expect(out.summary).toBe('verified: nothing blocking, 1 recorded');
  });

  it('leaves the recorded clause off a run with no accepted debt', () => {
    // Same rule the gap clause follows: inventing "0 recorded" on every clean run teaches the
    // reader to skip the clause on the runs where it carries something.
    const out = gate({ ...base, coverage: coverage(), drafts: [] });

    expect(out.summary).toBe('verified: nothing blocking');
    expect(out.summary).not.toContain('recorded');
  });

  it('never reports a blocking count the verdict does not support', () => {
    // The contradiction, stated as an invariant over every shape these tests build: a verified
    // run never names a blocking finding, and a blocked run always does or names its coverage.
    const carried = [d({ rule: 'carried-fail' }), d({ rule: 'carried-unsure', confidence: 'unverified' })];
    const shapes: Array<{ drafts: Draft[]; floor: EvidenceFloor; cov: Coverage }> = [
      { drafts: [], floor: emptyFloor, cov: coverage() },
      { drafts: carried, floor: floorAccepting(carried), cov: coverage() },
      { drafts: carried, floor: floorAccepting(carried), cov: coverage({ gaps: [gap()] }) },
      { drafts: [...carried, d({ rule: 'new-fail' })], floor: floorAccepting(carried), cov: coverage() },
      { drafts: [...carried, d({ rule: 'new-unsure', confidence: 'unverified' })], floor: floorAccepting(carried), cov: coverage() },
    ];

    let sawVerified = false;
    let sawBlocked = false;
    for (const shape of shapes) {
      const out = gate({ ...base, floor: shape.floor, coverage: shape.cov, drafts: shape.drafts });
      if (out.accessibilityVerdict === 'verified') {
        sawVerified = true;
        expect(out.summary).toContain('nothing blocking');
      } else {
        sawBlocked = true;
        expect(out.summary).toMatch(/\d+ blocking finding\(s\)|\d+ gap\(s\)|\d+ unmapped file\(s\)/);
      }
    }

    // Guard the guard: a loop that reached only one side would pass while proving half of it.
    expect(sawVerified).toBe(true);
    expect(sawBlocked).toBe(true);
  });
});

/**
 * Pins the shared barrier predicate against the gate.
 *
 * `isBlockingBarrier` decides what a surface lists as a barrier and, before that, what it may
 * tell a reader to go and fix. The gate decides what blocks. Those two answers have to be the
 * same answer, and they are written in two places: the gate keeps its own expression over its
 * drafts, and the surfaces share this predicate over the findings the gate returned.
 *
 * So the pin is an equivalence, driven through the gate with the gate's own inputs: on a run
 * whose coverage is complete, the gate calls the accessibility half verified exactly when no
 * finding it returned is a blocking barrier. Coverage has to be complete for the equivalence to
 * be about findings at all, because a gap alone also holds a run at not_covered.
 *
 * A change to either side breaks this. Widening the predicate to include carried debt fails the
 * carried case, because the gate calls that run verified. Narrowing it to drop a finding usabl
 * could not verify fails the unverified case, because the gate does not call that run verified.
 */
import { describe, expect, it } from 'vitest';
import { gate } from '../../src/gate/index.js';
import { isBlockingBarrier } from '../../src/output/disclosure.js';
import type { Coverage, Draft, EvidenceFloor, GateInput, Waiver } from '../../src/contracts/index.js';

const complete: Coverage = {
  changedFiles: ['src/ClustersPage.tsx'],
  affected: [{ screenId: 'clusters', url: 'http://127.0.0.1:5173/clusters', provenance: 'manual' }],
  unresolvedFiles: [],
  gaps: [],
  nothingToCheck: false,
};

const draft = (over: Partial<Draft> = {}): Draft => ({
  rule: 'color-contrast',
  layer: 'axe',
  severity: 'serious',
  evidenceClass: 'deterministic',
  screenId: 'clusters',
  elementPath: 'button',
  elementName: 'Save',
  role: 'button',
  whatUserExperiences: 'Low contrast text',
  why: '',
  fix: 'Raise contrast to 4.5:1',
  evidence: { name: { value: 'Save', source: 'ax-tree', fromTree: true } },
  confidence: 'fail',
  ...over,
});

// The floor identity the default draft collapses to, so a run against this floor carries it as
// accepted debt rather than as a new barrier.
const flooredEntry = {
  screenId: 'clusters',
  layer: 'axe',
  rule: 'color-contrast',
  elementKey: 'clusters|color-contrast|name:save',
  identityBasis: 'name' as const,
  count: 1,
};
const emptyFloor: EvidenceFloor = { version: 1, entries: [] };
const flooredOnce: EvidenceFloor = { version: 1, entries: [flooredEntry] };

const waiver: Waiver = {
  rule: 'color-contrast',
  surface: 'clusters',
  scope: 'clusters|color-contrast|name:save',
  reason: 'tracked',
  owner: 'team',
  approvedBy: 'owner',
  created: '2026-01-01T00:00:00.000Z',
  expires: '2026-12-31T00:00:00.000Z',
};

const base: Omit<GateInput, 'drafts' | 'floor'> = {
  coverage: complete,
  guardDivergedPaths: [],
  waivers: [],
  now: '2026-06-01T00:00:00.000Z',
  cleanlyScannedScreens: new Set(['clusters']),
};

// Each case names the state it produces so a failure says which one drifted.
const CASES: ReadonlyArray<{
  name: string;
  input: GateInput;
  status: string | null;
  verified: boolean;
}> = [
  { name: 'a clean run', input: { ...base, drafts: [], floor: emptyFloor }, status: null, verified: true },
  {
    name: 'a new failing finding',
    input: { ...base, drafts: [draft()], floor: emptyFloor },
    status: 'new',
    verified: false,
  },
  {
    name: 'a finding usabl could not verify',
    input: { ...base, drafts: [draft({ confidence: 'unverified' })], floor: emptyFloor },
    status: 'new',
    verified: false,
  },
  {
    name: 'accepted debt already in the floor',
    input: { ...base, drafts: [draft()], floor: flooredOnce },
    status: 'carried',
    verified: true,
  },
  {
    name: 'accepted debt usabl could not verify this run',
    input: { ...base, drafts: [draft({ confidence: 'unverified' })], floor: flooredOnce },
    status: 'carried',
    verified: false,
  },
  {
    name: 'a waived finding',
    input: { ...base, drafts: [draft()], floor: emptyFloor, waivers: [waiver] },
    status: 'waived',
    verified: true,
  },
  {
    name: 'a floored finding that is gone from a cleanly scanned screen',
    input: { ...base, drafts: [], floor: flooredOnce },
    status: 'fixed',
    verified: true,
  },
  {
    name: 'an advisory finding, which never gates',
    input: { ...base, drafts: [draft({ evidenceClass: 'preview' })], floor: emptyFloor },
    status: 'new',
    verified: true,
  },
];

describe('isBlockingBarrier against the gate', () => {
  for (const entry of CASES) {
    it(`agrees with the gate on ${entry.name}`, () => {
      const out = gate(entry.input);
      const barriers = out.findings.filter(isBlockingBarrier);

      // The case really produced the state it claims, so a drift in status assignment is not
      // mistaken for agreement.
      expect(out.findings[0]?.status ?? null).toBe(entry.status);
      expect(out.accessibilityVerdict === 'verified').toBe(entry.verified);
      // The equivalence itself.
      expect(barriers.length === 0).toBe(out.accessibilityVerdict === 'verified');
    });
  }

  it('never calls accepted debt a barrier, which is what a reader would be sent to fix', () => {
    const out = gate({ ...base, drafts: [draft()], floor: flooredOnce });

    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]!.status).toBe('carried');
    expect(out.accessibilityVerdict).toBe('verified');
    expect(isBlockingBarrier(out.findings[0]!)).toBe(false);
  });

  it('calls a finding it could not verify a barrier, because the run is not verified either', () => {
    const out = gate({ ...base, drafts: [draft({ confidence: 'unverified' })], floor: flooredOnce });

    expect(out.accessibilityVerdict).toBe('not_covered');
    expect(out.findings.some(isBlockingBarrier)).toBe(true);
  });
});

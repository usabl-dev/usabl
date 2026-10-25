/**
 * The gate with row-scoped identities.
 *
 * The proven false green: a floor accepted two unnamed icon buttons at one collapsed identity, one
 * was fixed, a new one arrived in another row, the count stayed at two, and the run was verified
 * with a receipt. With a key per row the new one has an identity the floor never accepted.
 *
 * A floor written before row keys existed (version 2) recorded those buttons collapsed across rows.
 * Comparing it with the new keys would read every recorded row barrier as new and the old entry as
 * fixed. So the gate compares a version 2 floor with the keys it was written with, and says the run
 * cannot rule out a barrier hiding behind an accepted one in another row until the floor is
 * regenerated.
 */
import { describe, expect, it } from 'vitest';
import { gate } from '../../src/gate/index.js';
import { computeIdentity } from '../../src/primitives/identity.js';
import type { Coverage, Draft, EvidenceFloor, FloorEntry, GateInput } from '../../src/contracts/index.js';

function buttonInRow(row: string, screenId = 'jobs'): Draft {
  return {
    rule: 'pf-icon-button-name', layer: 'pf', severity: 'serious', evidenceClass: 'deterministic',
    screenId, elementPath: 'main > table > tbody > tr > td > button', elementName: null, role: 'button',
    whatUserExperiences: 'A button action is announced without a usable name.', why: '', fix: '',
    evidence: {
      extra: { rowScope: { table: 'main>table', row, role: 'button', path: 'td:nth-child(4) > button:nth-child(1)' } },
    },
    confidence: 'fail',
  };
}

const ROW_A = 'aaaaaaaaaaaaaaaa';
const ROW_B = 'bbbbbbbbbbbbbbbb';
const ROW_C = 'cccccccccccccccc';

const covered: Coverage = {
  changedFiles: ['src/JobsPage.tsx'],
  affected: [
    { screenId: 'jobs', url: 'http://x/jobs', provenance: 'manual' },
    { screenId: 'users', url: 'http://x/users', provenance: 'manual' },
  ],
  unresolvedFiles: [], gaps: [], nothingToCheck: false,
};

const base: Omit<GateInput, 'drafts' | 'floor'> = {
  coverage: covered,
  guardDivergedPaths: [],
  waivers: [],
  now: '2026-01-01T00:00:00.000Z',
  cleanlyScannedScreens: new Set(['jobs', 'users']),
};

function entryFor(draft: Draft, count = 1): FloorEntry {
  const identity = computeIdentity(draft);
  return {
    screenId: draft.screenId, layer: draft.layer, rule: draft.rule,
    elementKey: identity.elementKey, identityBasis: identity.identityBasis, count,
  };
}

describe('row-scoped identities in the gate', () => {
  it('blocks a new barrier in another row after one recorded row was fixed', () => {
    const floor: EvidenceFloor = { version: 3, entries: [entryFor(buttonInRow(ROW_A)), entryFor(buttonInRow(ROW_B))] };

    // Row A was fixed. Row B is unchanged. Row C is new and broken. Two barriers, as before.
    const out = gate({ ...base, floor, drafts: [buttonInRow(ROW_B), buttonInRow(ROW_C)] });

    expect(out.accessibilityVerdict).toBe('regression');
    const statuses = out.findings.map((f) => f.status).sort();
    expect(statuses).toEqual(['carried', 'fixed', 'new']);
  });

  it('stays verified when a recorded row is simply not on the page today', () => {
    const floor: EvidenceFloor = { version: 3, entries: [entryFor(buttonInRow(ROW_A)), entryFor(buttonInRow(ROW_B))] };

    const out = gate({ ...base, floor, drafts: [buttonInRow(ROW_B)] });

    expect(out.accessibilityVerdict).toBe('verified');
    expect(out.floorHeadroom).toEqual([{ screenId: 'jobs', rule: 'pf-icon-button-name', recorded: 1, observed: 0 }]);
  });

  it('compares a version 2 floor with its own keys and discloses that it predates row keys', () => {
    // What a version 2 baseline wrote for two unnamed buttons: one count entry at two.
    const legacy = computeIdentity(buttonInRow(ROW_A), 'legacy');
    const floor: EvidenceFloor = {
      version: 2,
      entries: [{ screenId: 'jobs', layer: 'pf', rule: 'pf-icon-button-name', elementKey: legacy.elementKey, identityBasis: legacy.identityBasis, count: 2 }],
    };

    const out = gate({ ...base, floor, drafts: [buttonInRow(ROW_A), buttonInRow(ROW_B)] });

    // Not new: the old floor accepted both. Not fixed: the old entry is still matched.
    expect(out.findings.map((f) => f.status)).toEqual(['carried']);
    expect(out.findings[0]!.identityBasis).toBe('count');
    // But the run cannot prove that one of the two is not a new barrier in another row.
    expect(out.accessibilityVerdict).toBe('not_covered');
    expect(out.floorGaps).toHaveLength(1);
    expect(out.floorGaps[0]!.ref).toBe('.usabl-evidence.json');
    expect(out.floorGaps[0]!.reason).toContain('version 2');
    expect(out.floorGaps[0]!.reason).toContain('usabl baseline');
    expect(out.summary).toContain('1 gap(s)');
  });

  it('reports a new barrier on a version 2 floor as new, the way the old keys see it', () => {
    const legacy = computeIdentity(buttonInRow(ROW_A), 'legacy');
    const floor: EvidenceFloor = {
      version: 2,
      entries: [{ screenId: 'jobs', layer: 'pf', rule: 'pf-icon-button-name', elementKey: legacy.elementKey, identityBasis: legacy.identityBasis, count: 1 }],
    };

    const out = gate({ ...base, floor, drafts: [buttonInRow(ROW_A), buttonInRow(ROW_B)] });

    expect(out.accessibilityVerdict).toBe('regression');
  });

  it('adds no gap to a version 2 floor when no barrier sits in a keyed row', () => {
    const plain: Draft = { ...buttonInRow(ROW_A), evidence: {} };
    const floor: EvidenceFloor = { version: 2, entries: [entryFor(plain)] };

    const out = gate({ ...base, floor, drafts: [plain] });

    expect(out.accessibilityVerdict).toBe('verified');
    expect(out.floorGaps).toEqual([]);
  });

  it('adds no gap when the version 2 entries are on other screens than the keyed rows', () => {
    const plain: Draft = { ...buttonInRow(ROW_A, 'users'), evidence: {} };
    const floor: EvidenceFloor = { version: 2, entries: [entryFor(plain)] };

    const out = gate({ ...base, floor, drafts: [plain, buttonInRow(ROW_B)] });

    expect(out.floorGaps).toEqual([]);
    // The row on jobs is new against a floor that holds nothing for jobs.
    expect(out.accessibilityVerdict).toBe('regression');
  });

  it('keys rows separately against an empty floor', () => {
    const out = gate({ ...base, floor: { version: 2, entries: [] }, drafts: [buttonInRow(ROW_A), buttonInRow(ROW_B)] });

    expect(out.findings).toHaveLength(2);
    expect(out.findings.every((f) => f.identityBasis === 'row')).toBe(true);
    expect(out.floorGaps).toEqual([]);
  });
});

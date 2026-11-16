/**
 * A keyboard walk that was cut short is a coverage gap, never debt. A floor written before that
 * rule can still hold an entry for one, and a library caller can still hand the gate such a draft.
 * The gate never carries one and never claims one fixed: the entry is read as a not-covered gap
 * that names the command which rewrites the floor.
 */
import { describe, expect, it } from 'vitest';
import { gate } from '../../src/gate/index.js';
import type { Coverage, Draft, EvidenceFloor, GateInput } from '../../src/contracts/index.js';

const covered: Coverage = {
  changedFiles: ['x'],
  affected: [{ screenId: 'jobs', url: 'u', provenance: 'manual' }],
  unresolvedFiles: [],
  gaps: [],
  nothingToCheck: false,
};

const TRUNCATED_ENTRY = { screenId: 'jobs', layer: 'walk', rule: 'keyboard-walk-truncated', elementKey: null, identityBasis: 'count' as const, count: 1 };

function truncatedDraft(): Draft {
  return {
    rule: 'keyboard-walk-truncated',
    layer: 'walk',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId: 'jobs',
    elementPath: '',
    elementName: null,
    role: null,
    whatUserExperiences: '',
    why: '',
    fix: '',
    evidence: {},
    confidence: 'unverified',
  };
}

function input(floor: EvidenceFloor, drafts: Draft[] = []): GateInput {
  return {
    coverage: covered,
    guardDivergedPaths: [],
    drafts,
    floor,
    waivers: [],
    now: '2026-01-01T00:00:00.000Z',
    cleanlyScannedScreens: new Set(['jobs']),
    renderEvidence: new Map([['jobs', { signalHeld: true, elementSlots: new Set<string>() }]]),
  };
}

describe('a floor entry for a keyboard walk that was cut short', () => {
  it('is a not-covered gap that names usabl baseline, and is never claimed fixed', () => {
    const out = gate(input({ version: 3, entries: [TRUNCATED_ENTRY] }));

    expect(out.verdict).toBe('not_covered');
    expect(out.findings).toEqual([]);
    expect(out.floorHeadroom).toEqual([]);
    expect(out.floorUnconfirmed).toEqual([]);
    expect(out.floorGaps).toHaveLength(1);
    expect(out.floorGaps[0]).toMatchObject({ ref: '.usabl-evidence.json', state: 'not-covered' });
    expect(out.floorGaps[0]?.reason).toContain('screen jobs');
    expect(out.floorGaps[0]?.reason).toContain('Run "usabl baseline"');
  });

  it('never carries a cut short walk, so such a draft blocks as new', () => {
    const out = gate(input({ version: 3, entries: [TRUNCATED_ENTRY] }, [truncatedDraft()]));

    expect(out.verdict).toBe('not_covered');
    expect(out.findings.map((f) => [f.rule, f.status])).toEqual([['keyboard-walk-truncated', 'new']]);
  });

  it('adds no gap for a floor with no such entry', () => {
    const out = gate(input({ version: 3, entries: [] }));

    expect(out.verdict).toBe('verified');
    expect(out.floorGaps).toEqual([]);
  });
});

/**
 * The exported gate() checks its own input. The file readers validate the floor and the ids they
 * read, but a library caller can build a GateInput by hand and skip them. These tests hand the
 * gate the inputs a file reader would refuse and expect a typed refusal that names the field and
 * its position, and never repeats the refused value.
 */
import { describe, expect, it } from 'vitest';
import { gate } from '../../src/gate/index.js';
import { InputRefusedError } from '../../src/intake/input-refusal.js';
import type { Coverage, Draft, EvidenceFloor, FloorEntry, GateInput, Waiver } from '../../src/contracts/index.js';

// Visible text joined by a zero-width space. The grammar refuses the joiner, and the visible part
// is what a message must never repeat back.
const BAD_ID = 'leak-me​now';
const LEAK = 'leak-me';

const coverage: Coverage = {
  changedFiles: ['src/Clusters.tsx'],
  affected: [{ screenId: 'clusters', url: 'http://x/clusters', provenance: 'manual' }],
  unresolvedFiles: [],
  gaps: [],
  nothingToCheck: false,
};

function draft(over: Partial<Draft> = {}): Draft {
  return {
    rule: 'button-name',
    layer: 'axe',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId: 'clusters',
    elementPath: 'button',
    elementName: null,
    role: 'button',
    whatUserExperiences: '',
    why: '',
    fix: '',
    evidence: {},
    confidence: 'fail',
    ...over,
  };
}

function entry(over: Partial<FloorEntry> = {}): FloorEntry {
  return { screenId: 'clusters', layer: 'axe', rule: 'button-name', elementKey: null, identityBasis: 'count', count: 1, ...over };
}

function waiver(over: Partial<Waiver> = {}): Waiver {
  return {
    rule: 'button-name',
    surface: 'clusters',
    scope: '*',
    reason: 'tracked',
    owner: 'team',
    approvedBy: 'lead',
    created: '2026-01-01T00:00:00.000Z',
    expires: '2027-01-01T00:00:00.000Z',
    ...over,
  };
}

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    coverage,
    guardDivergedPaths: [],
    drafts: [],
    floor: { version: 2, entries: [] },
    waivers: [],
    now: '2026-06-01T00:00:00.000Z',
    cleanlyScannedScreens: new Set(['clusters']),
    ...over,
  };
}

function refusal(run: () => unknown): InputRefusedError {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(InputRefusedError);
    return err as InputRefusedError;
  }
  throw new Error('expected the gate to refuse its input');
}

describe('gate() refuses a floor with duplicate identities', () => {
  it('refuses two entries at one identity instead of letting the last one win', () => {
    // Two barriers on one screen. The first entry accepts one, the second accepts two. Last-wins
    // read both as carried, first-wins read one as new, so the verdict hung on entry order and
    // one ordering was a false green.
    const floor: EvidenceFloor = { version: 2, entries: [entry({ count: 1 }), entry({ layer: 'pf', count: 2 })] };
    const drafts = [draft({ elementPath: 'button.a' }), draft({ elementPath: 'button.b' })];
    const err = refusal(() => gate(input({ floor, drafts })));
    expect(err.field).toBe('floor.entries[1]');
    expect(err.message).toMatch(/duplicate identity/);
    expect(err.message).toContain('floor.entries[0]');
  });

  it('does not repeat the identity it refused', () => {
    const elementKey = 'clusters|button-name|name:private label';
    const floor: EvidenceFloor = {
      version: 2,
      entries: [entry({ identityBasis: 'name', elementKey }), entry({ identityBasis: 'name', elementKey, layer: 'pf' })],
    };
    const err = refusal(() => gate(input({ floor })));
    expect(err.message).not.toContain('private label');
    expect(err.message).not.toContain('clusters|');
  });

  it('refuses a floor whose entries are not entries', () => {
    const floor = { version: 2, entries: [entry({ count: -1 })] } as EvidenceFloor;
    const err = refusal(() => gate(input({ floor })));
    expect(err.field).toBe('floor.entries[0].count');
  });

  it('still accepts a well-formed floor, so the check refuses nothing it should not', () => {
    const floor: EvidenceFloor = { version: 2, entries: [entry({ count: 2 })] };
    const drafts = [draft({ elementPath: 'button.a' }), draft({ elementPath: 'button.b' })];
    expect(gate(input({ floor, drafts })).verdict).toBe('verified');
  });
});

describe('gate() checks every screen and surface id against the id grammar', () => {
  const cases: { field: string; build: () => GateInput }[] = [
    {
      field: 'coverage.affected[1].screenId',
      build: () =>
        input({
          coverage: {
            ...coverage,
            affected: [...coverage.affected, { screenId: BAD_ID, url: 'http://x/a', provenance: 'manual' }],
          },
        }),
    },
    { field: 'drafts[1].screenId', build: () => input({ drafts: [draft(), draft({ screenId: BAD_ID })] }) },
    {
      field: 'floor.entries[0].screenId',
      build: () => input({ floor: { version: 2, entries: [entry({ screenId: BAD_ID })] } }),
    },
    { field: 'waivers[2].surface', build: () => input({ waivers: [waiver(), waiver({ rule: 'b' }), waiver({ surface: BAD_ID })] }) },
    { field: 'cleanlyScannedScreens[1]', build: () => input({ cleanlyScannedScreens: new Set(['clusters', BAD_ID]) }) },
  ];

  for (const { field, build } of cases) {
    it(`refuses a bad id in ${field}, naming the field and never the id`, () => {
      const err = refusal(() => gate(build()));
      expect(err.field).toBe(field);
      expect(err.message).toContain(field);
      expect(err.message).toContain('U+200B');
      expect(err.message).not.toContain(LEAK);
      expect(err.message).not.toContain(BAD_ID);
    });
  }

  it('refuses an empty id, an id that is not NFC, and an id that is not a string', () => {
    for (const screenId of ['', 'é-leak-me', 42 as unknown as string]) {
      const err = refusal(() => gate(input({ drafts: [draft({ screenId })] })));
      expect(err.field).toBe('drafts[0].screenId');
      expect(err.message).not.toContain(LEAK);
    }
  });

  it('checks ids before it reads the coverage short cut, so an idle input is checked too', () => {
    const err = refusal(() =>
      gate(input({ coverage: { ...coverage, nothingToCheck: true }, drafts: [draft({ screenId: BAD_ID })] })),
    );
    expect(err.field).toBe('drafts[0].screenId');
  });
});

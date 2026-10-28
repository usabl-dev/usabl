/**
 * The exported gate() checks its own input. The file readers validate the floor and the ids they
 * read, but a library caller can build a GateInput by hand and skip them. These tests hand the
 * gate the inputs a file reader would refuse and expect a typed refusal that names the field and
 * its position, and never repeats the refused value.
 */
import { describe, expect, it } from 'vitest';
import { gate } from '../../src/gate/index.js';
import { InputRefusedError } from '../../src/intake/input-refusal.js';
import type { Coverage, Draft, EvidenceFloor, FloorEntry, GateInput, RenderEvidence, Waiver } from '../../src/contracts/index.js';

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

describe('gate() checks every field that decides the verdict', () => {
  const failing = draft({ elementPath: 'button.a' });

  it('refuses a nothingToCheck that is not a boolean, instead of reading a truthy string as idle', () => {
    const err = refusal(() =>
      gate(input({ coverage: { ...coverage, nothingToCheck: 'false' as unknown as boolean }, drafts: [failing] })),
    );
    expect(err.field).toBe('coverage.nothingToCheck');
  });

  const draftCases: { field: string; over: Record<string, unknown> }[] = [
    { field: 'drafts[1].evidenceClass', over: { evidenceClass: 'Deterministic' } },
    { field: 'drafts[1].evidenceClass', over: { evidenceClass: 'deterministic ' } },
    { field: 'drafts[1].confidence', over: { confidence: 'FAIL' } },
    { field: 'drafts[1].severity', over: { severity: 'blocker' } },
    { field: 'drafts[1].rule', over: { rule: 7 } },
    { field: 'drafts[1].layer', over: { layer: null } },
    { field: 'drafts[1].elementPath', over: { elementPath: {} } },
    { field: 'drafts[1].elementName', over: { elementName: 3 } },
    { field: 'drafts[1].role', over: { role: false } },
    { field: 'drafts[1].whatUserExperiences', over: { whatUserExperiences: undefined } },
    { field: 'drafts[1].evidence', over: { evidence: LEAK } },
    { field: 'drafts[1].evidence.name.value', over: { evidence: { name: { value: 5, source: 'ax-tree', fromTree: true } } } },
  ];
  for (const { field, over } of draftCases) {
    it(`refuses a draft whose ${field} is not a contract value, naming it and never the value`, () => {
      const bad = { ...failing, ...over } as unknown as Draft;
      const err = refusal(() => gate(input({ drafts: [failing, bad] })));
      expect(err.field).toBe(field);
      expect(err.message).toContain(field);
      expect(err.message).not.toContain('Deterministic');
      expect(err.message).not.toContain(LEAK);
    });
  }

  const listCases: { field: string; over: Partial<GateInput> }[] = [
    { field: 'coverage.gaps', over: { coverage: { ...coverage, gaps: {} as unknown as Coverage['gaps'] } } },
    { field: 'coverage.unresolvedFiles', over: { coverage: { ...coverage, unresolvedFiles: { length: 0 } as unknown as string[] } } },
    { field: 'guardDivergedPaths', over: { guardDivergedPaths: {} as unknown as string[] } },
    { field: 'guardDivergedPaths[0]', over: { guardDivergedPaths: [3 as unknown as string] } },
  ];
  for (const { field, over } of listCases) {
    it(`refuses a ${field} that is not what the contract says, instead of reading it as empty`, () => {
      const err = refusal(() => gate(input({ drafts: [failing], ...over })));
      expect(err.field).toBe(field);
    });
  }

  it('refuses a waiver whose dates are not ISO-8601 UTC, as the waiver ledger does', () => {
    // A string compare made "garbage" later than any real date, so the waiver never expired.
    const err = refusal(() => gate(input({ drafts: [failing], waivers: [waiver({ expires: 'garbage' })] })));
    expect(err.field).toBe('waivers[0].expires');
    expect(err.message).not.toContain('garbage');
  });

  it('refuses a clock value that is not ISO-8601 UTC', () => {
    const err = refusal(() => gate(input({ now: 'later' })));
    expect(err.field).toBe('now');
  });
});

describe('gate() reads its input once and gates what it checked', () => {
  it('reads each input field once, so a getter cannot hand the gate an unchecked value', () => {
    const reads = new Map<string, number>();
    let drafts: Draft[] = [];
    const base = input();
    const counted = new Proxy(base, {
      get(target, key, receiver) {
        if (typeof key === 'string') reads.set(key, (reads.get(key) ?? 0) + 1);
        if (key === 'drafts') {
          // Clean on the first read, an unchecked id on every read after it.
          const value = drafts;
          drafts = [draft({ screenId: BAD_ID })];
          return value;
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const out = gate(counted);
    expect(out.verdict).toBe('verified');
    expect(out.findings).toEqual([]);
    for (const key of ['coverage', 'guardDivergedPaths', 'drafts', 'floor', 'waivers', 'now', 'cleanlyScannedScreens', 'renderEvidence']) {
      expect(reads.get(key), key).toBe(1);
    }
  });

  it('refuses a cleanlyScannedScreens that is not a real Set', () => {
    const fake = { has: () => true, *[Symbol.iterator]() {} } as unknown as ReadonlySet<string>;
    const err = refusal(() => gate(input({ cleanlyScannedScreens: fake })));
    expect(err.field).toBe('cleanlyScannedScreens');
  });

  it('decides fixed from the members the set really holds, not from an overridden has()', () => {
    class LyingSet extends Set<string> {
      override has(): boolean {
        return true;
      }
    }
    const floor: EvidenceFloor = { version: 2, entries: [entry({ screenId: 'never-scanned' })] };
    const out = gate(input({ floor, cleanlyScannedScreens: new LyingSet(['clusters']) }));
    expect(out.findings.filter((f) => f.status === 'fixed')).toEqual([]);
  });

  it('still marks a floor entry fixed on a screen the set really holds', () => {
    const floor: EvidenceFloor = { version: 2, entries: [entry()] };
    const out = gate(input({ floor, cleanlyScannedScreens: new Set(['clusters']), renderEvidence: held() }));
    expect(out.findings.map((f) => f.status)).toEqual(['fixed']);
  });
});

// Render evidence for the clusters screen whose readiness signal held.
function held(): Map<string, RenderEvidence> {
  return new Map([['clusters', { signalHeld: true, elementSlots: new Set<string>() }]]);
}

describe('gate() carries the render evidence a library caller passes', () => {
  const floor: EvidenceFloor = { version: 2, entries: [entry()] };

  it('pays down an absent floor entry when the screen\'s readiness signal held', () => {
    const out = gate(input({ floor, renderEvidence: held() }));
    expect(out.findings.map((f) => f.status)).toEqual(['fixed']);
    expect(out.floorUnconfirmed).toEqual([]);
  });

  it('pays down a name-keyed entry when the run met its element, with no signal', () => {
    const named: EvidenceFloor = {
      version: 2,
      entries: [entry({ identityBasis: 'name', elementKey: 'clusters|button-name|name:save' })],
    };
    const renderEvidence = new Map([['clusters', { signalHeld: false, elementSlots: new Set(['name:save']) }]]);
    const out = gate(input({ floor: named, renderEvidence }));
    expect(out.findings.map((f) => f.status)).toEqual(['fixed']);
  });

  it('claims nothing fixed without render evidence, and gives the notice', () => {
    const out = gate(input({ floor }));
    expect(out.findings).toEqual([]);
    expect(out.floorUnconfirmed).toEqual([{ screenId: 'clusters', rules: ['button-name'], barriers: 1 }]);
  });

  type Bad = { field: string; value: () => unknown };
  const cases: Bad[] = [
    { field: 'renderEvidence', value: () => ({ clusters: { signalHeld: true, elementSlots: new Set() } }) },
    { field: 'renderEvidence', value: () => LEAK },
    { field: 'renderEvidence[0].key', value: () => new Map([[BAD_ID, { signalHeld: true, elementSlots: new Set() }]]) },
    { field: 'renderEvidence[0].key', value: () => new Map([[7, { signalHeld: true, elementSlots: new Set() }]]) },
    { field: 'renderEvidence[0].value', value: () => new Map([['clusters', LEAK]]) },
    { field: 'renderEvidence[0].value.signalHeld', value: () => new Map([['clusters', { signalHeld: LEAK, elementSlots: new Set() }]]) },
    { field: 'renderEvidence[0].value.elementSlots', value: () => new Map([['clusters', { signalHeld: false, elementSlots: [LEAK] }]]) },
    {
      field: 'renderEvidence[1].value.elementSlots[1]',
      value: () =>
        new Map<string, unknown>([
          ['orders', { signalHeld: false, elementSlots: new Set() }],
          ['clusters', { signalHeld: false, elementSlots: new Set<unknown>(['name:save', { slot: LEAK }]) }],
        ]),
    },
  ];
  for (const { field, value } of cases) {
    it(`refuses a malformed ${field}, naming the field and never the value`, () => {
      const err = refusal(() => gate(input({ floor, renderEvidence: value() as ReadonlyMap<string, RenderEvidence> })));
      expect(err.field).toBe(field);
      expect(err.message).toContain(field);
      expect(err.message).not.toContain(LEAK);
    });
  }

  it('decides fixed from the entries the map really holds, not from an overridden get()', () => {
    class LyingMap extends Map<string, RenderEvidence> {
      override get(): RenderEvidence {
        return { signalHeld: true, elementSlots: new Set<string>() };
      }
    }
    const out = gate(input({ floor, renderEvidence: new LyingMap() }));
    expect(out.findings).toEqual([]);
  });

  it('decides an element match from the slots the set really holds, not from an overridden has()', () => {
    class LyingSet extends Set<string> {
      override has(): boolean {
        return true;
      }
    }
    const named: EvidenceFloor = {
      version: 2,
      entries: [entry({ identityBasis: 'name', elementKey: 'clusters|button-name|name:save' })],
    };
    const renderEvidence = new Map([['clusters', { signalHeld: false, elementSlots: new LyingSet() }]]);
    const out = gate(input({ floor: named, renderEvidence }));
    expect(out.findings).toEqual([]);
  });
});

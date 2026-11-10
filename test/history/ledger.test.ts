/**
 * The ledger of how long accessibility barriers stay open, built from floor snapshots and debt
 * history records. Pure: every case here is a scripted history with a fixed clock.
 */
import { describe, expect, it } from 'vitest';
import type { EvidenceFloor, FloorEntry } from '../../src/contracts/index.js';
import { buildLedger, type FloorSnapshot, type LedgerHistory, type LedgerInput, type LedgerRecord } from '../../src/history/ledger.js';
import type { HistoryRecord } from '../../src/history/record.js';
import { dialogAt, entryFor, floorOf, fullScreen, recordOf, rowButton } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-01-01T00:00:00.000Z');

function dayAt(day: number, hours = 0): string {
  return new Date(START + day * DAY + hours * 60 * 60 * 1000).toISOString();
}

// Commit ids are low entropy on purpose: the repository history is scanned for secrets.
function commitAt(position: number): string {
  return String(position + 1).padStart(40, '0');
}

const A = entryFor(dialogAt(1), 1);
const B = entryFor(dialogAt(1, { rule: 'pf-dialog-label' }), 1);
const C = entryFor(dialogAt(1, { rule: 'aria-required-attr' }), 1);

function snap(position: number, floor: EvidenceFloor | null, over: Partial<FloorSnapshot> = {}): FloorSnapshot {
  return { commit: commitAt(position), date: dayAt(position), position, floor, unreadable: null, ...over };
}

function placed(record: HistoryRecord, position: number | null): LedgerRecord {
  return { record, at: position === null ? null : { commit: commitAt(position), date: dayAt(position), position } };
}

function scanAt(position: number, floor: EvidenceFloor, counts: Array<[FloorEntry, number]>, tree = `tree-${position}`): LedgerRecord {
  return placed(recordOf(floor, [fullScreen('clusters', counts)], { commit: commitAt(position), sourceTree: tree }), position);
}

function historyOn(records: LedgerRecord[], skipped = 0): LedgerHistory {
  return { kind: 'on', ref: 'origin/usabl/history', head: 'f'.repeat(40), records, skipped };
}

function input(snapshots: FloorSnapshot[], history: LedgerHistory = historyOn([]), over: Partial<LedgerInput> = {}): LedgerInput {
  return { trustedRef: 'origin/main', head: commitAt(99), shallow: false, snapshots, history, now: dayAt(41), ...over };
}

function rowFor(ledger: ReturnType<typeof buildLedger>, entry: FloorEntry) {
  const row = ledger.rows.find((candidate) => candidate.rule === entry.rule && candidate.elementKey === entry.elementKey);
  if (row === undefined) throw new Error(`no row for ${entry.rule}`);
  return row;
}

describe('buildLedger', () => {
  it('keeps an open accessibility barrier open to the clock and labels a first baseline row', () => {
    const ledger = buildLedger(input([snap(0, floorOf([A]))]));
    const row = rowFor(ledger, A);
    expect(row).toMatchObject({
      screenId: 'clusters',
      rule: A.rule,
      elementKey: A.elementKey,
      identityBasis: A.identityBasis,
      state: 'open',
      firstSeen: { commit: commitAt(0), date: dayAt(0) },
      firstSeenAtFirstBaseline: true,
      lastChange: { commit: commitAt(0), date: dayAt(0) },
      daysOpen: 41,
      lowerBound: false,
      incomplete: [],
    });
    expect(row.spans).toEqual([{ start: { commit: commitAt(0), date: dayAt(0) }, end: null, days: 41 }]);
  });

  it('dates an accessibility barrier floored after the first baseline from its own commit, with no baseline label', () => {
    const ledger = buildLedger(input([snap(0, floorOf([A])), snap(10, floorOf([A, B]))]));
    expect(rowFor(ledger, B)).toMatchObject({ firstSeen: { commit: commitAt(10) }, firstSeenAtFirstBaseline: false, daysOpen: 31 });
    expect(rowFor(ledger, A).firstSeenAtFirstBaseline).toBe(true);
  });

  it('counts whole days as the floor of elapsed hours over 24', () => {
    const ledger = buildLedger(input([snap(0, floorOf([A]))], historyOn([]), { now: dayAt(2, 23) }));
    expect(rowFor(ledger, A).daysOpen).toBe(2);
  });

  it('marks an accessibility barrier fixed when it leaves the floor', () => {
    const ledger = buildLedger(input([snap(0, floorOf([A, B])), snap(9, floorOf([B]))]));
    const row = rowFor(ledger, A);
    expect(row).toMatchObject({ state: 'fixed', daysOpen: 9, lastChange: { commit: commitAt(9), date: dayAt(9) } });
    expect(row.spans).toEqual([
      { start: { commit: commitAt(0), date: dayAt(0) }, end: { commit: commitAt(9), date: dayAt(9), by: 'floor' }, days: 9 },
    ]);
  });

  it('marks an accessibility barrier fixed at the record that confirms the fix: two full scans in a row that see none', () => {
    const floor = floorOf([A, B]);
    const ledger = buildLedger(
      input([snap(0, floor)], historyOn([scanAt(3, floor, [[A, 0], [B, 1]]), scanAt(5, floor, [[A, 0], [B, 1]])])),
    );
    expect(rowFor(ledger, A)).toMatchObject({ state: 'fixed', daysOpen: 5, lastChange: { commit: commitAt(5) } });
    expect(rowFor(ledger, A).spans[0]?.end).toEqual({ commit: commitAt(5), date: dayAt(5), by: 'history' });
    expect(rowFor(ledger, B).state).toBe('open');
  });

  it('does not confirm a fix from one scan, from a pair broken by a sighting, or from a pair across two floors', () => {
    const floor = floorOf([A]);
    const other = floorOf([A, B]);
    const one = buildLedger(input([snap(0, floor)], historyOn([scanAt(3, floor, [[A, 0]])])));
    const broken = buildLedger(
      input([snap(0, floor)], historyOn([scanAt(3, floor, [[A, 0]]), scanAt(4, floor, [[A, 1]]), scanAt(5, floor, [[A, 0]])])),
    );
    const acrossFloors = buildLedger(
      input([snap(0, floor), snap(4, other)], historyOn([scanAt(3, floor, [[A, 0]]), scanAt(5, other, [[A, 0]])])),
    );
    expect(rowFor(one, A).state).toBe('open');
    expect(rowFor(broken, A).state).toBe('open');
    expect(rowFor(acrossFloors, A).state).toBe('open');
  });

  it('skips a scan with a gap on the screen: it neither confirms nor breaks the pair', () => {
    const floor = floorOf([A]);
    const gapped = placed(
      recordOf(floor, [{ screenId: 'clusters', coverage: 'partial', identities: [] }], { commit: commitAt(4), sourceTree: 'tree-4' }),
      4,
    );
    const ledger = buildLedger(input([snap(0, floor)], historyOn([scanAt(3, floor, [[A, 0]]), gapped, scanAt(5, floor, [[A, 0]])])));
    expect(rowFor(ledger, A)).toMatchObject({ state: 'fixed', daysOpen: 5 });
  });

  it('keeps an accessibility barrier open while a scan still sees some of it', () => {
    const counted = entryFor(dialogAt(1, { rule: 'button-name' }), 3);
    const floor = floorOf([counted]);
    const ledger = buildLedger(input([snap(0, floor)], historyOn([scanAt(3, floor, [[counted, 1]]), scanAt(5, floor, [[counted, 1]])])));
    expect(rowFor(ledger, counted).state).toBe('open');
  });

  it('lists an accessibility barrier that was fixed and came back as one reopened row with its open spans summed', () => {
    const floor = floorOf([A]);
    const ledger = buildLedger(
      input(
        [snap(0, floor)],
        historyOn([scanAt(3, floor, [[A, 0]]), scanAt(5, floor, [[A, 0]]), scanAt(8, floor, [[A, 1]])]),
      ),
    );
    const row = rowFor(ledger, A);
    expect(row.state).toBe('reopened');
    expect(row.spans).toEqual([
      { start: { commit: commitAt(0), date: dayAt(0) }, end: { commit: commitAt(5), date: dayAt(5), by: 'history' }, days: 5 },
      { start: { commit: commitAt(8), date: dayAt(8) }, end: null, days: 33 },
    ]);
    expect(row.daysOpen).toBe(38);
    expect(row.lastChange).toEqual({ commit: commitAt(8), date: dayAt(8) });
  });

  it('keeps the reopened state when an accessibility barrier that came back is fixed again', () => {
    const floor = floorOf([A]);
    const ledger = buildLedger(
      input(
        [snap(0, floor)],
        historyOn([
          scanAt(3, floor, [[A, 0]]),
          scanAt(5, floor, [[A, 0]]),
          scanAt(8, floor, [[A, 1]]),
          scanAt(10, floor, [[A, 0]]),
          scanAt(12, floor, [[A, 0]]),
        ]),
      ),
    );
    const row = rowFor(ledger, A);
    expect(row.state).toBe('reopened');
    expect(row.spans.map((span) => span.days)).toEqual([5, 4]);
    expect(row.daysOpen).toBe(9);
  });

  it('reopens an accessibility barrier that left the floor and was floored again', () => {
    const ledger = buildLedger(input([snap(0, floorOf([A])), snap(4, floorOf([])), snap(10, floorOf([A]))]));
    const row = rowFor(ledger, A);
    expect(row.state).toBe('reopened');
    expect(row.spans.map((span) => span.days)).toEqual([4, 31]);
    expect(row.daysOpen).toBe(35);
  });

  it('withdraws a fix that came back on an unchanged source tree and labels the row intermittent', () => {
    const floor = floorOf([A]);
    const ledger = buildLedger(
      input(
        [snap(0, floor)],
        historyOn([scanAt(3, floor, [[A, 0]], 'tree-x'), scanAt(5, floor, [[A, 0]], 'tree-y'), scanAt(8, floor, [[A, 1]], 'tree-y')]),
      ),
    );
    const row = rowFor(ledger, A);
    expect(row).toMatchObject({ state: 'open', intermittent: true, daysOpen: 41 });
    expect(row.spans).toEqual([{ start: { commit: commitAt(0), date: dayAt(0) }, end: null, days: 41 }]);
  });

  it('sorts rows by days open, longest first, and counts totals per state', () => {
    const floor = floorOf([A, B, C]);
    const ledger = buildLedger(
      input(
        [snap(0, floor), snap(20, floorOf([B, C])), snap(30, floorOf([C]))],
      ),
    );
    expect(ledger.rows.map((row) => [row.rule, row.state, row.daysOpen])).toEqual([
      [C.rule, 'open', 41],
      [B.rule, 'fixed', 30],
      [A.rule, 'fixed', 20],
    ]);
    expect(ledger.totals).toEqual({
      open: { rows: 1, medianDays: 41, longestDays: 41 },
      fixed: { rows: 2, medianDays: 25, longestDays: 30 },
      reopened: { rows: 0, medianDays: null, longestDays: null },
    });
  });

  it('gives the same ledger for the same history and the same clock', () => {
    const floor = floorOf([A, B]);
    const make = () => input([snap(0, floor), snap(7, floorOf([B]))], historyOn([scanAt(3, floor, [[B, 1]])]));
    expect(JSON.stringify(buildLedger(make()))).toBe(JSON.stringify(buildLedger(make())));
  });
});

describe('buildLedger with incomplete history', () => {
  it('says a shallow clone may hide older evidence and marks those rows as a lower bound', () => {
    const ledger = buildLedger(input([snap(0, floorOf([A])), snap(10, floorOf([A, B]))], historyOn([]), { shallow: true }));
    const old = rowFor(ledger, A);
    expect(old).toMatchObject({ firstSeenAtFirstBaseline: false, lowerBound: true });
    expect(old.incomplete.map((gap) => gap.cause)).toEqual(['shallow']);
    expect(old.incomplete[0]?.detail).toMatch(/shallow clone/u);
    expect(rowFor(ledger, B)).toMatchObject({ lowerBound: false, incomplete: [] });
    expect(ledger.shallow).toBe(true);
  });

  it('says on every row that a missing history hides confirmed fixes, without calling the days a lower bound', () => {
    const ledger = buildLedger(
      input([snap(0, floorOf([A, B])), snap(9, floorOf([B]))], { kind: 'off', ref: 'origin/usabl/history', cause: 'no-history', detail: null }),
    );
    for (const row of ledger.rows) {
      expect(row.incomplete.map((gap) => gap.cause)).toEqual(['no-history']);
      expect(row.incomplete[0]?.detail).toMatch(/origin\/usabl\/history/u);
      expect(row.lowerBound).toBe(false);
    }
    expect(ledger.history).toEqual({ kind: 'off', ref: 'origin/usabl/history', cause: 'no-history', detail: null });
  });

  it('names the reason when the history has a record it cannot read', () => {
    const ledger = buildLedger(
      input([snap(0, floorOf([A]))], {
        kind: 'off',
        ref: 'origin/usabl/history',
        cause: 'unreadable',
        detail: '2026-01.jsonl line 2 is not JSON',
      }),
    );
    const row = rowFor(ledger, A);
    expect(row.incomplete.map((gap) => gap.cause)).toEqual(['history-unreadable']);
    expect(row.incomplete[0]?.detail).toContain('2026-01.jsonl line 2 is not JSON');
    expect(row.state).toBe('open');
  });

  it('ends a row that leaves at a floor version migration without calling it fixed, and labels the rows that enter there', () => {
    const named = entryFor(dialogAt(1, { evidence: { name: { value: 'Close', source: 'attribute', fromTree: true } } }), 1);
    const collapsed: FloorEntry = { ...entryFor(rowButton('one'), 2), elementKey: null, identityBasis: 'count' };
    const keyed = entryFor(rowButton('one'), 1);
    const ledger = buildLedger(input([snap(0, floorOf([named, collapsed], 2)), snap(6, floorOf([named, keyed], 3))]));

    expect(rowFor(ledger, named)).toMatchObject({ state: 'open', daysOpen: 41, lowerBound: false, incomplete: [] });

    const left = rowFor(ledger, collapsed);
    expect(left).toMatchObject({ state: 'open', daysOpen: 6, lowerBound: true });
    expect(left.spans[0]?.end).toEqual({ commit: commitAt(6), date: dayAt(6), by: 'gap' });
    expect(left.incomplete.map((gap) => gap.cause)).toEqual(['floor-rewritten']);
    expect(left.incomplete[0]?.detail).toMatch(/version 2 to version 3/u);

    const entered = rowFor(ledger, keyed);
    expect(entered).toMatchObject({ state: 'open', daysOpen: 35, lowerBound: true, firstSeenAtFirstBaseline: false });
    expect(entered.incomplete.map((gap) => gap.cause)).toEqual(['floor-rewritten']);
  });

  it('treats a floor it cannot read at one commit as a gap, never as a fix', () => {
    const ledger = buildLedger(
      input([snap(0, floorOf([A, B])), snap(3, null, { unreadable: 'evidence floor entries must be an array' }), snap(5, floorOf([A, C]))]),
    );
    expect(rowFor(ledger, A)).toMatchObject({ state: 'open', daysOpen: 41, incomplete: [] });
    const left = rowFor(ledger, B);
    expect(left).toMatchObject({ state: 'open', daysOpen: 3, lowerBound: true });
    expect(left.incomplete.map((gap) => gap.cause)).toEqual(['floor-unreadable']);
    expect(left.incomplete[0]?.detail).toContain('evidence floor entries must be an array');
    const entered = rowFor(ledger, C);
    expect(entered).toMatchObject({ firstSeen: { commit: commitAt(5) }, lowerBound: true });
    expect(entered.incomplete.map((gap) => gap.cause)).toEqual(['floor-unreadable']);
  });

  it('treats a deleted floor file as a gap, never as a fix', () => {
    const ledger = buildLedger(input([snap(0, floorOf([A])), snap(4, null), snap(10, floorOf([A]))]));
    const row = rowFor(ledger, A);
    expect(row.state).toBe('open');
    expect(row.spans.map((span) => span.end?.by ?? null)).toEqual(['gap', null]);
    expect(row.daysOpen).toBe(35);
    expect(row.lowerBound).toBe(true);
    // One note for leaving at the deletion, one for entering the floor written again.
    expect(row.incomplete.map((gap) => gap.cause)).toEqual(['floor-deleted', 'floor-deleted']);
    expect(row.incomplete.map((gap) => gap.detail).join('\n')).toMatch(/That is not a fix/u);
    expect(row.incomplete.map((gap) => gap.detail).join('\n')).toMatch(/written again later/u);
  });

  it('says which rows a record it could not place in time touched, and never lets it confirm a fix', () => {
    const floor = floorOf([A, B]);
    const offLine = placed(recordOf(floor, [fullScreen('clusters', [[A, 0]])], { commit: commitAt(50), sourceTree: 'tree-50' }), null);
    const ledger = buildLedger(input([snap(0, floor)], historyOn([scanAt(3, floor, [[A, 0]]), offLine, scanAt(5, floor, [[A, 0]])])));
    const row = rowFor(ledger, A);
    expect(row.state).toBe('open');
    expect(row.incomplete.map((gap) => gap.cause)).toEqual(['record-off-line']);
    expect(row.lowerBound).toBe(false);
    expect(rowFor(ledger, B).incomplete).toEqual([]);
  });
});

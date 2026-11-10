/**
 * The ledger of how long accessibility barriers stay open, built from floor snapshots and debt
 * history records. Pure: every case here is a scripted history with a fixed clock.
 */
import { describe, expect, it } from 'vitest';
import type { EvidenceFloor, FloorEntry } from '../../src/contracts/index.js';
import { buildLedger, checkSpans, LedgerInvariantError, type FloorSnapshot, type LedgerHistory, type LedgerInput, type LedgerRecord } from '../../src/history/ledger.js';
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
  return { trustedRef: 'origin/main', head: commitAt(41), headDate: dayAt(41), shallow: false, snapshots, history, ...over };
}

function rowFor(ledger: ReturnType<typeof buildLedger>, entry: FloorEntry) {
  const row = ledger.rows.find((candidate) => candidate.rule === entry.rule && candidate.elementKey === entry.elementKey);
  if (row === undefined) throw new Error(`no row for ${entry.rule}`);
  return row;
}

describe('buildLedger', () => {
  it('keeps an open accessibility barrier open to the head commit and labels a first baseline row', () => {
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
      // In the first floor, so it may be older. No scan of main saw it, so it may be fixed already.
      mayBeMore: true,
      mayBeMoreReasons: ['first-floor-for-screen'],
      mayBeLess: true,
      mayBeLessReasons: ['not-seen'],
      lastSeen: null,
    });
    expect(row.incomplete.map((gap) => gap.cause)).toEqual(['not-seen']);
    expect(row.spans).toEqual([{ start: { commit: commitAt(0), date: dayAt(0) }, end: null, days: 41 }]);
  });

  it('dates an accessibility barrier floored after the first baseline from its own commit, with no baseline label', () => {
    const ledger = buildLedger(input([snap(0, floorOf([A])), snap(10, floorOf([A, B]))]));
    expect(rowFor(ledger, B)).toMatchObject({
      firstSeen: { commit: commitAt(10) },
      firstSeenAtFirstBaseline: false,
      daysOpen: 31,
      mayBeMore: false,
      mayBeMoreReasons: [],
    });
    expect(rowFor(ledger, A).firstSeenAtFirstBaseline).toBe(true);
  });

  it('counts whole days as the floor of elapsed hours over 24', () => {
    const ledger = buildLedger(input([snap(0, floorOf([A]))], historyOn([]), { headDate: dayAt(2, 23) }));
    expect(rowFor(ledger, A).daysOpen).toBe(2);
  });

  it('says an accessibility barrier that only left the floor left the floor, never that it was fixed', () => {
    const ledger = buildLedger(input([snap(0, floorOf([A, B])), snap(9, floorOf([B]))]));
    const row = rowFor(ledger, A);
    expect(row).toMatchObject({ state: 'left-the-floor', daysOpen: 9, lastChange: { commit: commitAt(9), date: dayAt(9) } });
    expect(row.spans).toEqual([
      { start: { commit: commitAt(0), date: dayAt(0) }, end: { commit: commitAt(9), date: dayAt(9), by: 'floor' }, days: 9 },
    ]);
    expect(row).toMatchObject({ mayBeMore: true, mayBeLess: true });
    expect(row.mayBeMoreReasons).toContain('left-the-floor');
    expect(row.mayBeLessReasons).toContain('left-the-floor');
    const note = row.incomplete.find((gap) => gap.cause === 'left-the-floor');
    expect(note?.detail).toMatch(/cannot tell a fix from a floor reset, a prune, or a renamed screen without the history/u);
  });

  describe('every way an identity leaves the floor without a scan lands on left the floor', () => {
    it('a re-baseline that drops it', () => {
      const ledger = buildLedger(input([snap(0, floorOf([A, B])), snap(5, floorOf([B, C]))]));
      expect(rowFor(ledger, A)).toMatchObject({ state: 'left-the-floor', mayBeMore: true, mayBeLess: true });
    });

    it('a reset of the floor at the same version', () => {
      const ledger = buildLedger(input([snap(0, floorOf([A, B])), snap(3, { version: 3, entries: [] })]));
      for (const row of ledger.rows) expect(row).toMatchObject({ state: 'left-the-floor', daysOpen: 3, mayBeMore: true, mayBeLess: true });
    });

    it('a prune the history did not confirm: one clean scan is not a fix', () => {
      const floor = floorOf([A, B]);
      const ledger = buildLedger(input([snap(0, floor), snap(6, floorOf([B]))], historyOn([scanAt(4, floor, [[A, 0], [B, 1]])])));
      expect(rowFor(ledger, A)).toMatchObject({ state: 'left-the-floor', daysOpen: 6, mayBeMore: true, mayBeLess: true });
    });

    it('a renamed screen: the old row left the floor, and the new one may be older', () => {
      const renamed: FloorEntry = { ...A, screenId: 'cluster-list', elementKey: (A.elementKey ?? '').replace('clusters|', 'cluster-list|') };
      const ledger = buildLedger(input([snap(0, floorOf([A])), snap(10, floorOf([renamed]))]));
      const old = ledger.rows.find((row) => row.screenId === 'clusters');
      const fresh = ledger.rows.find((row) => row.screenId === 'cluster-list');
      expect(old).toMatchObject({ state: 'left-the-floor', daysOpen: 10, mayBeMore: true, mayBeLess: true });
      expect(fresh).toMatchObject({ state: 'open', daysOpen: 31, mayBeMore: true });
      expect(fresh?.mayBeMoreReasons).toEqual(['first-floor-for-screen']);
    });

    it('a fix the history confirmed stays fixed when the floor drops it later', () => {
      const floor = floorOf([A]);
      const ledger = buildLedger(
        input([snap(0, floor), snap(9, floorOf([]))], historyOn([scanAt(2, floor, [[A, 1]]), scanAt(3, floor, [[A, 0]]), scanAt(5, floor, [[A, 0]])])),
      );
      expect(rowFor(ledger, A)).toMatchObject({ state: 'fixed', daysOpen: 5, mayBeLess: false });
    });
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
    // The first span only left the floor, so the sum may be wrong either way.
    expect(row).toMatchObject({ mayBeMore: true, mayBeLess: true });
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

  it('withdraws a fix shown false on its source tree even after the row reopened', () => {
    const floor = floorOf([A]);
    // The fix at c5 was confirmed on tree-y. The row reopened at c8 on tree-z. Then tree-y showed it
    // at c9, so the fix at c5 was never real: A has been open since c0.
    const ledger = buildLedger(
      input(
        [snap(0, floor)],
        historyOn([
          scanAt(3, floor, [[A, 0]], 'tree-x'),
          scanAt(5, floor, [[A, 0]], 'tree-y'),
          scanAt(8, floor, [[A, 1]], 'tree-z'),
          scanAt(9, floor, [[A, 1]], 'tree-y'),
        ]),
      ),
    );
    const row = rowFor(ledger, A);
    expect(row).toMatchObject({ state: 'open', intermittent: true, daysOpen: 41 });
    expect(row.spans).toEqual([{ start: { commit: commitAt(0), date: dayAt(0) }, end: null, days: 41 }]);
  });

  it('ends a withdrawn fix where the floor dropped the row, when it did', () => {
    const floor = floorOf([A]);
    const ledger = buildLedger(
      input(
        [snap(0, floor), snap(7, floorOf([])), snap(10, floor)],
        historyOn([scanAt(3, floor, [[A, 0]], 'tree-x'), scanAt(5, floor, [[A, 0]], 'tree-y'), scanAt(12, floor, [[A, 1]], 'tree-y')]),
      ),
    );
    const row = rowFor(ledger, A);
    expect(row.spans.map((span) => [span.start.commit, span.end?.commit ?? null, span.end?.by ?? null])).toEqual([
      [commitAt(0), commitAt(7), 'floor'],
      [commitAt(10), null, null],
    ]);
    expect(row).toMatchObject({ intermittent: true, state: 'reopened' });
    expect(row.mayBeLessReasons).toContain('left-the-floor');
  });

  it('withdraws a fix shown false by the first scan of its pair', () => {
    const floor = floorOf([A]);
    const ledger = buildLedger(
      input(
        [snap(0, floor)],
        historyOn([
          scanAt(3, floor, [[A, 0]], 'tree-x'),
          scanAt(5, floor, [[A, 0]], 'tree-y'),
          scanAt(8, floor, [[A, 1]], 'tree-x'),
        ]),
      ),
    );
    // tree-x read both 0 and 1, so the pair at c3 and c5 was not a fix.
    expect(rowFor(ledger, A)).toMatchObject({ state: 'open', intermittent: true, daysOpen: 41 });
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
      [B.rule, 'left-the-floor', 30],
      [A.rule, 'left-the-floor', 20],
    ]);
    // Every row is in the first floor, so none is exact, and there is no median.
    expect(ledger.totals).toEqual({
      open: { rows: 1, exactRows: 0, medianDays: null, longestDays: null },
      fixed: { rows: 0, exactRows: 0, medianDays: null, longestDays: null },
      'left-the-floor': { rows: 2, exactRows: 0, medianDays: null, longestDays: null },
      reopened: { rows: 0, exactRows: 0, medianDays: null, longestDays: null },
    });
  });

  it('takes the median and the longest over exact rows only', () => {
    const D = entryFor(dialogAt(1, { rule: 'aria-hidden-focus' }), 1);
    const later = floorOf([A, B, C, D]);
    // A is in the first floor. B, C, and D are floored at c10 and seen by scans of main.
    const ledger = buildLedger(
      input(
        [snap(0, floorOf([A])), snap(10, later)],
        historyOn([scanAt(12, later, [[A, 1], [B, 1], [C, 1], [D, 1]]), scanAt(14, later, [[A, 1], [B, 1], [C, 1]])]),
      ),
    );
    expect(ledger.rows.map((row) => [row.rule, row.mayBeMore, row.mayBeLess])).toEqual([
      [A.rule, true, false],
      [D.rule, false, false],
      [C.rule, false, false],
      [B.rule, false, false],
    ]);
    expect(ledger.totals.open).toEqual({ rows: 4, exactRows: 3, medianDays: 31, longestDays: 31 });
  });

  it('says which way each number can be wrong, with the reasons', () => {
    const J = entryFor(dialogAt(1, { screenId: 'jobs' }), 1);
    const late = entryFor(dialogAt(1, { rule: 'aria-hidden-focus' }), 1);
    const floor = floorOf([A, B, J, late]);
    const ledger = buildLedger(
      input([snap(0, floorOf([A])), snap(10, floor)], historyOn([scanAt(12, floor, [[A, 1], [B, 1]])])),
    );
    // Seen by a scan and in the first floor: the true number may only be larger.
    expect(rowFor(ledger, A)).toMatchObject({ mayBeMore: true, mayBeLess: false, lastSeen: { commit: commitAt(12), date: dayAt(12) } });
    // Floored later on a screen already floored, and seen: exact.
    expect(rowFor(ledger, B)).toMatchObject({ mayBeMore: false, mayBeLess: false, mayBeMoreReasons: [], mayBeLessReasons: [] });
    // Its screen was floored for the first time at c10, so it may be older. Not seen either.
    const j = rowFor(ledger, J);
    expect(j).toMatchObject({ mayBeMoreReasons: ['first-floor-for-screen'], mayBeLessReasons: ['not-seen'] });
    expect(j.incomplete.map((gap) => gap.detail).join('\n')).toMatch(/floored for the first time/u);
    // Floored later on a floored screen, never seen: the true number may only be smaller.
    expect(rowFor(ledger, late)).toMatchObject({ mayBeMore: false, mayBeLess: true, mayBeLessReasons: ['not-seen'] });
  });

  it('says a row may be older when a partial floor is widened', () => {
    const late = entryFor(dialogAt(1, { rule: 'aria-hidden-focus' }), 1);
    const ledger = buildLedger(input([snap(0, { version: 3, scope: 'partial', entries: [A] }), snap(5, floorOf([A, late]))]));
    const row = rowFor(ledger, late);
    expect(row.mayBeMoreReasons).toEqual(['first-floor-for-screen']);
    expect(row.incomplete.map((gap) => gap.detail).join('\n')).toMatch(/partial floor was widened/u);
  });

  it('replays history records in commit order, whatever order they were appended in', () => {
    const floor = floorOf([A]);
    // Appended as c3 none, c5 none, c4 one. In commit order: c3 none, c4 one, c5 none. Only one
    // clean scan follows the sighting at c4, so no fix is confirmed and A is still open.
    const ledger = buildLedger(
      input([snap(0, floor)], historyOn([scanAt(3, floor, [[A, 0]]), scanAt(5, floor, [[A, 0]]), scanAt(4, floor, [[A, 1]])])),
    );
    const row = rowFor(ledger, A);
    expect(row.spans).toEqual([{ start: { commit: commitAt(0), date: dayAt(0) }, end: null, days: 41 }]);
    expect(row).toMatchObject({ state: 'open', daysOpen: 41 });
    for (const each of ledger.rows) {
      expect(each.daysOpen).toBeLessThanOrEqual(Math.floor((Date.parse(dayAt(41)) - Date.parse(each.firstSeen.date)) / DAY));
    }

    // With two clean scans after the sighting, appended before it, the fix is dated at c6.
    const fixed = buildLedger(
      input(
        [snap(0, floor)],
        historyOn([scanAt(5, floor, [[A, 0]]), scanAt(6, floor, [[A, 0]]), scanAt(3, floor, [[A, 0]]), scanAt(4, floor, [[A, 1]])]),
      ),
    );
    expect(rowFor(fixed, A).spans).toEqual([
      { start: { commit: commitAt(0), date: dayAt(0) }, end: { commit: commitAt(6), date: dayAt(6), by: 'history' }, days: 6 },
    ]);
    expect(rowFor(fixed, A).state).toBe('fixed');
  });

  it('stops with a bug when spans overlap or count more days than have passed since first seen', () => {
    const at = (position: number) => ({ commit: commitAt(position), date: dayAt(position), position });
    const overlapping = [
      { start: at(0), end: { ...at(5), by: 'history' as const } },
      { start: at(4), end: null },
    ];
    expect(() => checkSpans(overlapping, dayAt(41))).toThrow(LedgerInvariantError);
    expect(() => checkSpans([{ start: at(0), end: { ...at(5), by: 'history' as const } }, { start: at(8), end: null }], dayAt(41))).not.toThrow();
  });

  it('says so when commit dates go backwards, and sets both bounds', () => {
    // c0 is dated day 10 and floors A. c1, made later on the line, is dated day 2 and drops it.
    const backwards = buildLedger(input([snap(0, floorOf([A]), { date: dayAt(10) }), snap(1, floorOf([]), { date: dayAt(2) })]));
    const row = rowFor(backwards, A);
    expect(row).toMatchObject({ daysOpen: 0, mayBeMore: true, mayBeLess: true });
    expect(row.mayBeMoreReasons).toContain('dates-out-of-order');
    expect(row.mayBeLessReasons).toContain('dates-out-of-order');
    const note = row.incomplete.find((gap) => gap.cause === 'dates-out-of-order');
    expect(note?.detail).toMatch(/dated before/u);
    expect(note?.detail).toMatch(/counted as 0 days/u);

    // An open span whose start is dated after the head commit.
    const late = buildLedger(input([snap(0, floorOf([A]), { date: dayAt(50) })]));
    expect(rowFor(late, A).mayBeLessReasons).toContain('dates-out-of-order');

    // A span that starts before the one before it ended, by date.
    const overlapping = buildLedger(
      input([snap(0, floorOf([A])), snap(4, floorOf([]), { date: dayAt(10) }), snap(5, floorOf([A]), { date: dayAt(5) })]),
    );
    expect(rowFor(overlapping, A).incomplete.map((gap) => gap.cause)).toContain('dates-out-of-order');

    // Dates in order carry no such note.
    expect(rowFor(buildLedger(input([snap(0, floorOf([A]))])), A).incomplete.map((gap) => gap.cause)).not.toContain('dates-out-of-order');
  });

  it('gives the same ledger for the same history', () => {
    const floor = floorOf([A, B]);
    const make = () => input([snap(0, floor), snap(7, floorOf([B]))], historyOn([scanAt(3, floor, [[B, 1]])]));
    expect(JSON.stringify(buildLedger(make()))).toBe(JSON.stringify(buildLedger(make())));
  });
});

describe('buildLedger with incomplete history', () => {
  it('says a shallow clone may hide older evidence and marks those rows as maybe more', () => {
    const ledger = buildLedger(input([snap(0, floorOf([A])), snap(10, floorOf([A, B]))], historyOn([]), { shallow: true }));
    const old = rowFor(ledger, A);
    expect(old).toMatchObject({ firstSeenAtFirstBaseline: false, mayBeMore: true, mayBeMoreReasons: ['shallow'] });
    expect(old.incomplete.map((gap) => gap.cause)).toEqual(['not-seen', 'shallow']);
    expect(old.incomplete.find((gap) => gap.cause === 'shallow')?.detail).toMatch(/shallow clone/u);
    expect(rowFor(ledger, B)).toMatchObject({ mayBeMore: false, mayBeMoreReasons: [] });
    expect(ledger.shallow).toBe(true);
  });

  it('says on every row that a missing history hides fixes, so each number may be smaller', () => {
    const ledger = buildLedger(
      input([snap(0, floorOf([A, B])), snap(9, floorOf([B]))], { kind: 'off', ref: 'origin/usabl/history', cause: 'no-history', detail: null }),
    );
    for (const row of ledger.rows) {
      const note = row.incomplete.find((gap) => gap.cause === 'no-history');
      expect(note?.detail).toMatch(/origin\/usabl\/history/u);
      expect(row.mayBeLess).toBe(true);
      expect(row.mayBeLessReasons).toContain('no-usable-history');
    }
    expect(rowFor(ledger, A).incomplete.map((gap) => gap.cause)).toEqual(['left-the-floor', 'no-history']);
    expect(rowFor(ledger, B).incomplete.map((gap) => gap.cause)).toEqual(['no-history']);
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
    expect(row.mayBeLessReasons).toEqual(['no-usable-history']);
  });

  it('ends a row that leaves at a floor version migration without calling it fixed, and labels the rows that enter there', () => {
    const named = entryFor(dialogAt(1, { evidence: { name: { value: 'Close', source: 'attribute', fromTree: true } } }), 1);
    const collapsed: FloorEntry = { ...entryFor(rowButton('one'), 2), elementKey: null, identityBasis: 'count' };
    const keyed = entryFor(rowButton('one'), 1);
    const ledger = buildLedger(input([snap(0, floorOf([named, collapsed], 2)), snap(6, floorOf([named, keyed], 3))]));

    const kept = rowFor(ledger, named);
    expect(kept).toMatchObject({ state: 'open', daysOpen: 41, mayBeMoreReasons: ['first-floor-for-screen'] });
    expect(kept.incomplete.map((gap) => gap.cause)).toEqual(['not-seen']);

    const left = rowFor(ledger, collapsed);
    expect(left).toMatchObject({ state: 'open', daysOpen: 6, mayBeMoreReasons: ['ended-at-gap', 'first-floor-for-screen'] });
    expect(left.spans[0]?.end).toEqual({ commit: commitAt(6), date: dayAt(6), by: 'gap' });
    expect(left.incomplete.map((gap) => gap.cause)).toEqual(['floor-rewritten', 'not-seen']);
    expect(left.incomplete[0]?.detail).toMatch(/version 2 to version 3/u);

    const entered = rowFor(ledger, keyed);
    expect(entered).toMatchObject({ state: 'open', daysOpen: 35, mayBeMoreReasons: ['entered-at-gap'], firstSeenAtFirstBaseline: false });
    expect(entered.incomplete.map((gap) => gap.cause)).toEqual(['floor-rewritten', 'not-seen']);
  });

  it('treats a floor it cannot read at one commit as a gap, never as a fix', () => {
    const ledger = buildLedger(
      input([snap(0, floorOf([A, B])), snap(3, null, { unreadable: 'evidence floor entries must be an array' }), snap(5, floorOf([A, C]))]),
    );
    const kept = rowFor(ledger, A);
    expect(kept).toMatchObject({ state: 'open', daysOpen: 41 });
    expect(kept.incomplete.map((gap) => gap.cause)).toEqual(['not-seen']);
    const left = rowFor(ledger, B);
    expect(left).toMatchObject({ state: 'open', daysOpen: 3, mayBeMoreReasons: ['ended-at-gap', 'first-floor-for-screen'] });
    expect(left.incomplete.map((gap) => gap.cause)).toEqual(['floor-unreadable', 'not-seen']);
    expect(left.incomplete[0]?.detail).toContain('evidence floor entries must be an array');
    const entered = rowFor(ledger, C);
    expect(entered).toMatchObject({ firstSeen: { commit: commitAt(5) }, mayBeMoreReasons: ['entered-at-gap'] });
    expect(entered.incomplete.map((gap) => gap.cause)).toEqual(['floor-unreadable', 'not-seen']);
  });

  it('treats a deleted floor file as a gap, never as a fix', () => {
    const ledger = buildLedger(input([snap(0, floorOf([A])), snap(4, null), snap(10, floorOf([A]))]));
    const row = rowFor(ledger, A);
    expect(row.state).toBe('open');
    expect(row.spans.map((span) => span.end?.by ?? null)).toEqual(['gap', null]);
    expect(row.daysOpen).toBe(35);
    expect(row.mayBeMoreReasons).toEqual(['ended-at-gap', 'entered-at-gap', 'first-floor-for-screen']);
    // One note for leaving at the deletion, one for entering the floor written again.
    expect(row.incomplete.map((gap) => gap.cause)).toEqual(['floor-deleted', 'floor-deleted', 'not-seen']);
    expect(row.incomplete.map((gap) => gap.detail).join('\n')).toMatch(/That is not a fix/u);
    expect(row.incomplete.map((gap) => gap.detail).join('\n')).toMatch(/written again later/u);
  });

  it('says which rows a record it could not place in time touched, and never lets it confirm a fix', () => {
    const floor = floorOf([A, B]);
    const offLine = placed(recordOf(floor, [fullScreen('clusters', [[A, 0]])], { commit: commitAt(50), sourceTree: 'tree-50' }), null);
    const ledger = buildLedger(input([snap(0, floor)], historyOn([scanAt(3, floor, [[A, 0]]), offLine, scanAt(5, floor, [[A, 0]])])));
    const row = rowFor(ledger, A);
    expect(row.state).toBe('open');
    expect(row.incomplete.map((gap) => gap.cause)).toEqual(['not-seen', 'record-off-line']);
    expect(row.mayBeLessReasons).toEqual(['history-unplaced', 'not-seen']);
    expect(rowFor(ledger, B).incomplete.map((gap) => gap.cause)).toEqual(['not-seen']);
  });
});

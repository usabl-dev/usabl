/**
 * The effective floor: the committed floor lowered by fixes main has confirmed.
 *
 * The rule under test is one-sided. The history can only lower what a run accepts, never raise it
 * above the floor and never add an identity, so a missing, wrong, or forged history can make a run
 * stricter and never greener than the floor alone.
 */
import { describe, expect, it } from 'vitest';
import { gate } from '../../src/gate/index.js';
import { identityKey } from '../../src/primitives/identity.js';
import { trackDebt } from '../../src/history/track.js';
import { identityId, type HistoryRecord } from '../../src/history/record.js';
import type { Draft, EvidenceFloor } from '../../src/contracts/index.js';
import {
  COMMIT_A, COMMIT_B, dialogAt, entryFor, floorOf, fullScreen, gateInputFor, recordOf, rowButton,
} from './helpers.js';

const DIALOG = entryFor(dialogAt(1), 2);
const DIALOG_FLOOR = floorOf([DIALOG]);

function countAt(floor: EvidenceFloor, key: string): number | undefined {
  return floor.entries.find((entry) => identityKey(entry) === key)?.count;
}

function dialogRun(count: number, over: Partial<HistoryRecord> = {}): HistoryRecord {
  return recordOf(DIALOG_FLOOR, [fullScreen('clusters', [[DIALOG, count]])], over);
}

describe('confirmed fixed', () => {
  it('lowers the accepted count after two consecutive full scans of main see fewer barriers', () => {
    const track = trackDebt(DIALOG_FLOOR, [dialogRun(1), dialogRun(1, { sourceTree: 'tree-b', commit: COMMIT_B })]);

    expect(countAt(track.floor, identityKey(DIALOG))).toBe(1);
    expect(track.identities[0]).toMatchObject({ accepted: 1, state: 'confirmed-fixed' });
  });

  it('turns the proven false green into a regression with no human step', () => {
    // Floor of two at one collapsed identity. One barrier was fixed and main confirmed it twice.
    // A pull request then brings a new barrier to the same identity. Against the committed floor
    // it takes the freed slot and reads as carried; against the effective floor it is new.
    const records = [dialogRun(1), dialogRun(1, { sourceTree: 'tree-b', commit: COMMIT_B })];
    const drafts: Draft[] = [dialogAt(1), dialogAt(7)];

    const today = gate(gateInputFor(DIALOG_FLOOR, drafts, ['clusters']));
    const tracked = gate(gateInputFor(trackDebt(DIALOG_FLOOR, records).floor, drafts, ['clusters']));

    expect(today.accessibilityVerdict).toBe('verified');
    expect(tracked.accessibilityVerdict).toBe('regression');
    expect(tracked.findings.filter((finding) => finding.status === 'new')).toHaveLength(1);
  });

  it('does not release on one scan alone', () => {
    const track = trackDebt(DIALOG_FLOOR, [dialogRun(2), dialogRun(1, { sourceTree: 'tree-b' })]);

    expect(countAt(track.floor, identityKey(DIALOG))).toBe(2);
    expect(track.identities[0]!.state).toBe('open');
  });

  it('does not release when a scan at the floor count comes between two lower ones', () => {
    const track = trackDebt(DIALOG_FLOOR, [
      dialogRun(1, { sourceTree: 'tree-a' }),
      dialogRun(2, { sourceTree: 'tree-b' }),
      dialogRun(1, { sourceTree: 'tree-c' }),
    ]);

    expect(countAt(track.floor, identityKey(DIALOG))).toBe(2);
  });

  it('counts only scans where the screen was fully scanned', () => {
    const partial = recordOf(DIALOG_FLOOR, [{ screenId: 'clusters', coverage: 'partial', identities: [] }]);
    const track = trackDebt(DIALOG_FLOOR, [dialogRun(1), partial]);

    expect(countAt(track.floor, identityKey(DIALOG))).toBe(2);
  });

  it('keeps the higher of the two confirming counts, so either reading again is not a regression', () => {
    const floor = floorOf([entryFor(dialogAt(1), 5)]);
    const entry = floor.entries[0]!;
    const run = (count: number, sourceTree: string) =>
      recordOf(floor, [fullScreen('clusters', [[entry, count]])], { sourceTree });

    const track = trackDebt(floor, [run(2, 'tree-a'), run(3, 'tree-b')]);

    expect(track.floor.entries[0]!.count).toBe(3);
  });

  it('drops an identity whose barriers are all confirmed gone, so its return is new', () => {
    const track = trackDebt(DIALOG_FLOOR, [dialogRun(0), dialogRun(0, { sourceTree: 'tree-b' })]);

    expect(track.floor.entries).toEqual([]);
    expect(track.identities[0]).toMatchObject({ accepted: 0, state: 'confirmed-fixed' });
  });

  it('ignores records written against another floor, because a new floor is a new acceptance', () => {
    const other = floorOf([entryFor(dialogAt(1), 3)]);
    const track = trackDebt(DIALOG_FLOOR, [
      dialogRun(1, { floorHash: recordOf(other, []).floorHash }),
      dialogRun(1, { floorHash: recordOf(other, []).floorHash, sourceTree: 'tree-b' }),
    ]);

    expect(countAt(track.floor, identityKey(DIALOG))).toBe(2);
  });

  it('never lowers a floor from before row keys', () => {
    const v2 = floorOf([DIALOG], 2);
    const run = (sourceTree: string) => recordOf(v2, [fullScreen('clusters', [[DIALOG, 1]])], { sourceTree });

    const track = trackDebt(v2, [run('tree-a'), run('tree-b')]);

    expect(track.floor).toEqual(v2);
  });

  it('judges each row identity by its own row', () => {
    const a = entryFor(rowButton('a'), 1);
    const b = entryFor(rowButton('b'), 1);
    const floor = floorOf([a, b]);
    const run = (sourceTree: string) =>
      recordOf(floor, [fullScreen('jobs', [[a, 0], [b, 1]])], { sourceTree });

    const track = trackDebt(floor, [run('tree-a'), run('tree-b')]);

    expect(track.floor.entries.map((entry) => identityKey(entry))).toEqual([identityKey(b)]);
  });
});

describe('a forged history', () => {
  it('cannot raise an accepted count above the floor', () => {
    const track = trackDebt(DIALOG_FLOOR, [
      dialogRun(9),
      dialogRun(9, { sourceTree: 'tree-b' }),
      dialogRun(1, { sourceTree: 'tree-c' }),
      dialogRun(1, { sourceTree: 'tree-d' }),
      dialogRun(50, { sourceTree: 'tree-e' }),
      dialogRun(50, { sourceTree: 'tree-f' }),
    ]);

    for (const entry of track.floor.entries) {
      expect(entry.count).toBeLessThanOrEqual(DIALOG.count);
    }
    expect(countAt(track.floor, identityKey(DIALOG))).toBe(1);
  });

  it('keeps the floor count when every record claims more than the floor accepts', () => {
    const track = trackDebt(DIALOG_FLOOR, [dialogRun(7), dialogRun(8, { sourceTree: 'tree-b' })]);

    expect(track.floor).toEqual(DIALOG_FLOOR);
  });

  it('cannot add an identity the floor does not hold', () => {
    const stranger = entryFor(dialogAt(1, { screenId: 'settings' }), 4);
    const otherRule = entryFor(dialogAt(1, { rule: 'pf-dialog-label' }), 4);
    const records = [0, 1].map((n) =>
      recordOf(DIALOG_FLOOR, [
        fullScreen('clusters', [[DIALOG, 2], [otherRule, 4]]),
        fullScreen('settings', [[stranger, 4]]),
      ], { sourceTree: `tree-${n}` }),
    );

    const track = trackDebt(DIALOG_FLOOR, records);

    expect(track.floor.entries.map((entry) => identityKey(entry))).toEqual([identityKey(DIALOG)]);
    expect(track.identities.map((identity) => identity.entry)).toEqual([DIALOG]);
  });

  it('cannot release an identity by reusing its hash under another rule or basis', () => {
    const forged = (sourceTree: string): HistoryRecord =>
      recordOf(DIALOG_FLOOR, [{
        screenId: 'clusters',
        coverage: 'full',
        identities: [{ id: identityId(DIALOG), rule: 'image-alt', basis: 'name', count: 0 }],
      }], { sourceTree });

    const track = trackDebt(DIALOG_FLOOR, [forged('tree-a'), forged('tree-b')]);

    expect(track.floor).toEqual(DIALOG_FLOOR);
  });

  it('gives the same effective floor for the same floor and records', () => {
    const records = [dialogRun(1), dialogRun(1, { sourceTree: 'tree-b' })];

    expect(trackDebt(DIALOG_FLOOR, records)).toEqual(trackDebt(DIALOG_FLOOR, records));
  });
});

describe('intermittent', () => {
  it('restores the slot when a confirmed fix reappears on an unchanged tree, and never releases it again', () => {
    const records = [
      dialogRun(1, { sourceTree: 'tree-a' }),
      dialogRun(1, { sourceTree: 'tree-a' }),
      dialogRun(2, { sourceTree: 'tree-a' }),
      dialogRun(1, { sourceTree: 'tree-b' }),
      dialogRun(1, { sourceTree: 'tree-c' }),
    ];

    const track = trackDebt(DIALOG_FLOOR, records);

    expect(track.identities[0]).toMatchObject({ accepted: 2, state: 'intermittent' });
    expect(countAt(track.floor, identityKey(DIALOG))).toBe(2);
  });

  it('blocks no pull request that sees the barrier again', () => {
    const records = [
      dialogRun(1, { sourceTree: 'tree-a' }),
      dialogRun(1, { sourceTree: 'tree-a' }),
      dialogRun(2, { sourceTree: 'tree-a' }),
    ];
    const effective = trackDebt(DIALOG_FLOOR, records).floor;

    const out = gate(gateInputFor(effective, [dialogAt(1), dialogAt(2)], ['clusters']));

    expect(out.accessibilityVerdict).toBe('verified');
  });

  it('keeps a fix that returns after the code changed, because that is a regression', () => {
    const records = [
      dialogRun(1, { sourceTree: 'tree-a' }),
      dialogRun(1, { sourceTree: 'tree-b' }),
      dialogRun(2, { sourceTree: 'tree-c' }),
    ];

    const track = trackDebt(DIALOG_FLOOR, records);

    expect(track.identities[0]).toMatchObject({ accepted: 1, state: 'confirmed-fixed' });
  });

  it('does not flap when a table shows different rows on an unchanged tree across 10 runs', () => {
    const rows = ['a', 'b', 'c', 'd'];
    const entries = rows.map((row) => entryFor(rowButton(row), 1));
    const floor = floorOf(entries);
    // Which rows each scan of the same tree showed. The data behind the table changes, the code
    // does not. The first scan shows what baseline floored.
    const shown = [
      ['a', 'b', 'c', 'd'], ['a', 'b', 'c'], ['a', 'b'], ['a', 'b', 'd'], ['b', 'c', 'd'],
      ['a', 'c'], ['a', 'b', 'c', 'd'], ['a'], ['a', 'd'], ['b', 'c'],
    ];
    const records: HistoryRecord[] = [];
    const verdicts: Array<string | null> = [];
    for (const [index, present] of shown.entries()) {
      const drafts = present.map((row) => rowButton(row));
      // The run is judged against the history so far, then recorded.
      const effective = trackDebt(floor, records).floor;
      verdicts.push(gate(gateInputFor(effective, drafts, ['jobs'])).accessibilityVerdict);
      // A pull request that shows every row is judged against the same history.
      verdicts.push(gate(gateInputFor(effective, rows.map((row) => rowButton(row)), ['jobs'])).accessibilityVerdict);
      records.push(recordOf(floor, [fullScreen('jobs', entries.map((entry, n) => [entry, present.includes(rows[n]!) ? 1 : 0]))], {
        sourceTree: 'tree-a', time: `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      }));
    }

    expect(verdicts).toEqual(Array.from({ length: 20 }, () => 'verified'));
    expect(trackDebt(floor, records).floor).toEqual(floor);
  });
});

describe('first seen', () => {
  it('is the time of the first record that saw a barrier there', () => {
    const track = trackDebt(DIALOG_FLOOR, [
      recordOf(DIALOG_FLOOR, [{ screenId: 'clusters', coverage: 'partial', identities: [] }], { time: '2026-09-01T00:00:00.000Z' }),
      dialogRun(2, { time: '2026-09-15T00:00:00.000Z', commit: COMMIT_A }),
      dialogRun(2, { time: '2026-10-01T00:00:00.000Z', commit: COMMIT_B }),
    ]);

    expect(track.identities[0]!.firstSeen).toBe('2026-09-15T00:00:00.000Z');
  });
});

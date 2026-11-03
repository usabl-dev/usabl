/**
 * The floor a run is judged against. Every way the history can be missing or wrong leaves the
 * floor as committed and says why, so a run without a usable history gives exactly today's
 * verdicts.
 */
import { describe, expect, it } from 'vitest';
import { debtStatusOf, loadDebtTracking } from '../../src/history/tracking.js';
import { serializeRecord } from '../../src/history/record.js';
import { COMMIT_A, COMMIT_B, dialogAt, entryFor, floorOf, fullScreen, makeFakeHistory, recordOf } from './helpers.js';

const DIALOG = entryFor(dialogAt(1), 2);
const FLOOR = floorOf([DIALOG]);

function lines(...records: ReturnType<typeof recordOf>[]): string {
  return records.map((record) => `${serializeRecord(record)}\n`).join('');
}

function run(count: number, over: Parameters<typeof recordOf>[2] = {}) {
  return recordOf(FLOOR, [fullScreen('clusters', [[DIALOG, count]])], over);
}

describe('loadDebtTracking', () => {
  it('judges against the floor as committed when tracking is off', async () => {
    const tracking = await loadDebtTracking(undefined, FLOOR, 'HEAD');

    expect(tracking.effectiveFloor).toBe(FLOOR);
  });

  it('does not track a floor from before row keys, and says why', async () => {
    const v2 = floorOf([DIALOG], 2);
    const store = makeFakeHistory({
      refs: { 'origin/usabl/history': 'h1', HEAD: COMMIT_B },
      main: { [COMMIT_B]: [COMMIT_A] },
      commits: { h1: { '2026-10.jsonl': lines(run(1, { commit: COMMIT_A, sourceTree: 't1' }), run(1, { commit: COMMIT_B, sourceTree: 't2' })) } },
    });

    const tracking = await loadDebtTracking(store.writer, v2, 'HEAD');

    expect(tracking.effectiveFloor).toBe(v2);
    expect(tracking.read).toMatchObject({ kind: 'off', cause: 'old-floor', head: 'h1' });
  });

  it('lowers the floor by the fixes confirmed up to the base commit', async () => {
    const store = makeFakeHistory({
      refs: { 'origin/usabl/history': 'h1', HEAD: COMMIT_B },
      main: { [COMMIT_B]: [COMMIT_A] },
      commits: { h1: { '2026-10.jsonl': lines(run(1, { commit: COMMIT_A, sourceTree: 't1' }), run(1, { commit: COMMIT_B, sourceTree: 't2' })) } },
    });

    const tracking = await loadDebtTracking(store.writer, FLOOR, 'HEAD');

    expect(tracking.effectiveFloor.entries.map((entry) => entry.count)).toEqual([1]);
  });
});

describe('debtStatusOf', () => {
  it('counts fixed in this run from the headroom against the effective floor', async () => {
    const store = makeFakeHistory({
      refs: { 'origin/usabl/history': 'h1', HEAD: COMMIT_B },
      main: { [COMMIT_B]: [COMMIT_A] },
      commits: { h1: { '2026-10.jsonl': lines(
        run(2, { commit: COMMIT_A, sourceTree: 't0', time: '2026-09-17T00:00:00.000Z' }),
        run(1, { commit: COMMIT_A, sourceTree: 't1', time: '2026-10-01T00:00:00.000Z' }),
        run(1, { commit: COMMIT_B, sourceTree: 't2', time: '2026-10-02T00:00:00.000Z' }),
      ) } },
    });
    const tracking = await loadDebtTracking(store.writer, FLOOR, 'HEAD');

    const status = debtStatusOf(tracking, [{ screenId: 'clusters', rule: DIALOG.rule, recorded: 1, observed: 0 }], '2026-10-28T00:00:00.000Z');

    expect(status).toEqual({
      tracking: 'on', off: null, historyHead: 'h1',
      floorBarriers: 2, acceptedBarriers: 1, confirmedFixed: 1, fixedThisRun: 1, remaining: 0,
      oldestOpenDays: 41, intermittent: 0,
    });
  });
});

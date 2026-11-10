/**
 * `usabl debt` prints its rows in one order on every machine. The rows used to sort with
 * localeCompare, which puts `apps` before `Zones` under most locales while code units put `Zones`
 * first, so the printed order followed the machine.
 */
import { describe, expect, it } from 'vitest';
import type { EvidenceFloor, FloorEntry } from '../../src/contracts/index.js';
import { off } from '../../src/history/read.js';
import { debtReport } from '../../src/history/report.js';

function entry(screenId: string, rule: string): FloorEntry {
  return { screenId, layer: 'axe', rule, elementKey: null, identityBasis: 'count', count: 1 };
}

describe('the debt report row order', () => {
  it('sorts screens and rules by code units, not by the locale', () => {
    const floor: EvidenceFloor = {
      version: 3,
      entries: [entry('apps', 'label'), entry('Zones', 'label'), entry('apps', 'Region'), entry('apps', 'aria-hidden')],
    };
    const report = debtReport(
      { floor, effectiveFloor: floor, read: off('no-history', null), identities: [] },
      '2026-11-10T00:00:00.000Z',
    );
    expect(report.rows.map((row) => [row.screenId, row.rule])).toEqual([
      ['Zones', 'label'],
      ['apps', 'Region'],
      ['apps', 'aria-hidden'],
      ['apps', 'label'],
    ]);
  });
});

/**
 * A history record holds hashes and counts only. It travels to a branch anyone with read access to
 * the repository can read, so it must never hold an element key or any text from a page.
 */
import { describe, expect, it } from 'vitest';
import {
  buildRecord, floorHashOf, historyFileFor, HistoryRefusedError, identityId, isHistoryFile,
  parseHistoryFile, parseRecord, serializeRecord,
} from '../../src/history/record.js';
import { trackDebt } from '../../src/history/track.js';
import { gate } from '../../src/gate/index.js';
import {
  COMMIT_A, COMMIT_B, dialogAt, entryFor, floorOf, gateInputFor, POLICY, recordOf, rowButton, SCANNERS, scanOf,
} from './helpers.js';

const MARKER = 'zz-marker-zz';

function input(over: Partial<Parameters<typeof buildRecord>[0]> = {}): Parameters<typeof buildRecord>[0] {
  return {
    time: '2026-10-28T00:00:00.000Z', commit: COMMIT_A, sourceTree: 'tree-a', policyHash: POLICY,
    runnerVersion: '0.3.0-test', scannerVersions: SCANNERS, floor: floorOf([]), screens: [], ...over,
  };
}

describe('buildRecord', () => {
  it('never puts a name, a key, or a path from the page into the record', () => {
    // Every page-derived field carries the marker: the accessible name, the element path, the row
    // key, the table identity, and the text a user would read.
    const named = dialogAt(1, {
      elementName: `Delete ${MARKER}`, elementPath: `#${MARKER} > section`,
      evidence: { name: { value: `Delete ${MARKER}`, source: 'attribute', fromTree: true } },
      whatUserExperiences: `Focus stays behind ${MARKER}`,
    });
    const row = rowButton('a', {
      elementName: MARKER,
      evidence: { extra: { rowScope: { table: `table#${MARKER}`, row: `row-${MARKER}`, role: 'button', path: 'td>button' } } },
    });
    const floor = floorOf([entryFor(named, 1), entryFor(row, 1)]);
    expect(JSON.stringify(floor)).toContain(MARKER);

    const line = serializeRecord(buildRecord(input({
      floor,
      screens: [scanOf('clusters', [named]), scanOf('jobs', [row])],
    })));

    expect(line).not.toContain(MARKER);
    expect(line).not.toContain('Delete');
  });

  it('records each floored identity on a fully scanned screen by hash, rule, basis, and count', () => {
    const floor = floorOf([entryFor(dialogAt(1), 2)]);
    const record = buildRecord(input({ floor, screens: [scanOf('clusters', [dialogAt(1), dialogAt(4)])] }));

    expect(record.floorHash).toBe(floorHashOf(floor));
    expect(record.screens).toEqual([{
      screenId: 'clusters', coverage: 'full',
      identities: [{ id: identityId(floor.entries[0]!), rule: 'pf-focus-into-dialog', basis: 'structural', count: 2 }],
    }]);
  });

  it('records no identities for a screen scanned with a gap', () => {
    const floor = floorOf([entryFor(dialogAt(1), 2)]);
    const gapped = scanOf('clusters', [dialogAt(1)], { gaps: [{ ref: 'clusters', state: 'not-covered', reason: 'timed out' }] });

    const record = buildRecord(input({ floor, screens: [gapped] }));

    expect(record.screens).toEqual([{ screenId: 'clusters', coverage: 'partial', identities: [] }]);
  });

  it('counts a screen scanned twice as full only when both scans were clean', () => {
    const floor = floorOf([entryFor(dialogAt(1), 2)]);
    const gapped = scanOf('clusters', [], { gaps: [{ ref: 'clusters', state: 'not-covered', reason: 'timed out' }] });

    const record = buildRecord(input({ floor, screens: [scanOf('clusters', [dialogAt(1)]), gapped] }));

    expect(record.screens[0]!.coverage).toBe('partial');
  });

  it('records an absent identity as zero only when the readiness signal shows the screen rendered', () => {
    const floor = floorOf([entryFor(dialogAt(1), 1)]);
    const held = buildRecord(input({ floor, screens: [scanOf('clusters', [])] }));
    const unsure = buildRecord(input({
      floor,
      screens: [scanOf('clusters', [], { reachedSelectorPresent: null, reachedWhenSelector: null })],
    }));

    expect(held.screens[0]!.identities.map((identity) => identity.count)).toEqual([0]);
    expect(unsure.screens[0]).toEqual({ screenId: 'clusters', coverage: 'full', identities: [] });
  });

  it('records a count below the floor only when the readiness signal shows the screen rendered', () => {
    // The header rendered and the content did not: the signal did not hold, there is no gap, and
    // only one of the three dialogs was drawn. That lower count is not evidence of a fix.
    const floor = floorOf([entryFor(dialogAt(1), 3)]);
    const halfDrawn = scanOf('clusters', [dialogAt(1)], { reachedSelectorPresent: false });
    const scans = [
      buildRecord(input({ floor, screens: [halfDrawn] })),
      buildRecord(input({ floor, commit: COMMIT_B, sourceTree: 'tree-b', screens: [halfDrawn] })),
    ];

    expect(scans[0]!.screens[0]).toEqual({ screenId: 'clusters', coverage: 'full', identities: [] });
    const track = trackDebt(floor, scans);
    expect(track.floor.entries.map((entry) => entry.count)).toEqual([3]);
    const pr = gate(gateInputFor(track.floor, [dialogAt(1), dialogAt(2), dialogAt(3)], ['clusters']));
    expect(pr.accessibilityVerdict).toBe('verified');
  });

  it('records a count below the floor when the readiness signal held', () => {
    const floor = floorOf([entryFor(dialogAt(1), 3)]);
    const record = buildRecord(input({ floor, screens: [scanOf('clusters', [dialogAt(1)])] }));

    expect(record.screens[0]!.identities.map((identity) => identity.count)).toEqual([1]);
  });

  it('records a count equal to the floor count with no readiness signal', () => {
    const floor = floorOf([entryFor(dialogAt(1), 1)]);
    const record = buildRecord(input({
      floor,
      screens: [scanOf('clusters', [dialogAt(1)], { reachedSelectorPresent: false })],
    }));

    expect(record.screens[0]!.identities.map((identity) => identity.count)).toEqual([1]);
  });
});

describe('parseRecord', () => {
  it('reads back what serializeRecord wrote', () => {
    const record = recordOf(floorOf([]), []);

    expect(parseRecord(JSON.parse(serializeRecord(record)))).toEqual(record);
  });

  it('refuses a field a record does not hold, so a record cannot carry extra text', () => {
    const record = { ...recordOf(floorOf([]), []), note: 'anything' };

    expect(() => parseRecord(record)).toThrow(HistoryRefusedError);
  });

  it('refuses an identity that carries a key instead of a hash', () => {
    const record = recordOf(floorOf([]), [{
      screenId: 'jobs', coverage: 'full',
      identities: [{ id: 'jobs|button-name|name:edit', rule: 'button-name', basis: 'name', count: 1 }],
    }]);

    expect(() => parseRecord(record)).toThrow(/id must be 16 lowercase hex characters/);
  });

  it('refuses identities on a partial screen, a repeated screen, and a negative count', () => {
    const base = recordOf(floorOf([]), []);
    const identity = { id: '0'.repeat(16), rule: 'button-name', basis: 'count' as const, count: 1 };

    expect(() => parseRecord({ ...base, screens: [{ screenId: 'jobs', coverage: 'partial', identities: [identity] }] })).toThrow(HistoryRefusedError);
    expect(() => parseRecord({ ...base, screens: [{ screenId: 'jobs', coverage: 'partial', identities: [] }, { screenId: 'jobs', coverage: 'partial', identities: [] }] })).toThrow(HistoryRefusedError);
    expect(() => parseRecord({ ...base, screens: [{ screenId: 'jobs', coverage: 'full', identities: [{ ...identity, count: -1 }] }] })).toThrow(HistoryRefusedError);
  });

  it('names the file, the line, and the field, never the value', () => {
    const good = serializeRecord(recordOf(floorOf([]), []));
    const bad = JSON.stringify({ ...JSON.parse(good), commit: MARKER });

    let message = '';
    try {
      parseHistoryFile(`${good}\n${bad}\n`, '2026-10.jsonl');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe('2026-10.jsonl line 2.commit must be a full commit id');
    expect(message).not.toContain(MARKER);
  });
});

describe('history files', () => {
  it('names one file per month', () => {
    expect(historyFileFor('2026-10-28T09:00:00.000Z')).toBe('2026-10.jsonl');
    expect(isHistoryFile('2026-10.jsonl')).toBe(true);
    expect(isHistoryFile('README.md')).toBe(false);
    expect(isHistoryFile('2026-13.jsonl')).toBe(false);
  });

  it('reads every line in order and refuses a line that is not JSON', () => {
    const one = serializeRecord(recordOf(floorOf([]), [], { time: '2026-10-01T00:00:00.000Z' }));
    const two = serializeRecord(recordOf(floorOf([]), [], { time: '2026-10-02T00:00:00.000Z' }));

    expect(parseHistoryFile(`${one}\n${two}\n`, '2026-10.jsonl').map((record) => record.time)).toEqual([
      '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z',
    ]);
    expect(() => parseHistoryFile(`${one}\n{\n`, '2026-10.jsonl')).toThrow('2026-10.jsonl line 2 is not JSON');
  });
});

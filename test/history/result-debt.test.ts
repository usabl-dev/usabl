/**
 * The debt field and the history binding as they cross a boundary: the Result document CI hands
 * from one job to the next, the scrubbed copy surfaces print, and the receipt the Stop hook keeps.
 */
import { describe, expect, it } from 'vitest';
import { parseResultDocument } from '../../src/intake/result-document.js';
import { scrubResult } from '../../src/surfaces/scrub.js';
import { loadReceipt } from '../../src/surfaces/receipt-store.js';
import type { DebtStatus, Result } from '../../src/contracts/index.js';

const DEBT: DebtStatus = {
  tracking: 'off',
  off: { cause: 'unreadable', detail: '2026-10.jsonl line 2.time is missing' },
  historyHead: 'h1',
  floorBarriers: 3, acceptedBarriers: 3, confirmedFixed: 0, fixedThisRun: 1, remaining: 2,
  oldestOpenDays: null, intermittent: 0,
};

const RESULT: Result = {
  schemaVersion: 'usabl.result.v1', verdict: 'verified', summary: 'verified: nothing blocking', screens: [],
  coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
  findings: [], receipt: null, dirtyGuardedPaths: [], exitCode: 0, accessibilityVerdict: 'verified',
  accessibilityExitCode: 0, paidDownCount: 0, floorHeadroom: [], floorUnconfirmed: [], debt: DEBT,
};

describe('the debt field', () => {
  it('survives the Result document and the scrubbed copy', () => {
    expect(parseResultDocument(JSON.parse(JSON.stringify(RESULT))).debt).toEqual(DEBT);
    expect(scrubResult(RESULT).debt).toEqual(DEBT);
  });

  it('is optional, so a Result from an older engine still reads', () => {
    const { debt: _debt, ...older } = RESULT;

    expect(parseResultDocument(JSON.parse(JSON.stringify(older))).debt).toBeUndefined();
  });

  it('refuses a cause outside the closed set', () => {
    const forged = { ...RESULT, debt: { ...DEBT, off: { cause: 'everything is fine', detail: null } } };

    expect(() => parseResultDocument(JSON.parse(JSON.stringify(forged)))).toThrow(/debt\.off\.cause/);
  });
});

describe('a stored receipt from before the history binding', () => {
  it('is not read, so the Stop hook runs one full check', async () => {
    const v1 = {
      schemaVersion: 1, sourceTree: 't', baseRevision: null, policyHash: 'p', runnerVersion: 'r',
      scannerVersions: { axeCore: 'a', playwright: 'b', chromium: 'c' }, surfaces: [],
      coverage: { checked: [], notCovered: [] }, applicability: [], verdict: 'verified',
      findingsSummary: { new: 0, carried: 0, fixed: 0, unverified: 0 }, activeWaivers: 0, mintedAt: 'm',
    };

    expect(await loadReceipt({ readFile: async () => JSON.stringify(v1) })).toBeNull();
    expect(await loadReceipt({ readFile: async () => JSON.stringify({ ...v1, schemaVersion: 2, historyHead: null }) })).not.toBeNull();
  });
});

/**
 * Provider notes on a screen survive the Result document, and a Result written by an engine that
 * had no notes still parses, with none.
 */
import { describe, expect, it } from 'vitest';
import type { Result, ScreenScan } from '../../src/contracts/index.js';
import { parseResultDocument } from '../../src/intake/result-document.js';

const NOTE = {
  ref: 'provider:rhds-rulepack/out-of-document',
  reason: '2 RHDS element(s) sit inside frames or shadow roots, which the RHDS rulepack does not read, so the RHDS rules did not check them.',
};

function resultWith(extra: Record<string, unknown>): unknown {
  const screen = {
    screenId: 'users', url: 'http://app.test/users', stops: [], drafts: [], gaps: [], applicability: [],
    reachedSelectorPresent: null, ...extra,
  } as unknown as ScreenScan;
  const result: Result = {
    schemaVersion: 'usabl.result.v1', verdict: 'verified', summary: 'verified: nothing blocking', screens: [screen],
    coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
    findings: [], receipt: null, dirtyGuardedPaths: [], exitCode: 0, accessibilityVerdict: 'verified',
    accessibilityExitCode: 0, paidDownCount: 0, floorHeadroom: [], floorUnconfirmed: [],
  };
  return JSON.parse(JSON.stringify(result));
}

describe('provider notes in the Result document', () => {
  it('keeps each note with its ref and reason', () => {
    expect(parseResultDocument(resultWith({ notes: [NOTE] })).screens[0]?.notes).toEqual([NOTE]);
  });

  it('reads a screen with no notes field, as an older engine wrote it, as no notes', () => {
    expect(parseResultDocument(resultWith({})).screens[0]?.notes).toEqual([]);
  });

  it('refuses a note that is not a ref and a reason', () => {
    expect(() => parseResultDocument(resultWith({ notes: [{ ref: 'x' }] }))).toThrow(/notes/);
    expect(() => parseResultDocument(resultWith({ notes: [{ ref: 3, reason: 'r' }] }))).toThrow(/notes/);
    expect(() => parseResultDocument(resultWith({ notes: 'none' }))).toThrow(/notes/);
  });
});

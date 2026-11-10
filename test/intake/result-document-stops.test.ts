/**
 * A transcript stop where focus could not be read keeps that reason through the Result document,
 * so a later job never reads the stop's empty announcement as a control with no name.
 */
import { describe, expect, it } from 'vitest';
import type { Result, ScreenScan, TranscriptStop } from '../../src/contracts/index.js';
import { parseResultDocument } from '../../src/intake/result-document.js';

const UNREADABLE: TranscriptStop = { index: 0, elementPath: 'x-host', announcement: [], focusUnreadable: 'closed-shadow-root' };
const READABLE: TranscriptStop = { index: 1, elementPath: '#save', announcement: [] };

function resultWith(stops: unknown[]): unknown {
  const screen = {
    screenId: 'users', url: 'http://app.test/users', stops, drafts: [], gaps: [], applicability: [],
    reachedSelectorPresent: null,
  } as unknown as ScreenScan;
  const result: Result = {
    schemaVersion: 'usabl.result.v1', verdict: 'verified', summary: 'verified: nothing blocking', screens: [screen],
    coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
    findings: [], receipt: null, dirtyGuardedPaths: [], exitCode: 0, accessibilityVerdict: 'verified',
    accessibilityExitCode: 0, paidDownCount: 0, floorHeadroom: [], floorUnconfirmed: [],
  };
  return JSON.parse(JSON.stringify(result));
}

describe('a transcript stop in the Result document', () => {
  it('keeps the reason focus could not be read, and adds none where it could', () => {
    expect(parseResultDocument(resultWith([UNREADABLE, READABLE])).screens[0]?.stops).toEqual([UNREADABLE, READABLE]);
  });

  it('refuses a reason outside the closed set', () => {
    expect(() => parseResultDocument(resultWith([{ ...READABLE, focusUnreadable: 'fine' }]))).toThrow(/focusUnreadable/);
  });

  it('keeps the fact that the body had focus, and refuses any value but true', () => {
    const onBody: TranscriptStop = { index: 2, elementPath: '#app', announcement: [], onBody: true };
    expect(parseResultDocument(resultWith([onBody, READABLE])).screens[0]?.stops).toEqual([onBody, READABLE]);
    expect(() => parseResultDocument(resultWith([{ ...READABLE, onBody: false }]))).toThrow(/onBody/);
  });
});

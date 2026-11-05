/**
 * A provider note is printed for a reader beside the coverage gaps, labelled as a disclosure that
 * does not block, on every surface that lists gaps for a person or a model. It never changes the
 * verdict, and a run with no notes prints nothing new.
 */
import { describe, expect, it } from 'vitest';
import type { ProviderNote, Result, ScreenScan } from '../../src/contracts/index.js';
import { formatSummary } from '../../src/output/summary.js';
import { notePieces } from '../../src/surfaces/model-pieces.js';
import { projectPrComment } from '../../src/surfaces/pr-comment.js';
import { projectSelfCheck } from '../../src/surfaces/self-check.js';
import { evaluateStopDecision } from '../../src/surfaces/stop-hook.js';

const NOTE: ProviderNote = {
  ref: 'provider:rhds-rulepack/out-of-document',
  reason: '4 RHDS element(s) sit inside frames or shadow roots, which the RHDS rulepack does not read, so the RHDS rules did not check them.',
};

function screen(screenId: string, notes?: ProviderNote[]): ScreenScan {
  return {
    screenId,
    url: `http://app.test/${screenId}`,
    stops: [],
    drafts: [],
    gaps: [],
    applicability: [],
    ...(notes === undefined ? {} : { notes }),
    reachedSelectorPresent: null,
  };
}

function result(screens: ScreenScan[]): Result {
  return {
    schemaVersion: 'usabl.result.v1',
    verdict: 'verified',
    summary: 'verified: 0 gating finding(s)',
    screens,
    coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
    findings: [],
    receipt: null,
    dirtyGuardedPaths: [],
    exitCode: 0,
    accessibilityVerdict: 'verified',
    accessibilityExitCode: 0,
    paidDownCount: 0,
    floorHeadroom: [],
    floorUnconfirmed: [],
  };
}

const WITH_NOTE = result([screen('settings', [NOTE]), screen('home', [])]);
const WITHOUT_NOTES = result([screen('settings', []), screen('home')]);

describe('provider notes on the surfaces', () => {
  it('prints each note in the terminal summary as a disclosure that does not block, beside a verified verdict', () => {
    const text = formatSummary(WITH_NOTE);
    expect(text).toContain('VERIFIED');
    expect(text).toContain('  disclosed, does not block: 1 note(s)');
    expect(text).toContain(`    settings: ${NOTE.ref}: ${NOTE.reason}`);
    expect(text).not.toContain('not evaluated');
  });

  it('prints no note section when no screen has a note', () => {
    expect(formatSummary(WITHOUT_NOTES)).not.toContain('disclosed');
    expect(projectPrComment(WITHOUT_NOTES)).not.toContain('Disclosed');
    expect(notePieces(WITHOUT_NOTES)).toEqual([]);
  });

  it('lists each note in the pull request comment under its own heading, after the coverage gaps', () => {
    const comment = projectPrComment(WITH_NOTE);
    const gaps = comment.indexOf('### Coverage gaps');
    const notes = comment.indexOf('### Disclosed, does not block');
    expect(gaps).toBeGreaterThan(-1);
    expect(notes).toBeGreaterThan(gaps);
    const section = comment.slice(notes);
    expect(section).toContain('settings');
    expect(section).toContain('provider:rhds-rulepack/out-of-document');
    expect(section).toContain('the RHDS rules did not check them.');
  });

  it('gives a model one plain piece per note, and adds it to the self-check message', () => {
    expect(notePieces(WITH_NOTE)).toEqual([`disclosed, does not block: settings: ${NOTE.ref}: ${NOTE.reason}`]);
    const message = projectSelfCheck(WITH_NOTE).message;
    expect(message).toContain('disclosed, does not block: settings: provider:rhds-rulepack/out-of-document');
    expect(projectSelfCheck(WITH_NOTE).verdict).toBe('verified');
  });

  it('lets a verified stop through with the note framed after the allow line, and leaves a stop with no notes as it was', () => {
    const decision = evaluateStopDecision(WITH_NOTE, { stopHookActive: false });
    expect(decision.block).toBe(false);
    expect(decision.message).toContain('the gate verified this change. You may stop.');
    expect(decision.message).toContain('disclosed, does not block: settings: provider:rhds-rulepack/out-of-document');
    const plain = evaluateStopDecision(WITHOUT_NOTES, { stopHookActive: false });
    expect(plain.message).not.toContain('disclosed');
  });

  it('reads a screen list or a note list that is not a list as no notes', () => {
    const odd = { ...result([]), screens: 'none' } as unknown as Result;
    expect(notePieces(odd)).toEqual([]);
    const oddNotes = result([{ ...screen('x'), notes: 'none' } as unknown as ScreenScan]);
    expect(notePieces(oddNotes)).toEqual([]);
  });
});

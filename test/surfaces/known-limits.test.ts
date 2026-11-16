/**
 * A region the keyboard walk could not read, and that the team listed for the screen in
 * usabl.config.json, is a known limit. The run can still be verified, but every surface that shows
 * the result says it has known limits and names the region, so no reader takes the verdict for a
 * check of the whole screen. A listing that matched nothing is a note, never a known limit.
 */
import { describe, expect, it } from 'vitest';
import type { ProviderNote, Result, ScreenScan } from '../../src/contracts/index.js';
import { generateKeyboardPaths } from '../../src/docs/keyboard-paths.js';
import { STALE_REGION_LISTING_NOTE_REF, UNREAD_REGION_NOTE_REF } from '../../src/output/notes.js';
import { formatSummary } from '../../src/output/summary.js';
import { renderDocsHtml } from '../../src/surfaces/docs-html.js';
import { projectPrComment } from '../../src/surfaces/pr-comment.js';
import { frameUntrusted } from '../../src/surfaces/scrub.js';
import { projectSelfCheck } from '../../src/surfaces/self-check.js';
import { evaluateStopDecision } from '../../src/surfaces/stop-hook.js';
import { projectOverlay } from '../../src/surfaces/vite-plugin.js';

const LIMIT: ProviderNote = {
  ref: UNREAD_REGION_NOTE_REF,
  reason:
    'on screen settings, the keyboard walk could not read inside a frame from https://chat.example.com at tab stop 3, ' +
    'so this region was not checked. usabl.config.json lists it as a known limit for this screen under ' +
    'keyboardWalk.perSurface.settings.unreadableRegions, so it does not block. Check the controls inside it by hand.',
};

const STALE: ProviderNote = {
  ref: STALE_REGION_LISTING_NOTE_REF,
  reason: 'on screen settings, the listing {"shadowHost": "chat-widget"} matched no region the keyboard walk met.',
};

function screen(screenId: string, notes: ProviderNote[]): ScreenScan {
  return {
    screenId,
    url: `http://app.test/${screenId}`,
    stops: [{ index: 0, elementPath: '#first', announcement: [] }],
    drafts: [],
    gaps: [],
    applicability: [],
    notes,
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

const LIMITED = result([screen('settings', [LIMIT]), screen('home', [])]);
const STALE_ONLY = result([screen('settings', [STALE])]);

describe('a known limit on every surface', () => {
  it('says so in the terminal summary verdict line, and lists the region', () => {
    const text = formatSummary(LIMITED);
    expect(text).toContain('VERIFIED (exit 0, with known limits)');
    expect(text).toContain('No new accessibility barrier blocks this change. Parts your team listed as known limits were not checked.');
    expect(text).toContain(`settings: ${UNREAD_REGION_NOTE_REF}: ${LIMIT.reason}`);
  });

  it('says so in the pull request comment heading, and lists the region', () => {
    const comment = projectPrComment(LIMITED);
    expect(comment).toContain('## usabl report: VERIFIED, with known limits\n');
    expect(comment.slice(comment.indexOf('### Disclosed, does not block'))).toContain('a frame from https://chat.example.com');
  });

  it('says so in the stop hook message and the self-check message', () => {
    const decision = evaluateStopDecision(LIMITED, { stopHookActive: false });
    expect(decision.block).toBe(false);
    expect(decision.message).toContain('with known limits');
    expect(decision.message).toContain('a frame from https://chat.example.com');

    const check = projectSelfCheck(LIMITED);
    expect(check.verdict).toBe('verified');
    expect(check.message).toContain('with known limits');
    expect(check.message).toContain('a frame from https://chat.example.com');
  });

  it('hands the overlay the notes, framed, and whether the run has known limits', () => {
    const payload = projectOverlay(LIMITED);
    expect(payload.knownLimits).toBe(true);
    expect(payload.notes).toEqual([{ screenId: 'settings', ref: UNREAD_REGION_NOTE_REF, reason: frameUntrusted(LIMIT.reason) }]);

    const plain = projectOverlay(result([screen('home', [])]));
    expect(plain.knownLimits).toBe(false);
    expect(plain.notes).toEqual([]);
  });

  it('lists the region on the keyboard walk order the docs output writes, and renders it', () => {
    const [settings, home] = generateKeyboardPaths(LIMITED);
    expect(settings?.limits).toEqual([LIMIT.reason]);
    expect(home?.limits).toBeUndefined();

    const html = renderDocsHtml([settings!]);
    expect(html).toContain('Known limits');
    expect(html).toContain('a frame from https://chat.example.com');
  });

  it('never calls a stale listing a known limit, on any surface', () => {
    expect(formatSummary(STALE_ONLY)).toContain('VERIFIED (exit 0)');
    expect(formatSummary(STALE_ONLY)).not.toContain('with known limits');
    expect(projectPrComment(STALE_ONLY)).toContain('## usabl report: VERIFIED\n');
    expect(projectPrComment(STALE_ONLY)).not.toContain('with known limits');
    expect(projectOverlay(STALE_ONLY).knownLimits).toBe(false);
    expect(generateKeyboardPaths(STALE_ONLY)[0]?.limits).toBeUndefined();
  });
});

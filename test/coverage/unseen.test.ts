import { describe, it, expect } from 'vitest';
import { markUnseenScreens } from '../../src/coverage/unseen.js';
import type { Draft, ScreenScan, TranscriptStop } from '../../src/contracts/index.js';

function draft(screenId: string, overrides: Partial<Draft> = {}): Draft {
  return {
    rule: 'landmark-one-main',
    layer: 'axe',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId,
    elementPath: 'html',
    elementName: null,
    role: null,
    whatUserExperiences: '',
    why: '',
    fix: '',
    evidence: {},
    confidence: 'fail',
    ...overrides,
  };
}

const stop = (elementPath: string): TranscriptStop => ({ index: 0, elementPath, announcement: [] });

function scan(overrides: Partial<ScreenScan> & { screenId: string; url: string }): ScreenScan {
  return { stops: [], drafts: [], gaps: [], ...overrides };
}

describe('markUnseenScreens', () => {
  it('reads the nth-child ancestry a live page reports for the document body', () => {
    const pass = markUnseenScreens([
      scan({ screenId: 'overview', url: 'http://app/overview', stops: [stop('html > body:nth-child(2)')] }),
    ]);
    expect(pass.unseenScreenIds).toEqual(['overview']);
  });

  it('does not read a body-prefixed tag as the body', () => {
    const pass = markUnseenScreens([
      scan({ screenId: 'overview', url: 'http://app/overview', stops: [stop('html > body:nth-child(2) > bodyguard')] }),
    ]);
    expect(pass.unseenScreenIds).toEqual([]);
  });

  it('treats an empty transcript as no evidence, not as a blank page', () => {
    // Nothing was recorded about the keyboard walk. That is not the same claim as a walk that
    // found nowhere to go, and calling it unseen would drop findings on no grounds at all.
    const pass = markUnseenScreens([
      scan({ screenId: 'overview', url: 'http://app/overview', drafts: [draft('overview')] }),
    ]);
    expect(pass.unseenScreenIds).toEqual([]);
    expect(pass.screens[0]?.drafts).toHaveLength(1);
  });

  it('does not call one URL scanned twice a duplicate render', () => {
    // The app and docs profiles can both target one URL and honestly report the same
    // identities. Only different URLs measuring identically is evidence of a blank page.
    const pass = markUnseenScreens([
      scan({ screenId: 'page-app', url: 'http://app/page', stops: [stop('button')], drafts: [draft('page-app')] }),
      scan({ screenId: 'page-docs', url: 'http://app/page', stops: [stop('button')], drafts: [draft('page-docs')] }),
    ]);
    expect(pass.unseenScreenIds).toEqual([]);
  });

  it('records one gap when both detectors fire on the same screen', () => {
    const blank = (screenId: string, url: string): ScreenScan =>
      scan({ screenId, url, stops: [stop('html > body:nth-child(2)')], drafts: [draft(screenId)] });
    const pass = markUnseenScreens([blank('overview', 'http://app/overview'), blank('jobs', 'http://app/jobs')]);

    expect(pass.unseenScreenIds).toEqual(['overview', 'jobs']);
    for (const screen of pass.screens) {
      expect(screen.gaps).toHaveLength(1);
      expect(screen.gaps[0]?.state).toBe('not-covered');
      expect(screen.gaps[0]?.ref).toBe(screen.url);
      expect(screen.gaps[0]?.reason).toContain('keyboard stop');
      expect(screen.gaps[0]?.reason).toContain('same finding identities');
    }
  });

  it('keeps the gaps a scan already reported', () => {
    const pass = markUnseenScreens([
      scan({
        screenId: 'overview',
        url: 'http://app/overview',
        stops: [stop('html > body:nth-child(2)')],
        gaps: [{ ref: 'provider:walk', state: 'capability-denied', reason: 'provider walk denied capability: live' }],
      }),
    ]);
    expect(pass.screens[0]?.gaps.map((gap) => gap.state)).toEqual(['capability-denied', 'not-covered']);
  });
});

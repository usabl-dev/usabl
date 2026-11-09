import { describe, expect, it } from 'vitest';
import type { AnnouncementToken, InteractionContract, SpeechObligation, TranscriptStop } from '../../src/contracts/index.js';
import { runStructuralTier } from '../../src/voicing/structural.js';

const name = (text: string): AnnouncementToken => ({
  kind: 'name',
  text,
  fromTree: true,
  source: 'ax-tree',
});

const role = (text: string): AnnouncementToken => ({
  kind: 'role',
  text,
  fromTree: true,
  source: 'ax-tree',
});

const live = (text: string): AnnouncementToken => ({
  kind: 'live',
  text,
  fromTree: false,
  source: 'attribute',
});

const stopAt = (index: number, elementPath: string, announcement: AnnouncementToken[]): TranscriptStop => ({
  index,
  elementPath,
  announcement,
});

const dialogObligation: SpeechObligation = {
  class: 'dialog-name',
  afterStep: 1,
  requiredTokens: ['dialog', 'name'],
  focusedRole: 'dialog',
  mustAnnounce: false,
};

const toastObligation: SpeechObligation = {
  class: 'toast-announced',
  afterStep: 1,
  requiredTokens: ['saved'],
  mustAnnounce: true,
};

const contract = (obligations: SpeechObligation[], maxTabPath?: number): InteractionContract => {
  const base: InteractionContract = {
    contractId: 'contract-1',
    surfaceId: 'clusters-page',
    task: 'Open dialog and save',
    steps: [{ do: 'tab' }, { do: 'activate' }],
    obligations,
  };
  if (maxTabPath === undefined) {
    return base;
  }
  return { ...base, maxTabPath };
};

describe('runStructuralTier', () => {
  it('returns no drafts for a clean dialog window', () => {
    const drafts = runStructuralTier(
      contract([dialogObligation], 5),
      [stopAt(1, '/dialog', [role('dialog'), name('Delete cluster')])],
      'screen-1',
    );

    expect(drafts).toHaveLength(0);
  });

  it('does not flag a nameless main stop outside obligation windows', () => {
    const drafts = runStructuralTier(
      contract([dialogObligation], 5),
      [
        stopAt(0, '/main', [role('main')]),
        stopAt(1, '/dialog', [role('dialog'), name('Delete cluster')]),
      ],
      'screen-1',
    );

    expect(drafts).toHaveLength(0);
  });

  it('emits missing-name with deterministic fail evidence when the class is promoted', () => {
    const drafts = runStructuralTier(contract([dialogObligation]), [stopAt(1, '/dialog', [role('dialog')])], 'screen-1', [
      'dialog-name',
    ]);
    const hit = drafts.find((draft) => draft.rule === 'voicing/missing-name');

    expect(hit).toBeDefined();
    expect(hit?.layer).toBe('voicing');
    expect(hit?.confidence).toBe('fail');
    expect(hit?.evidenceClass).toBe('deterministic');
  });

  it('emits missing-role when focused role is absent at the obligation window', () => {
    const drafts = runStructuralTier(contract([dialogObligation]), [stopAt(1, '/dialog', [name('Delete cluster')])], 'screen-1');

    expect(drafts.some((draft) => draft.rule === 'voicing/missing-role')).toBe(true);
  });

  it('emits missing-live-announcement when mustAnnounce is true and no live token is present', () => {
    const drafts = runStructuralTier(contract([toastObligation]), [stopAt(1, '/toast', [name('Saved')])], 'screen-1', [
      'toast-announced',
    ]);
    const hit = drafts.find((draft) => draft.rule === 'voicing/missing-live-announcement');

    expect(hit).toBeDefined();
    expect(hit?.confidence).toBe('fail');
    expect(hit?.evidenceClass).toBe('deterministic');
  });

  it('does not emit missing-live-announcement when any live token is present', () => {
    const drafts = runStructuralTier(
      contract([toastObligation]),
      [stopAt(1, '/toast', [name('Saved'), live('Background sync completed')])],
      'screen-1',
    );

    expect(drafts.filter((draft) => draft.rule === 'voicing/missing-live-announcement')).toHaveLength(0);
  });

  it('emits over-long-tab-path when stops exceed maxTabPath', () => {
    const drafts = runStructuralTier(
      contract([dialogObligation], 1),
      [
        stopAt(0, '/main', [role('main')]),
        stopAt(1, '/dialog', [role('dialog'), name('Delete cluster')]),
      ],
      'screen-1',
    );

    expect(drafts.some((draft) => draft.rule === 'voicing/over-long-tab-path')).toBe(true);
  });

  it('emits unreachable-focus for empty stops and for missing obligation windows', () => {
    const emptyDrafts = runStructuralTier(contract([dialogObligation]), [], 'screen-1');
    expect(emptyDrafts.some((draft) => draft.rule === 'voicing/unreachable-focus')).toBe(true);

    const missingWindowDrafts = runStructuralTier(
      contract([dialogObligation]),
      [stopAt(0, '/main', [role('main')])],
      'screen-1',
    );
    expect(missingWindowDrafts.some((draft) => draft.rule === 'voicing/unreachable-focus')).toBe(true);
  });

  it('emits an unverified focus-unreadable draft instead of missing-name and missing-role when focus cannot be read', () => {
    const unreadable: TranscriptStop = { ...stopAt(1, 'x-host', []), focusUnreadable: 'closed-shadow-root' };
    const drafts = runStructuralTier(contract([dialogObligation]), [unreadable], 'screen-1');

    expect(drafts.map((draft) => [draft.rule, draft.confidence])).toEqual([['voicing/focus-unreadable', 'unverified']]);
    expect(drafts[0]?.why).toContain('closed shadow root');
    expect(drafts[0]?.elementPath).toBe('x-host');
  });

  it('still checks the live announcement at a window where focus cannot be read', () => {
    const unreadable: TranscriptStop = { ...stopAt(1, 'iframe', []), focusUnreadable: 'frame-unreadable' };
    const drafts = runStructuralTier(contract([toastObligation]), [unreadable], 'screen-1', ['toast-announced']);

    expect(drafts.map((draft) => [draft.rule, draft.confidence])).toEqual([
      ['voicing/focus-unreadable', 'unverified'],
      ['voicing/missing-live-announcement', 'fail'],
    ]);
  });

  describe('preview by default', () => {
    // Every obligation class measured below the promotion bar, so nothing from this tier may block
    // until a person lists the class in promotedObligations.
    it('emits a window draft as preview and unverified when its class is not promoted', () => {
      const drafts = runStructuralTier(
        contract([dialogObligation, toastObligation]),
        [stopAt(1, '/dialog', [])],
        'screen-1',
        ['toast-announced'],
      );

      expect(drafts.map((draft) => [draft.rule, draft.evidenceClass, draft.confidence])).toEqual([
        ['voicing/missing-name', 'preview', 'unverified'],
        ['voicing/missing-role', 'preview', 'unverified'],
        ['voicing/missing-name', 'deterministic', 'fail'],
        ['voicing/missing-live-announcement', 'deterministic', 'fail'],
      ]);
    });

    it('keeps every draft preview when no class is promoted', () => {
      const drafts = [
        ...runStructuralTier(contract([dialogObligation, toastObligation], 0), [stopAt(1, '/dialog', [])], 'screen-1'),
        ...runStructuralTier(contract([dialogObligation]), [], 'screen-1'),
        ...runStructuralTier(contract([dialogObligation]), [stopAt(0, '/main', [])], 'screen-1'),
      ];

      expect(drafts.length).toBeGreaterThan(0);
      expect(drafts.every((draft) => draft.evidenceClass === 'preview' && draft.confidence !== 'fail')).toBe(true);
    });

    it('gates a draft about the whole contract only when every obligation class in it is promoted', () => {
      const twoClasses = contract([dialogObligation, toastObligation]);
      const onlyOne = runStructuralTier(twoClasses, [], 'screen-1', ['dialog-name']);
      const both = runStructuralTier(twoClasses, [], 'screen-1', ['dialog-name', 'toast-announced']);

      expect(onlyOne.map((draft) => [draft.rule, draft.evidenceClass])).toEqual([['voicing/unreachable-focus', 'preview']]);
      expect(both.map((draft) => [draft.rule, draft.evidenceClass])).toEqual([['voicing/unreachable-focus', 'deterministic']]);
    });

    it('gates a missing obligation window by that obligation class', () => {
      const drafts = runStructuralTier(contract([dialogObligation]), [stopAt(0, '/main', [])], 'screen-1', ['dialog-name']);

      expect(drafts.map((draft) => [draft.rule, draft.evidenceClass, draft.confidence])).toEqual([
        ['voicing/unreachable-focus', 'deterministic', 'fail'],
      ]);
    });
  });
});

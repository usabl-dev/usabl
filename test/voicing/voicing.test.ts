import { describe, expect, it } from 'vitest';
import type { AnnouncementToken, InteractionContract, SpeechObligation, TranscriptStop } from '../../src/contracts/index.js';
import { runVoicingTier } from '../../src/voicing/voicing.js';

const name = (text: string): AnnouncementToken => ({
  kind: 'name',
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

const toastObligation: SpeechObligation = {
  class: 'toast-announced',
  afterStep: 1,
  requiredTokens: ['Cluster deleted', 'success'],
  mustAnnounce: false,
};

const bannerObligation: SpeechObligation = {
  class: 'banner-announced',
  afterStep: 2,
  requiredTokens: ['Deployment failed'],
  mustAnnounce: false,
};

const contract: InteractionContract = {
  contractId: 'contract-1',
  surfaceId: 'clusters-page',
  task: 'Delete cluster',
  steps: [{ do: 'tab' }, { do: 'activate' }],
  obligations: [toastObligation],
};

describe('runVoicingTier', () => {
  it('returns no drafts when required tokens are present in the obligation window', () => {
    const drafts = runVoicingTier(
      contract,
      [stopAt(1, '/toast', [name('Cluster'), name('deleted success')])],
      'screen-1',
    );

    expect(drafts).toHaveLength(0);
  });

  it('returns no drafts when required tokens are present only in live announcements', () => {
    const drafts = runVoicingTier(
      contract,
      [stopAt(1, '/toast', [live('Cluster deleted'), live('success')])],
      'screen-1',
    );

    expect(drafts).toHaveLength(0);
  });

  it('emits one preview draft when a required token is missing from the window', () => {
    const drafts = runVoicingTier(contract, [stopAt(1, '/toast', [name('Cluster deleted')])], 'screen-1');

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.rule).toBe('voicing/missing-announcement');
    expect(drafts[0]?.evidenceClass).toBe('preview');
    expect(drafts[0]?.confidence).toBe('unverified');
    expect(drafts[0]?.layer).toBe('voicing');
  });

  it('emits a preview draft when the obligation window stop is missing', () => {
    const drafts = runVoicingTier(contract, [stopAt(0, '/main', [name('Dashboard')])], 'screen-1');

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.rule).toBe('voicing/missing-announcement');
    expect(drafts[0]?.confidence).toBe('unverified');
  });

  it('quotes raw observed text in advisory strings', () => {
    const drafts = runVoicingTier(contract, [stopAt(1, '/toast', [live('Loading...')])], 'screen-1');
    const draft = drafts[0];

    expect(drafts).toHaveLength(1);
    expect(`${draft?.whatUserExperiences} ${draft?.why}`).toContain('Loading...');
  });

  it('keeps every voicing draft as preview and unverified', () => {
    const drafts = runVoicingTier(
      contract,
      [stopAt(1, '/toast', [live('Loading...')]), stopAt(0, '/main', [name('Home')])],
      'screen-1',
    );

    for (const draft of drafts) {
      expect(draft.evidenceClass).toBe('preview');
      expect(draft.confidence).toBe('unverified');
    }
  });

  it('keeps an unlisted class miss as preview and unverified', () => {
    const drafts = runVoicingTier(contract, [stopAt(1, '/toast', [live('Loading...')])], 'screen-1', ['other-class']);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.evidenceClass).toBe('preview');
    expect(drafts[0]?.confidence).toBe('unverified');
  });

  it('promotes a listed class miss to deterministic fail', () => {
    const drafts = runVoicingTier(contract, [stopAt(1, '/toast', [live('Loading...')])], 'screen-1', ['toast-announced']);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.rule).toBe('voicing/missing-announcement');
    expect(drafts[0]?.evidenceClass).toBe('deterministic');
    expect(drafts[0]?.confidence).toBe('fail');
  });

  it('keeps raw observed text when a listed class is promoted', () => {
    const drafts = runVoicingTier(contract, [stopAt(1, '/toast', [live('Loading...')])], 'screen-1', ['toast-announced']);
    const draft = drafts[0];

    expect(drafts).toHaveLength(1);
    expect(`${draft?.whatUserExperiences} ${draft?.why}`).toContain('Loading...');
  });

  it('promotes only listed classes when listed and unlisted misses coexist', () => {
    const mixedContract: InteractionContract = {
      ...contract,
      obligations: [toastObligation, bannerObligation],
    };
    const drafts = runVoicingTier(
      mixedContract,
      [
        stopAt(1, '/toast', [live('Loading...')]),
        stopAt(2, '/banner', [live('Loading...')]),
      ],
      'screen-1',
      ['toast-announced'],
    );

    expect(drafts).toHaveLength(2);
    const promoted = drafts.find((draft) => draft.elementPath === '/toast');
    const unlisted = drafts.find((draft) => draft.elementPath === '/banner');
    expect(promoted?.evidenceClass).toBe('deterministic');
    expect(promoted?.confidence).toBe('fail');
    expect(unlisted?.evidenceClass).toBe('preview');
    expect(unlisted?.confidence).toBe('unverified');
  });
});

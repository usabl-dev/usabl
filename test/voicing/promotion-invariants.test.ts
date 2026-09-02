import { describe, expect, it, vi } from 'vitest';
import type { AnnouncementToken, InteractionContract, SpeechObligation, StepRunner, TranscriptStop } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeVirtualSrProvider } from '../../src/voicing/virtual-sr-provider.js';
import { draftsOf, testConfig } from '../helpers.js';

const SCREEN = { id: 'clusters', url: 'http://127.0.0.1:5173/clusters' };

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
  requiredTokens: ['cluster deleted', 'success'],
  mustAnnounce: false,
};

const bannerObligation: SpeechObligation = {
  class: 'banner-announced',
  afterStep: 2,
  requiredTokens: ['deployment failed'],
  mustAnnounce: false,
};

const CONTRACT: InteractionContract = {
  contractId: 'clusters-voicing',
  surfaceId: SCREEN.id,
  task: 'verify interaction announcements',
  steps: [{ do: 'tab' }, { do: 'activate' }, { do: 'tab' }],
  obligations: [toastObligation, bannerObligation],
};

function runnerReturning(stops: TranscriptStop[]): StepRunner {
  return {
    run: vi.fn(async () => stops),
  };
}

async function runProvider(promotedObligations?: string[]) {
  const provider = makeVirtualSrProvider(
    [CONTRACT],
    runnerReturning([
      stopAt(1, '/toast', [live('Cluster deleted')]),
      stopAt(2, '/banner', [live('Loading...')]),
    ]),
  );
  const page = await makeFakeDeps().browser.open('http://127.0.0.1:5173/clusters');
  const config = promotedObligations === undefined ? testConfig() : testConfig({ promotedObligations });
  return draftsOf(await provider.run({ page, screen: SCREEN, config }));
}

describe('virtual SR promotion invariants', () => {
  it('keeps every missing-announcement draft as preview when no classes are promoted', async () => {
    const drafts = await runProvider([]);
    const voicingDrafts = drafts.filter((draft) => draft.rule === 'voicing/missing-announcement');

    expect(voicingDrafts.length).toBeGreaterThan(0);
    for (const draft of voicingDrafts) {
      expect(draft.evidenceClass).toBe('preview');
    }
  });

  it('promotes only listed classes and keeps other classes as preview', async () => {
    const drafts = await runProvider(['toast-announced']);
    const toastDraft = drafts.find(
      (draft) => draft.rule === 'voicing/missing-announcement' && draft.elementPath === '/toast',
    );
    const bannerDraft = drafts.find(
      (draft) => draft.rule === 'voicing/missing-announcement' && draft.elementPath === '/banner',
    );

    expect(toastDraft?.evidenceClass).toBe('deterministic');
    expect(toastDraft?.confidence).toBe('fail');
    expect(bannerDraft?.evidenceClass).toBe('preview');
    expect(bannerDraft?.confidence).toBe('unverified');
  });

  it('never assigns fail confidence to preview drafts', async () => {
    const drafts = await runProvider(['toast-announced']);
    const previewDrafts = drafts.filter((draft) => draft.evidenceClass === 'preview');

    expect(previewDrafts.length).toBeGreaterThan(0);
    for (const draft of previewDrafts) {
      expect(draft.confidence).not.toBe('fail');
    }
  });

  it('declares live capability', () => {
    const provider = makeVirtualSrProvider([CONTRACT], runnerReturning([]));

    expect(provider.capabilities).toContain('live');
  });
});

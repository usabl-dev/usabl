import { describe, expect, it, vi } from 'vitest';
import type { AnnouncementToken, InteractionContract, SpeechObligation, StepRunner, TranscriptStop } from '../../src/contracts/index.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeVirtualSrProvider } from '../../src/voicing/virtual-sr-provider.js';
import { testConfig } from '../helpers.js';

const SCREEN = { id: 'clusters', url: 'http://127.0.0.1:5173/clusters' };

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
  afterStep: 0,
  requiredTokens: ['delete cluster'],
  focusedRole: 'dialog',
  mustAnnounce: false,
};

const toastObligation: SpeechObligation = {
  class: 'toast-announced',
  afterStep: 1,
  requiredTokens: ['cluster deleted', 'success'],
  mustAnnounce: false,
};

function contract(surfaceId: string, obligations: SpeechObligation[]): InteractionContract {
  return {
    contractId: `${surfaceId}-contract`,
    surfaceId,
    task: 'exercise interaction contract',
    steps: [{ do: 'tab' }, { do: 'activate' }],
    obligations,
  };
}

function runnerReturning(stops: TranscriptStop[]): StepRunner {
  return {
    run: vi.fn(async () => stops),
  };
}

async function openClustersPage() {
  return makeFakeDeps().browser.open('http://127.0.0.1:5173/clusters');
}

describe('makeVirtualSrProvider', () => {
  it('declares live capability', () => {
    const provider = makeVirtualSrProvider([], runnerReturning([]));

    expect(provider.capabilities).toContain('live');
  });

  it('returns no deterministic or preview drafts when obligations are satisfied', async () => {
    const provider = makeVirtualSrProvider(
      [contract(SCREEN.id, [dialogObligation])],
      runnerReturning([stopAt(0, '/dialog', [role('dialog'), name('Delete cluster')])]),
    );
    const page = await openClustersPage();

    const drafts = await provider.run({ page, screen: SCREEN, config: testConfig() });

    expect(drafts.filter((draft) => draft.evidenceClass === 'deterministic')).toHaveLength(0);
    expect(drafts.filter((draft) => draft.evidenceClass === 'preview')).toHaveLength(0);
  });

  it('emits a deterministic structural draft for a missing dialog name', async () => {
    const provider = makeVirtualSrProvider(
      [contract(SCREEN.id, [dialogObligation])],
      runnerReturning([stopAt(0, '/dialog', [role('dialog')])]),
    );
    const page = await openClustersPage();

    const drafts = await provider.run({ page, screen: SCREEN, config: testConfig() });

    expect(drafts.some((draft) => draft.rule === 'voicing/missing-name' && draft.evidenceClass === 'deterministic')).toBe(true);
  });

  it('keeps a word miss as preview when promotedObligations is empty', async () => {
    const provider = makeVirtualSrProvider(
      [contract(SCREEN.id, [toastObligation])],
      runnerReturning([stopAt(1, '/toast', [live('Cluster deleted')])]),
    );
    const page = await openClustersPage();

    const drafts = await provider.run({ page, screen: SCREEN, config: testConfig({ promotedObligations: [] }) });

    expect(drafts.some((draft) => draft.rule === 'voicing/missing-announcement' && draft.evidenceClass === 'preview')).toBe(true);
  });

  it('promotes a listed word miss to deterministic fail', async () => {
    const provider = makeVirtualSrProvider(
      [contract(SCREEN.id, [toastObligation])],
      runnerReturning([stopAt(1, '/toast', [live('Cluster deleted')])]),
    );
    const page = await openClustersPage();

    const drafts = await provider.run({
      page,
      screen: SCREEN,
      config: testConfig({ promotedObligations: ['toast-announced'] }),
    });

    expect(
      drafts.some(
        (draft) =>
          draft.rule === 'voicing/missing-announcement' &&
          draft.evidenceClass === 'deterministic' &&
          draft.confidence === 'fail',
      ),
    ).toBe(true);
  });

  it('returns no drafts for contracts that target a different surface', async () => {
    const stepRunner = runnerReturning([stopAt(0, '/dialog', [role('dialog')])]);
    const provider = makeVirtualSrProvider([contract('other-surface', [dialogObligation])], stepRunner);
    const page = await openClustersPage();

    const drafts = await provider.run({ page, screen: SCREEN, config: testConfig() });

    expect(drafts).toEqual([]);
    expect(stepRunner.run).not.toHaveBeenCalled();
  });
});

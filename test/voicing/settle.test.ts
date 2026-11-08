/**
 * A voice contract reads each step's window only after the page settles. The step runner used to
 * drain the live record right after the step ran, so an announcement that landed a moment later
 * was missed, and the transcript depended on timing. A window the page never settled in, or whose
 * drain cannot say what a screen reader heard, decides nothing: each obligation in it is a gap.
 */
import { describe, expect, it } from 'vitest';
import type {
  AnnouncementDrain,
  AnnouncementToken,
  InteractionContract,
  Page,
  SpeechObligation,
  TranscriptStop,
} from '../../src/contracts/index.js';
import { makeFakePage } from '../../src/deps/fakes.js';
import { ACTION_SETTLE_CAP_MS, waitForActionSettled } from '../../src/deps/real.js';
import { mapRequirementsToProviders } from '../../src/intake/map-to-providers.js';
import { makeStepRunner } from '../../src/providers/keyboard-walk/steps.js';
import { runStructuralTier } from '../../src/voicing/structural.js';
import { runVoicingTier } from '../../src/voicing/voicing.js';
import { draftsOf, testConfig } from '../helpers.js';

const SCREEN = { id: 'clusters', url: 'http://127.0.0.1:5173/clusters' };

// A page that records the order of the calls the runner makes.
function recordingPage(overrides: Partial<Page> = {}): { page: Page; calls: string[] } {
  const calls: string[] = [];
  const page = makeFakePage({
    click: async () => {
      calls.push('click');
    },
    tab: async () => {
      calls.push('tab');
    },
    settleAfterAction: async () => {
      calls.push('settle');
      return { settled: true, waitedMs: 0 };
    },
    activePath: async () => {
      calls.push('activePath');
      return '#undo';
    },
    activeNode: async () => {
      calls.push('activeNode');
      return { name: 'Undo delete', role: 'button', states: {}, sentBeforeWalk: true };
    },
    activeFocusUnreadable: async () => {
      calls.push('activeFocusUnreadable');
      return null;
    },
    drainAnnouncements: async () => {
      calls.push('drainAnnouncements');
      return [];
    },
    drainAnnouncementRecord: async (): Promise<AnnouncementDrain> => {
      calls.push('drainAnnouncementRecord');
      return { texts: [], undecidable: null };
    },
    ...overrides,
  });
  return { page, calls };
}

describe('the step runner for interaction contracts', () => {
  it('waits for the page to settle after each step before it reads focus and drains', async () => {
    const { page, calls } = recordingPage();

    await makeStepRunner({ settleAfterEachStep: true }).run(page, [{ do: 'click', selector: '#delete' }, { do: 'tab' }]);

    expect(calls).toEqual([
      'drainAnnouncementRecord',
      'click',
      'settle',
      'activePath',
      'activeNode',
      'activeFocusUnreadable',
      'drainAnnouncementRecord',
      'tab',
      'settle',
      'activePath',
      'activeNode',
      'activeFocusUnreadable',
      'drainAnnouncementRecord',
    ]);
  });

  it('drops announcements recorded before the first step, so an earlier check cannot fill the first window', async () => {
    let drains = 0;
    const { page } = recordingPage({
      drainAnnouncementRecord: async () => {
        drains += 1;
        return { texts: drains === 1 ? ['Saved by an earlier check'] : [], undecidable: null };
      },
    });

    const stops = await makeStepRunner({ settleAfterEachStep: true }).run(page, [{ do: 'click', selector: '#delete' }]);

    expect(stops[0]?.announcement.filter((token) => token.kind === 'live')).toEqual([]);
  });

  it('hears an announcement that lands during the settle wait', async () => {
    let pending: string[] = [];
    const { page } = recordingPage({
      settleAfterAction: async () => {
        pending = ['Row deleted'];
        return { settled: true, waitedMs: 1500 };
      },
      drainAnnouncementRecord: async () => {
        const texts = pending;
        pending = [];
        return { texts, undecidable: null };
      },
    });

    const stops = await makeStepRunner({ settleAfterEachStep: true }).run(page, [{ do: 'click', selector: '#delete' }]);

    expect(stops).toEqual([
      {
        index: 0,
        elementPath: '#undo',
        announcement: [
          { kind: 'name', text: 'Undo delete', fromTree: true, source: 'ax-tree' },
          { kind: 'role', text: 'button', fromTree: true, source: 'ax-tree' },
          { kind: 'live', text: 'Row deleted', fromTree: false, source: 'attribute' },
        ],
      },
    ]);
  });

  it('marks a stop the page never settled in, and one whose drain is undecidable', async () => {
    let step = 0;
    const { page } = recordingPage({
      click: async () => {
        step += 1;
      },
      settleAfterAction: async () => (step === 1 ? { settled: false, waitedMs: 2000 } : { settled: true, waitedMs: 0 }),
      drainAnnouncementRecord: async () => ({
        texts: [],
        undecidable: step === 2 ? 'closed-shadow-modal' : null,
      }),
    });

    const stops = await makeStepRunner({ settleAfterEachStep: true }).run(page, [
      { do: 'click', selector: '#a' },
      { do: 'click', selector: '#b' },
    ]);

    expect(stops.map((stop) => [stop.unsettled, stop.drainUndecidable])).toEqual([
      [{ waitedMs: 2000 }, undefined],
      [undefined, 'closed-shadow-modal'],
    ]);
  });

  it('leaves the keyboard walk runner as it was: no settle wait and the plain drain', async () => {
    const { page, calls } = recordingPage();

    const stops = await makeStepRunner().run(page, [{ do: 'tab' }]);

    expect(calls).toEqual(['tab', 'activePath', 'activeNode', 'activeFocusUnreadable', 'drainAnnouncements']);
    expect('unsettled' in (stops[0] ?? {})).toBe(false);
  });

  it('is the runner a voice requirement provider uses', async () => {
    const { page, calls } = recordingPage();
    const [provider] = mapRequirementsToProviders({
      version: 1,
      requirements: [
        {
          id: 'delete-row-announces',
          kind: 'voice',
          surface: SCREEN.id,
          description: 'Deleting a row announces the deletion',
          approved: true,
          assertion: {
            type: 'voice',
            steps: [{ do: 'click', selector: '#delete' }],
            obligations: [{ class: 'live-polite', afterStep: 0, requiredTokens: ['deleted'], mustAnnounce: true }],
          },
        },
      ],
    });

    await provider!.run({ page, screen: SCREEN, config: testConfig() });

    expect(calls).toContain('settle');
  });

  it('settles a fake page at once by default', async () => {
    await expect(makeFakePage().settleAfterAction()).resolves.toEqual({ settled: true, waitedMs: 0 });
  });
});

describe('a window that decides nothing', () => {
  const name = (text: string): AnnouncementToken => ({ kind: 'name', text, fromTree: true, source: 'ax-tree' });

  const focusObligation: SpeechObligation = {
    class: 'focus-name',
    afterStep: 0,
    requiredTokens: ['undo'],
    focusedRole: 'button',
    mustAnnounce: false,
  };
  const liveObligation: SpeechObligation = {
    class: 'live-polite',
    afterStep: 0,
    requiredTokens: ['deleted'],
    mustAnnounce: true,
  };
  const laterObligation: SpeechObligation = {
    class: 'later',
    afterStep: 1,
    requiredTokens: ['closed'],
    mustAnnounce: false,
  };
  const contract: InteractionContract = {
    contractId: 'delete-row-announces',
    surfaceId: SCREEN.id,
    task: 'Deleting a row announces the deletion',
    steps: [{ do: 'click', selector: '#delete' }, { do: 'tab' }],
    obligations: [focusObligation, liveObligation, laterObligation],
  };

  function bothTiers(stops: TranscriptStop[], promoted: string[] = []) {
    return [
      ...runStructuralTier(contract, stops, SCREEN.id, promoted),
      ...runVoicingTier(contract, stops, SCREEN.id, promoted),
    ];
  }

  // The first window holds nothing at all, so a decided window would fail every check in it.
  const emptyFirst = (extra: Partial<TranscriptStop>): TranscriptStop[] => [
    { index: 0, elementPath: '#undo', announcement: [], ...extra },
    { index: 1, elementPath: '#close', announcement: [name('closed')] },
  ];

  it('turns each obligation in an unsettled window into one gap draft, never a miss and never a pass', () => {
    const drafts = bothTiers(emptyFirst({ unsettled: { waitedMs: 2000 } }));

    expect(drafts.map((draft) => [draft.rule, draft.confidence, draft.evidence.extra?.['obligation']])).toEqual([
      ['voicing/window-undecided', 'unverified', 'focus-name'],
      ['voicing/window-undecided', 'unverified', 'live-polite'],
    ]);
    expect(drafts[0]?.why).toContain('delete-row-announces');
    expect(drafts[0]?.why).toContain('step 0');
    expect(drafts[0]?.why).toContain('still changing');
    // Wall-clock time never reaches a draft: two runs that waited differently must agree.
    expect(JSON.stringify(drafts)).not.toContain('2000');
  });

  it('turns each obligation in a window with an undecidable drain into one gap draft that names the cause', () => {
    const drafts = bothTiers(emptyFirst({ drainUndecidable: 'changed-element-removed' }));

    expect(drafts.map((draft) => [draft.rule, draft.confidence])).toEqual([
      ['voicing/window-undecided', 'unverified'],
      ['voicing/window-undecided', 'unverified'],
    ]);
    expect(drafts[1]?.why).toContain('a live region that changed was removed');
    expect(drafts[1]?.evidence.extra).toEqual({
      contractId: 'delete-row-announces',
      step: 0,
      obligation: 'live-polite',
      undecidable: 'changed-element-removed',
    });
  });

  it('stays preview for a class nobody promoted, and gates as a gap for a promoted one', () => {
    const drafts = bothTiers(emptyFirst({ unsettled: { waitedMs: 2000 } }), ['live-polite']);

    expect(drafts.map((draft) => [draft.evidence.extra?.['obligation'], draft.evidenceClass, draft.confidence])).toEqual([
      ['focus-name', 'preview', 'unverified'],
      ['live-polite', 'deterministic', 'unverified'],
    ]);
  });

  it('still decides the windows the page did settle in', () => {
    const stops: TranscriptStop[] = [
      { index: 0, elementPath: '#undo', announcement: [name('Undo delete'), { kind: 'role', text: 'button', fromTree: true, source: 'ax-tree' }, { kind: 'live', text: 'Row deleted', fromTree: false, source: 'attribute' }] },
      { index: 1, elementPath: '#close', announcement: [], unsettled: { waitedMs: 2000 } },
    ];

    expect(bothTiers(stops).map((draft) => [draft.rule, draft.evidence.extra?.['obligation']])).toEqual([
      ['voicing/window-undecided', 'later'],
    ]);
  });
});

describe('waitForActionSettled', () => {
  function scriptedPage(elements: () => number, quiet: () => boolean) {
    return {
      networkQuietFor: () => quiet(),
      evaluate: async () => elements(),
    };
  }
  const liveQuiet = async () => true;
  // A short cap for the tests that only need the cap to run out.
  const SHORT_CAP_MS = 2_500;

  it('returns settled once the element count holds, the network is quiet, and the live record is quiet', async () => {
    const result = await waitForActionSettled(scriptedPage(() => 12, () => true), ACTION_SETTLE_CAP_MS, liveQuiet);

    expect(result.settled).toBe(true);
    expect(result.waitedMs).toBeLessThan(ACTION_SETTLE_CAP_MS);
  }, 15_000);

  it('watches a page that does not change for at least two seconds, so a text-only update at 1.6 seconds lands inside the wait', async () => {
    const result = await waitForActionSettled(scriptedPage(() => 12, () => true), ACTION_SETTLE_CAP_MS, liveQuiet);

    expect(result.waitedMs).toBeGreaterThanOrEqual(2_000);
  }, 15_000);

  it('keeps waiting while the live record has just received an announcement', async () => {
    const start = Date.now();
    // The live record changed until 2.2 seconds in, with no element added and no request.
    const result = await waitForActionSettled(
      scriptedPage(() => 12, () => true),
      ACTION_SETTLE_CAP_MS,
      async () => Date.now() - start >= 2_200,
    );

    expect(result.settled).toBe(true);
    expect(result.waitedMs).toBeGreaterThanOrEqual(2_200);
  }, 15_000);

  it('returns unsettled at its cap when the live record never goes quiet', async () => {
    const result = await waitForActionSettled(scriptedPage(() => 12, () => true), SHORT_CAP_MS, async () => false);

    expect(result.settled).toBe(false);
    expect(result.waitedMs).toBeGreaterThanOrEqual(SHORT_CAP_MS);
  }, 15_000);

  it('returns unsettled at its own cap, without throwing, when the page keeps changing', async () => {
    const start = Date.now();
    const result = await waitForActionSettled(scriptedPage(() => Date.now() - start, () => true), SHORT_CAP_MS, liveQuiet);

    expect(result.settled).toBe(false);
    expect(result.waitedMs).toBeGreaterThanOrEqual(SHORT_CAP_MS);
  }, 15_000);

  it('returns unsettled at its cap when the network never goes quiet', async () => {
    const result = await waitForActionSettled(scriptedPage(() => 12, () => false), SHORT_CAP_MS, liveQuiet);

    expect(result.settled).toBe(false);
  }, 15_000);

  it('uses a cap for one action that a row removed after a slow request fits inside, far below the page load budget', () => {
    expect(ACTION_SETTLE_CAP_MS).toBe(6_000);
  });
});

describe('a voice provider run with fake pages', () => {
  it('reports drafts from a settled window as before', async () => {
    const page = makeFakePage({
      activeNode: async () => ({ name: 'Delete', role: 'button', states: {}, sentBeforeWalk: true }),
    });
    const [provider] = mapRequirementsToProviders({
      version: 1,
      requirements: [
        {
          id: 'delete-row-announces',
          kind: 'voice',
          surface: SCREEN.id,
          description: 'Deleting a row announces the deletion',
          approved: true,
          assertion: {
            type: 'voice',
            steps: [{ do: 'click', selector: '#delete' }],
            obligations: [{ class: 'live-polite', afterStep: 0, requiredTokens: ['deleted'], mustAnnounce: true }],
          },
        },
      ],
    });

    const drafts = draftsOf(await provider!.run({ page, screen: SCREEN, config: testConfig() }));

    expect(drafts.map((draft) => draft.rule)).toEqual([
      'intake:delete-row-announces/missing-live-announcement',
      'intake:delete-row-announces/missing-announcement',
    ]);
  });
});

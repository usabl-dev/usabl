import { describe, expect, it, vi } from 'vitest';
import type { AxNode, ProviderContext, RequirementBundle } from '../../src/contracts/index.js';
import { makeFakePage } from '../../src/deps/fakes.js';
import { mapRequirementsToProviders, toVoiceContract } from '../../src/intake/map-to-providers.js';
import { draftsOf, testConfig } from '../helpers.js';

const SCREEN = {
  id: 'clusters',
  url: 'http://127.0.0.1:5173/clusters',
};

function requirementBundle(requirements: RequirementBundle['requirements']): RequirementBundle {
  return {
    version: 1,
    requirements,
  };
}

function contentBundle(assertion: RequirementBundle['requirements'][number]['assertion']): RequirementBundle {
  return requirementBundle([
    {
      id: 'content-title',
      kind: 'content',
      surface: SCREEN.id,
      description: 'Page heading matches authored text',
      assertion,
      approved: true,
    },
  ]);
}

function flowBundle(assertion: RequirementBundle['requirements'][number]['assertion']): RequirementBundle {
  return requirementBundle([
    {
      id: 'flow-save',
      kind: 'flow',
      surface: SCREEN.id,
      description: 'Save action announces completion',
      assertion,
      approved: true,
    },
  ]);
}

function docBundle(): RequirementBundle {
  return requirementBundle([
    {
      id: 'doc-alt-manifest',
      kind: 'doc',
      surface: SCREEN.id,
      description: 'Alt text documentation artifact exists',
      assertion: { type: 'doc', artifact: 'alt-text-manifest' },
      approved: true,
    },
  ]);
}

function axNode(name: string | null): AxNode {
  return {
    name,
    role: 'heading',
    states: {},
  };
}

async function makeContext(
  overrides: { page?: ProviderContext['page']; screenId?: string } = {},
): Promise<ProviderContext> {
  return {
    page: overrides.page ?? makeFakePage(),
    screen: {
      id: overrides.screenId ?? SCREEN.id,
      url: SCREEN.url,
    },
    config: testConfig(),
  };
}

describe('mapRequirementsToProviders', () => {
  it('maps one content requirement to one intake-content provider', () => {
    const bundle = contentBundle({
      type: 'content',
      selector: 'h1',
      expectedText: 'Welcome',
    });

    const providers = mapRequirementsToProviders(bundle);

    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      id: 'intake:content-title',
      layer: 'intake-content',
      capabilities: ['live'],
    });
  });

  it('maps doc requirements to zero providers', () => {
    const providers = mapRequirementsToProviders(docBundle());
    expect(providers).toEqual([]);
  });

  it('maps flow requirements to intake-flow providers', () => {
    const bundle = flowBundle({
      type: 'flow',
      steps: [{ do: 'tab' }],
      expectedAnnouncement: 'Save complete',
    });

    const providers = mapRequirementsToProviders(bundle);

    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      id: 'intake:flow-save',
      layer: 'intake-flow',
      capabilities: ['live'],
    });
  });

  it('returns one deterministic fail draft when content does not match expected text', async () => {
    const bundle = contentBundle({
      type: 'content',
      selector: 'h1',
      expectedText: 'Welcome',
    });
    const provider = mapRequirementsToProviders(bundle)[0];
    const context = await makeContext({
      page: makeFakePage({
        axAt: vi.fn(async () => axNode('Home')),
      }),
    });

    const drafts = draftsOf(await provider!.run(context));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      rule: 'intake:content-title',
      layer: 'intake-content',
      evidenceClass: 'deterministic',
      confidence: 'fail',
      screenId: SCREEN.id,
      elementPath: 'h1',
      elementName: 'Home',
    });
  });

  it('returns zero drafts when content matches expected text', async () => {
    const bundle = contentBundle({
      type: 'content',
      selector: 'h1',
      expectedText: 'Welcome',
    });
    const provider = mapRequirementsToProviders(bundle)[0];
    const context = await makeContext({
      page: makeFakePage({
        axAt: vi.fn(async () => axNode('Welcome')),
      }),
    });

    await expect(provider!.run(context)).resolves.toEqual([]);
  });

  it('returns one deterministic fail draft when expectedText is set and node is missing', async () => {
    const bundle = contentBundle({
      type: 'content',
      selector: 'h1',
      expectedText: 'Welcome',
    });
    const provider = mapRequirementsToProviders(bundle)[0];
    const context = await makeContext({
      page: makeFakePage({
        axAt: vi.fn(async () => null),
      }),
    });

    const drafts = draftsOf(await provider!.run(context));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      rule: 'intake:content-title',
      layer: 'intake-content',
      evidenceClass: 'deterministic',
      confidence: 'fail',
      screenId: SCREEN.id,
      elementPath: 'h1',
      elementName: null,
    });
  });

  it('fails when mustNotBe empty and accessible name is null', async () => {
    const bundle = contentBundle({
      type: 'content',
      selector: 'h1',
      mustNotBe: 'empty',
    });
    const provider = mapRequirementsToProviders(bundle)[0];
    const context = await makeContext({
      page: makeFakePage({
        axAt: vi.fn(async () => axNode(null)),
      }),
    });

    const drafts = draftsOf(await provider!.run(context));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      rule: 'intake:content-title',
      layer: 'intake-content',
      evidenceClass: 'deterministic',
      confidence: 'fail',
      elementPath: 'h1',
      elementName: null,
    });
  });

  it('fails when mustNotBe empty and accessible name is whitespace', async () => {
    const bundle = contentBundle({
      type: 'content',
      selector: 'h1',
      mustNotBe: 'empty',
    });
    const provider = mapRequirementsToProviders(bundle)[0];
    const context = await makeContext({
      page: makeFakePage({
        axAt: vi.fn(async () => axNode('   ')),
      }),
    });

    const drafts = draftsOf(await provider!.run(context));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      rule: 'intake:content-title',
      layer: 'intake-content',
      evidenceClass: 'deterministic',
      confidence: 'fail',
      elementPath: 'h1',
      elementName: '   ',
    });
  });

  it('fails when mustNotBe decorative and accessible name is non-empty', async () => {
    const bundle = contentBundle({
      type: 'content',
      selector: 'img.hero',
      mustNotBe: 'decorative',
    });
    const provider = mapRequirementsToProviders(bundle)[0];
    const context = await makeContext({
      page: makeFakePage({
        axAt: vi.fn(async () => ({
          name: 'Company logo',
          role: 'img',
          states: {},
        })),
      }),
    });

    const drafts = draftsOf(await provider!.run(context));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      rule: 'intake:content-title',
      layer: 'intake-content',
      evidenceClass: 'deterministic',
      confidence: 'fail',
      elementPath: 'img.hero',
      elementName: 'Company logo',
    });
  });

  it('returns zero drafts when mustNotBe decorative and accessible name is absent', async () => {
    const bundle = contentBundle({
      type: 'content',
      selector: 'img.hero',
      mustNotBe: 'decorative',
    });
    const provider = mapRequirementsToProviders(bundle)[0];
    const context = await makeContext({
      page: makeFakePage({
        axAt: vi.fn(async () => ({
          name: null,
          role: 'img',
          states: {},
        })),
      }),
    });

    await expect(provider!.run(context)).resolves.toEqual([]);
  });

  it('returns zero drafts for wrong screen id', async () => {
    const bundle = contentBundle({
      type: 'content',
      selector: 'h1',
      expectedText: 'Welcome',
    });
    const provider = mapRequirementsToProviders(bundle)[0];
    const context = await makeContext({
      screenId: 'settings',
      page: makeFakePage({
        axAt: vi.fn(async () => axNode('Home')),
      }),
    });

    await expect(provider!.run(context)).resolves.toEqual([]);
  });

  it('returns a fail draft when flow expected announcement is not heard', async () => {
    const bundle = flowBundle({
      type: 'flow',
      steps: [{ do: 'tab' }, { do: 'activate' }],
      expectedAnnouncement: 'Saved',
    });
    const provider = mapRequirementsToProviders(bundle)[0];
    const context = await makeContext({
      page: makeFakePage({
        tab: vi.fn(async () => {}),
        press: vi.fn(async () => {}),
        activeNode: vi.fn(async () => axNode('Save button')),
        activePath: vi.fn(async () => '#save-button'),
        drainAnnouncements: vi.fn(async () => []),
      }),
    });

    const drafts = draftsOf(await provider!.run(context));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      rule: 'intake:flow-save',
      layer: 'intake-flow',
      evidenceClass: 'deterministic',
      confidence: 'fail',
      screenId: SCREEN.id,
      elementPath: '#save-button',
    });
  });

  it('returns an unverified draft naming the cause when the focused element cannot be read', async () => {
    const bundle = flowBundle({
      type: 'flow',
      steps: [{ do: 'tab' }],
      expectedAnnouncement: 'Saved',
    });
    const provider = mapRequirementsToProviders(bundle)[0];
    const context = await makeContext({
      page: makeFakePage({
        tab: vi.fn(async () => {}),
        activeNode: vi.fn(async () => null),
        activePath: vi.fn(async () => 'x-host'),
        activeFocusUnreadable: vi.fn(async () => 'closed-shadow-root' as const),
        drainAnnouncements: vi.fn(async () => []),
      }),
    });

    const drafts = draftsOf(await provider!.run(context));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      rule: 'intake:flow-save',
      layer: 'intake-flow',
      confidence: 'unverified',
      elementPath: 'x-host',
    });
    expect(drafts[0]?.why).toContain('closed shadow root');
  });

  it('passes on a heard announcement even when the focused element cannot be read', async () => {
    const bundle = flowBundle({
      type: 'flow',
      steps: [{ do: 'tab' }],
      expectedAnnouncement: 'Saved',
    });
    const provider = mapRequirementsToProviders(bundle)[0];
    const context = await makeContext({
      page: makeFakePage({
        tab: vi.fn(async () => {}),
        activeNode: vi.fn(async () => null),
        activeFocusUnreadable: vi.fn(async () => 'frame-unreadable' as const),
        drainAnnouncements: vi.fn(async () => ['Saved']),
      }),
    });

    await expect(provider!.run(context)).resolves.toEqual([]);
  });

  it('returns a fail draft when flow announcement appears only as substring in live region events', async () => {
    const bundle = flowBundle({
      type: 'flow',
      steps: [{ do: 'tab' }, { do: 'activate' }],
      expectedAnnouncement: 'Saved',
    });
    const provider = mapRequirementsToProviders(bundle)[0];
    const context = await makeContext({
      page: makeFakePage({
        tab: vi.fn(async () => {}),
        press: vi.fn(async () => {}),
        activeNode: vi.fn(async () => axNode('Save')),
        drainAnnouncements: vi.fn(async () => ['Status: Saved successfully']),
      }),
    });

    const drafts = draftsOf(await provider!.run(context));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      rule: 'intake:flow-save',
      layer: 'intake-flow',
      evidenceClass: 'deterministic',
      confidence: 'fail',
    });
  });

  it('returns zero drafts when flow announcement exactly matches a live region event after trim', async () => {
    const bundle = flowBundle({
      type: 'flow',
      steps: [{ do: 'tab' }, { do: 'activate' }],
      expectedAnnouncement: 'Saved',
    });
    const provider = mapRequirementsToProviders(bundle)[0];
    const context = await makeContext({
      page: makeFakePage({
        tab: vi.fn(async () => {}),
        press: vi.fn(async () => {}),
        activeNode: vi.fn(async () => axNode('Save')),
        drainAnnouncements: vi.fn(async () => ['  Saved  ']),
      }),
    });

    await expect(provider!.run(context)).resolves.toEqual([]);
  });

  it('returns a fail draft when flow announcement appears only as substring on active focus name', async () => {
    const bundle = flowBundle({
      type: 'flow',
      steps: [{ do: 'tab' }, { do: 'activate' }],
      expectedAnnouncement: 'Saved',
    });
    const provider = mapRequirementsToProviders(bundle)[0];
    const context = await makeContext({
      page: makeFakePage({
        tab: vi.fn(async () => {}),
        press: vi.fn(async () => {}),
        activeNode: vi.fn(async () => ({
          name: 'Saved successfully',
          role: 'status',
          states: {},
        })),
        drainAnnouncements: vi.fn(async () => []),
      }),
    });

    const drafts = draftsOf(await provider!.run(context));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      rule: 'intake:flow-save',
      layer: 'intake-flow',
      evidenceClass: 'deterministic',
      confidence: 'fail',
    });
  });

  it('returns zero drafts when flow announcement exactly matches active focus name after trim', async () => {
    const bundle = flowBundle({
      type: 'flow',
      steps: [{ do: 'tab' }, { do: 'activate' }],
      expectedAnnouncement: 'Saved',
    });
    const provider = mapRequirementsToProviders(bundle)[0];
    // Focus starts on the body and the Tab moves it to the control, so the name is the flow's own.
    let tabbed = false;
    const context = await makeContext({
      page: makeFakePage({
        tab: vi.fn(async () => {
          tabbed = true;
        }),
        press: vi.fn(async () => {}),
        activeNode: vi.fn(async () =>
          tabbed
            ? {
                name: '  Saved ',
                role: 'status',
                states: {},
              }
            : null,
        ),
        drainAnnouncements: vi.fn(async () => []),
      }),
    });

    await expect(provider!.run(context)).resolves.toEqual([]);
  });

  it('is a gap, never a pass or a fail, when the expected text was heard only before its first step', async () => {
    // The capture runs for the life of the page, so the first drain holds what earlier checks
    // caused. The flow's own steps announce nothing. An earlier check may have changed the page, so
    // whether these steps announce the text is unknown.
    const bundle = flowBundle({ type: 'flow', steps: [{ do: 'tab' }], expectedAnnouncement: 'Saved' });
    const provider = mapRequirementsToProviders(bundle)[0];
    const drains = [['Saved']];
    const context = await makeContext({
      page: makeFakePage({
        activeNode: vi.fn(async () => axNode('Save')),
        activePath: vi.fn(async () => '#save'),
        drainAnnouncements: vi.fn(async () => drains.shift() ?? []),
      }),
    });

    const drafts = draftsOf(await provider!.run(context));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ rule: 'intake:flow-save', evidenceClass: 'deterministic', confidence: 'unverified', elementPath: '#save' });
    expect(drafts[0]?.why).toContain('announced before the flow\'s first step');
    expect(drafts[0]?.evidence.extra).toMatchObject({ expectedAnnouncement: 'Saved', announcements: [], heardBeforeFirstStep: true });
  });

  it('still fails when the drain taken before its first step does not hold the expected text either', async () => {
    const bundle = flowBundle({ type: 'flow', steps: [{ do: 'tab' }], expectedAnnouncement: 'Saved' });
    const provider = mapRequirementsToProviders(bundle)[0];
    const drains = [['Deleted', 'Status: Saved successfully']];
    const context = await makeContext({
      page: makeFakePage({
        activeNode: vi.fn(async () => axNode('Save')),
        activePath: vi.fn(async () => '#save'),
        drainAnnouncements: vi.fn(async () => drains.shift() ?? []),
      }),
    });

    const drafts = draftsOf(await provider!.run(context));

    expect(drafts.map((draft) => [draft.rule, draft.confidence])).toEqual([['intake:flow-save', 'fail']]);
    expect(drafts[0]?.evidence.extra?.announcements).toEqual([]);
  });

  it('is not a gap when only the drain taken before its first step is undecidable', async () => {
    // That drain is not read for the verdict, so its reason cannot decide it either way.
    const bundle = flowBundle({ type: 'flow', steps: [{ do: 'tab' }], expectedAnnouncement: 'Saved' });
    const provider = mapRequirementsToProviders(bundle)[0];
    const drains = [
      { texts: ['Saved'], undecidable: 'closed-shadow-modal' as const },
      { texts: ['Saved'], undecidable: null },
    ];
    const context = await makeContext({
      page: makeFakePage({
        drainAnnouncementRecord: vi.fn(async () => drains.shift() ?? { texts: [], undecidable: null }),
      }),
    });

    await expect(provider!.run(context)).resolves.toEqual([]);
  });

  describe('focus that was already there before the flow is not evidence', () => {
    // A page whose focus is scripted: the node id and name before the flow, and what each step does.
    function focusPage(start: { id: number | null; name: string | null }, step: (focus: { id: number | null; name: string | null }) => void) {
      const focus = { ...start };
      const node = (): AxNode | null => (focus.name === null ? null : { name: focus.name, role: 'button', states: {} });
      return makeFakePage({
        tab: vi.fn(async () => step(focus)),
        press: vi.fn(async () => step(focus)),
        click: vi.fn(async () => step(focus)),
        focusedNodeId: vi.fn(async () => focus.id),
        activeNode: vi.fn(async () => node()),
        activePath: vi.fn(async () => (focus.id === null ? 'body' : `#node-${focus.id}`)),
      });
    }

    it('is a gap when a press of Shift leaves focus on the control an earlier check focused, named with the text', async () => {
      const bundle = flowBundle({ type: 'flow', steps: [{ do: 'press', key: 'Shift' }], expectedAnnouncement: 'Saved' });
      const provider = mapRequirementsToProviders(bundle)[0];
      const context = await makeContext({ page: focusPage({ id: 7, name: 'Saved' }, () => {}) });

      const drafts = draftsOf(await provider!.run(context));

      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({ rule: 'intake:flow-save', evidenceClass: 'deterministic', confidence: 'unverified', elementPath: '#node-7' });
      expect(drafts[0]?.why).toContain('focus was already on that control before the flow ran');
      expect(drafts[0]?.evidence.extra).toMatchObject({ expectedAnnouncement: 'Saved', focusUnchanged: true });
    });

    it('passes a flow that moves focus to a control with the expected name', async () => {
      const bundle = flowBundle({ type: 'flow', steps: [{ do: 'tab' }], expectedAnnouncement: 'Saved' });
      const provider = mapRequirementsToProviders(bundle)[0];
      const page = focusPage({ id: 3, name: 'Cancel' }, (focus) => Object.assign(focus, { id: 7, name: 'Saved' }));

      await expect(provider!.run(await makeContext({ page }))).resolves.toEqual([]);
    });

    it('passes a flow whose step changes the focused control\'s name to the expected text', async () => {
      const bundle = flowBundle({ type: 'flow', steps: [{ do: 'click', selector: '#save' }], expectedAnnouncement: 'Saved' });
      const provider = mapRequirementsToProviders(bundle)[0];
      const page = focusPage({ id: 3, name: 'Save' }, (focus) => Object.assign(focus, { name: 'Saved' }));

      await expect(provider!.run(await makeContext({ page }))).resolves.toEqual([]);
    });

    it('still passes on the expected text in a step\'s announcement, wherever focus is', async () => {
      const bundle = flowBundle({ type: 'flow', steps: [{ do: 'tab' }], expectedAnnouncement: 'Saved' });
      const provider = mapRequirementsToProviders(bundle)[0];
      const drains = [[], ['Saved']];
      const page = makeFakePage({
        ...focusPage({ id: 7, name: 'Saved' }, () => {}),
        drainAnnouncements: vi.fn(async () => drains.shift() ?? []),
      });

      await expect(provider!.run(await makeContext({ page }))).resolves.toEqual([]);
    });

    it('is a gap when focus could not be read before the flow, so whether it moved is unknown', async () => {
      const bundle = flowBundle({ type: 'flow', steps: [{ do: 'tab' }], expectedAnnouncement: 'Saved' });
      const provider = mapRequirementsToProviders(bundle)[0];
      let reads = 0;
      const page = makeFakePage({
        ...focusPage({ id: 7, name: 'Saved' }, () => {}),
        focusedNodeId: vi.fn(async () => {
          reads += 1;
          if (reads === 1) throw new Error('DOM.describeNode failed');
          return 7;
        }),
      });

      const drafts = draftsOf(await provider!.run(await makeContext({ page })));

      expect(drafts.map((draft) => draft.confidence)).toEqual(['unverified']);
      expect(drafts[0]?.why).toContain('could not be read before the flow ran');
    });
  });

  describe('before its first step, the flow waits for the page to go quiet', () => {
    const bundle = flowBundle({ type: 'flow', steps: [{ do: 'tab' }], expectedAnnouncement: 'Saved' });

    it('does not count an announcement an earlier check started that lands during that wait', async () => {
      // "Saved" is still in flight from an earlier check. It lands at the first moment the page is
      // given time: the wait, or else the flow's first step.
      const live: string[] = [];
      const inFlight = ['Saved'];
      const land = (): void => {
        live.push(...inFlight.splice(0, inFlight.length));
      };
      const calls: string[] = [];
      const provider = mapRequirementsToProviders(bundle)[0];
      const context = await makeContext({
        page: makeFakePage({
          settleAfterAction: vi.fn(async () => {
            calls.push('settle');
            land();
            return { settled: true, waitedMs: 0 };
          }),
          tab: vi.fn(async () => {
            calls.push('tab');
            land();
          }),
          drainAnnouncements: vi.fn(async () => {
            calls.push('drain');
            return live.splice(0, live.length);
          }),
          activeNode: vi.fn(async () => axNode('Save')),
          activePath: vi.fn(async () => '#save'),
        }),
      });

      const drafts = draftsOf(await provider!.run(context));

      expect(drafts.map((draft) => draft.rule)).toEqual(['intake:flow-save']);
      expect(drafts[0]?.evidence.extra?.announcements).toEqual([]);
      expect(calls).toEqual(['settle', 'drain', 'tab', 'drain']);
    });

    it('is a gap that says so when the page does not go quiet, and runs no step', async () => {
      const provider = mapRequirementsToProviders(bundle)[0];
      const tab = vi.fn(async () => {});
      const context = await makeContext({
        page: makeFakePage({ tab, settleAfterAction: vi.fn(async () => ({ settled: false, waitedMs: 3000 })) }),
      });

      await expect(provider!.run(context)).rejects.toThrow('the page did not go quiet before the flow');
      expect(tab).not.toHaveBeenCalled();
    });

    it('is a gap that says so when the wait itself fails', async () => {
      const provider = mapRequirementsToProviders(bundle)[0];
      const tab = vi.fn(async () => {});
      const context = await makeContext({
        page: makeFakePage({
          tab,
          settleAfterAction: vi.fn(async () => {
            throw new Error('Execution context was destroyed');
          }),
        }),
      });

      await expect(provider!.run(context)).rejects.toThrow('the wait for the page to go quiet before the flow failed');
      expect(tab).not.toHaveBeenCalled();
    });

    it('still runs a flow that expects no announcement on a page that does not go quiet', async () => {
      // Such a flow judges no speech, so the wait decides nothing for it.
      const provider = mapRequirementsToProviders(flowBundle({ type: 'flow', steps: [{ do: 'tab' }] }))[0];
      const tab = vi.fn(async () => {});
      const context = await makeContext({
        page: makeFakePage({ tab, settleAfterAction: vi.fn(async () => ({ settled: false, waitedMs: 3000 })) }),
      });

      await expect(provider!.run(context)).resolves.toEqual([]);
      expect(tab).toHaveBeenCalledTimes(1);
    });
  });

  describe('a flow step the driver cannot run', () => {
    // Each step the driver cannot run as written, with what the gap must say about it.
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['a click with no selector', { do: 'click' }, 'step 1 (click): a click step needs a selector'],
      ['a click with an empty selector', { do: 'click', selector: '' }, 'step 1 (click): a click step needs a selector'],
      ['a click with a blank selector', { do: 'click', selector: '   ' }, 'step 1 (click): a click step needs a selector'],
      ['a click whose selector is not text', { do: 'click', selector: 7 }, 'step 1 (click): a click step needs a selector'],
      ['a press with no key', { do: 'press' }, 'step 1 (press): a press step needs a key'],
      ['a press with an empty key', { do: 'press', key: '' }, 'step 1 (press): a press step needs a key'],
      ['a press with a blank key', { do: 'press', key: ' ' }, 'step 1 (press): a press step needs a key'],
      ['a step of a kind the driver does not know', { do: 'hover', selector: '#save' }, 'step 1 (hover): the flow does not run this kind of step'],
    ];

    for (const [name, step, said] of cases) {
      it(`makes the flow a gap for ${name}, and runs no step`, async () => {
        const bundle = flowBundle({ type: 'flow', steps: [{ do: 'tab' }, step as { do: string }], expectedAnnouncement: 'Saved' });
        const provider = mapRequirementsToProviders(bundle)[0];
        const tab = vi.fn(async () => {});
        const press = vi.fn(async () => {});
        const click = vi.fn(async () => {});
        const drainAnnouncements = vi.fn(async () => ['Saved']);
        const context = await makeContext({
          page: makeFakePage({ tab, press, click, drainAnnouncements, activeNode: vi.fn(async () => axNode('Saved')) }),
        });

        const run = provider!.run(context);

        await expect(run).rejects.toThrow(said);
        await expect(run).rejects.toThrow('counted from 0');
        expect(tab).not.toHaveBeenCalled();
        expect(press).not.toHaveBeenCalled();
        expect(click).not.toHaveBeenCalled();
        expect(drainAnnouncements).not.toHaveBeenCalled();
      });
    }

    it('names every step it cannot run, in step order', async () => {
      const bundle = flowBundle({ type: 'flow', steps: [{ do: 'press' }, { do: 'tab' }, { do: 'click' }] });
      const provider = mapRequirementsToProviders(bundle)[0];
      const context = await makeContext();

      await expect(provider!.run(context)).rejects.toThrow(/step 0 \(press\): a press step needs a key.*step 2 \(click\): a click step needs a selector/u);
    });

    it('is a gap even for a flow that expects no announcement', async () => {
      const bundle = flowBundle({ type: 'flow', steps: [{ do: 'click' }] });
      const provider = mapRequirementsToProviders(bundle)[0];

      await expect(provider!.run(await makeContext())).rejects.toThrow('step 0 (click)');
    });

    it('runs an activate step with no selector: it presses Enter on the focused control', async () => {
      const bundle = flowBundle({ type: 'flow', steps: [{ do: 'activate' }, { do: 'press', key: 'Escape' }], expectedAnnouncement: 'Saved' });
      const provider = mapRequirementsToProviders(bundle)[0];
      const press = vi.fn(async () => {});
      const context = await makeContext({ page: makeFakePage({ press, drainAnnouncements: vi.fn(async () => ['Saved']) }) });

      await expect(provider!.run(context)).resolves.toEqual([]);
      expect(press.mock.calls).toEqual([['Enter'], ['Escape']]);
    });
  });

  describe('when the drain cannot say what a screen reader heard', () => {
    const bundle = flowBundle({ type: 'flow', steps: [{ do: 'tab' }], expectedAnnouncement: 'Saved' });

    it('does not pass on a heard announcement, and names the cause', async () => {
      const provider = mapRequirementsToProviders(bundle)[0];
      const context = await makeContext({
        page: makeFakePage({
          activePath: vi.fn(async () => '#save'),
          drainAnnouncementRecord: vi.fn(async () => ({ texts: ['Saved'], undecidable: 'closed-shadow-modal' as const })),
        }),
      });

      const drafts = draftsOf(await provider!.run(context));

      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({ rule: 'intake:flow-save', layer: 'intake-flow', confidence: 'unverified', elementPath: '#save' });
      expect(drafts[0]?.why).toContain('closed shadow root');
    });

    it('does not fail on a missing announcement either', async () => {
      const provider = mapRequirementsToProviders(bundle)[0];
      const context = await makeContext({
        page: makeFakePage({
          drainAnnouncementRecord: vi.fn(async () => ({ texts: [], undecidable: 'changed-element-removed' as const })),
        }),
      });

      const drafts = draftsOf(await provider!.run(context));

      expect(drafts.map((draft) => draft.confidence)).toEqual(['unverified']);
      expect(drafts[0]?.why).toContain('removed');
    });

    it('still passes when the focused control itself says the text', async () => {
      const provider = mapRequirementsToProviders(bundle)[0];
      // The Tab moves focus from the body to the control, so its name is the flow's own evidence.
      let tabbed = false;
      const context = await makeContext({
        page: makeFakePage({
          tab: vi.fn(async () => {
            tabbed = true;
          }),
          activeNode: vi.fn(async () => (tabbed ? axNode('Saved') : null)),
          drainAnnouncementRecord: vi.fn(async () => ({ texts: [], undecidable: 'closed-shadow-modal' as const })),
        }),
      });

      await expect(provider!.run(context)).resolves.toEqual([]);
    });
  });
});

describe('toVoiceContract', () => {
  it('maps a voice requirement to an interaction contract with the same id, surface, steps, and obligations', () => {
    const steps = [{ do: 'click', selector: '[data-row="a"] button[aria-label="Delete"]' }];
    const obligations = [{ class: 'live-polite', afterStep: 0, requiredTokens: ['deleted'], mustAnnounce: true }];

    expect(
      toVoiceContract({
        id: 'delete-row-announces',
        kind: 'voice',
        surface: 'clusters',
        description: 'Deleting a row announces the deletion',
        approved: true,
        assertion: { type: 'voice', steps, obligations, maxTabPath: 20 },
      }),
    ).toEqual({
      contractId: 'delete-row-announces',
      surfaceId: 'clusters',
      task: 'Deleting a row announces the deletion',
      steps,
      obligations,
      maxTabPath: 20,
    });
  });

  it('leaves maxTabPath off when the requirement does not set it', () => {
    const contract = toVoiceContract({
      id: 'delete-row-announces',
      kind: 'voice',
      surface: 'clusters',
      description: 'Deleting a row announces the deletion',
      approved: true,
      assertion: {
        type: 'voice',
        steps: [{ do: 'tab' }],
        obligations: [{ class: 'focus-name', afterStep: 0, requiredTokens: ['delete'], mustAnnounce: false }],
      },
    });

    expect('maxTabPath' in contract).toBe(false);
  });
});

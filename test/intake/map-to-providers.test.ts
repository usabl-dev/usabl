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
    const context = await makeContext({
      page: makeFakePage({
        tab: vi.fn(async () => {}),
        press: vi.fn(async () => {}),
        activeNode: vi.fn(async () => ({
          name: '  Saved ',
          role: 'status',
          states: {},
        })),
        drainAnnouncements: vi.fn(async () => []),
      }),
    });

    await expect(provider!.run(context)).resolves.toEqual([]);
  });

  it('fails a flow whose only match is in the drain taken before its first step', async () => {
    // The capture runs for the life of the page, so the first drain holds what earlier checks
    // caused. The flow's own steps announce nothing.
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
    expect(drafts[0]).toMatchObject({ rule: 'intake:flow-save', confidence: 'fail', elementPath: '#save' });
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
      const context = await makeContext({
        page: makeFakePage({
          activeNode: vi.fn(async () => axNode('Saved')),
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

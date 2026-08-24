import { describe, expect, it, vi } from 'vitest';
import type { AxNode, ProviderContext, RequirementBundle } from '../../src/contracts/index.js';
import { makeFakePage } from '../../src/deps/fakes.js';
import { mapRequirementsToProviders } from '../../src/intake/map-to-providers.js';
import { testConfig } from '../helpers.js';

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

    const drafts = await provider!.run(context);

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

    const drafts = await provider!.run(context);

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
});

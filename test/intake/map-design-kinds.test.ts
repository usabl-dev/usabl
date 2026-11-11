import { describe, expect, it } from 'vitest';
import type { Requirement, RequirementBundle } from '../../src/contracts/index.js';
import { makeFakePage } from '../../src/deps/fakes.js';
import { mapRequirementsToProviders } from '../../src/intake/map-to-providers.js';
import { makeScanProviders, providerProves } from '../../src/providers/core-stack.js';
import { runProviders } from '../../src/providers/index.js';
import { testConfig } from '../helpers.js';

const DESIGN_REQUIREMENTS: Requirement[] = [
  { id: 'r-name', kind: 'name', surface: 'users', description: 'd', approved: true, assertion: { type: 'name', target: { role: 'button', name: 'Refresh' } } },
  { id: 'r-heading', kind: 'heading', surface: 'users', description: 'd', approved: true, assertion: { type: 'heading', name: 'Users', level: 1 } },
  { id: 'r-landmark', kind: 'landmark', surface: 'users', description: 'd', approved: true, assertion: { type: 'landmark', role: 'main' } },
  { id: 'r-order', kind: 'focus-order', surface: 'users', description: 'd', approved: true, assertion: { type: 'focus-order', sequence: ['A', 'B'] } },
  { id: 'r-size', kind: 'target-size', surface: 'users', description: 'd', approved: true, assertion: { type: 'target-size', target: { role: 'button', name: 'Refresh' }, minCssPx: 24 } },
];

const bundle: RequirementBundle = { version: 1, requirements: DESIGN_REQUIREMENTS };

describe('mapRequirementsToProviders with design kinds', () => {
  it('gives each design requirement its own provider, named by the requirement id', () => {
    expect(mapRequirementsToProviders(bundle).map((provider) => [provider.id, provider.layer])).toEqual([
      ['intake:r-name', 'intake-name'],
      ['intake:r-heading', 'intake-heading'],
      ['intake:r-landmark', 'intake-landmark'],
      ['intake:r-order', 'intake-focus-order'],
      ['intake:r-size', 'intake-target-size'],
    ]);
  });

  it('says before the scan that each one applies only to the screen it names', () => {
    for (const provider of mapRequirementsToProviders(bundle)) {
      expect(provider.appliesBeforeScan?.({ id: 'users', profile: 'app' })).toEqual({ applies: true });
      expect(provider.appliesBeforeScan?.({ id: 'other', profile: 'app' })).toEqual({
        applies: false,
        why: 'the requirement names another screen',
      });
    }
  });

  it('has a brief sentence for each kind', () => {
    const sentences = mapRequirementsToProviders(bundle).map((provider) => providerProves(provider));
    expect(sentences.every((sentence) => typeof sentence === 'string' && sentence.length > 0)).toBe(true);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it('runs the focus order check before any provider that changes the page, so it is never skipped', async () => {
    const providers = [
      ...makeScanProviders({ version: 1, requirements: [] }, { keyboardWalk: false }).map((provider) => ({
        ...provider,
        run: async () => [],
      })),
      {
        id: 'changes-the-page',
        layer: 'x',
        capabilities: ['live' as const],
        mutatesPageState: true,
        run: async () => [],
      },
      ...mapRequirementsToProviders({ version: 1, requirements: [DESIGN_REQUIREMENTS[3]!] }),
    ];
    const page = makeFakePage({ activeElementIs: async () => true, activePath: async () => 'body' });
    const result = await runProviders(providers, { page, screen: { id: 'users', url: 'x' }, config: testConfig() }, ['live']);
    expect(result.gaps).toEqual([]);
  });
});

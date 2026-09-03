import { describe, expect, it, vi } from 'vitest';
import type {
  Draft,
  Page,
  Provider,
  ProviderContext,
  ProviderOutput,
  RuleApplicability,
} from '../../src/contracts/index.js';
import { makeFakeDeps, makeFakePage } from '../../src/deps/fakes.js';
import { runProviders } from '../../src/providers/index.js';
import { makeKeyboardWalkProvider } from '../../src/providers/keyboard-walk/index.js';
import { makeRulepackProvider } from '../../src/providers/rulepack/index.js';
import { SEL } from '../../src/providers/rulepack/selectors.js';
import { testConfig } from '../helpers.js';

const SCREEN = { id: 'clusters', url: 'http://127.0.0.1:5173/clusters' };

const draft: Draft = {
  rule: 'button-name',
  layer: 'fake',
  severity: 'serious',
  evidenceClass: 'deterministic',
  screenId: SCREEN.id,
  elementPath: 'button:nth-of-type(1)',
  elementName: 'Save',
  role: 'button',
  whatUserExperiences: 'button has no accessible name',
  why: 'screen readers announce button with no label',
  fix: 'add an accessible name',
  evidence: {},
  confidence: 'fail',
};

const applicability: RuleApplicability = {
  screenId: SCREEN.id,
  layer: 'fake',
  rule: 'button-name',
  outcome: 'inapplicable',
  elementCount: 0,
};

async function makeContext(): Promise<ProviderContext> {
  const deps = makeFakeDeps();
  return {
    page: await deps.browser.open(SCREEN.url),
    screen: SCREEN,
    config: testConfig(),
  };
}

function recorder(
  calls: string[],
  id: string,
  flags: Partial<Pick<Provider, 'mutatesPageState' | 'requiresPristinePage'>> = {},
): Provider {
  return {
    id,
    layer: 'fake',
    capabilities: ['live'],
    ...flags,
    run: async (): Promise<Draft[]> => {
      calls.push(id);
      return [];
    },
  };
}

/**
 * A page whose single dialog trigger changes the page for good once clicked: after the click,
 * Tab lands on the body and a focus walk sees nothing. This is the shape that made a whole
 * detection layer disappear while coverage still read clean.
 */
function makeClickMutatedPage(): Page {
  let mutated = false;
  return makeFakePage({
    queryAll: async (selector) => {
      if (selector === SEL.dialogTrigger) {
        return [{ selector: '#open-dialog' }];
      }
      if (selector === SEL.dialog) {
        return mutated ? [{ selector: '[role="dialog"]' }] : [];
      }
      return [];
    },
    click: async () => {
      mutated = true;
    },
    activeElementWithin: async () => mutated,
    activeElementIs: async () => mutated,
    activePath: async () => '#save',
    activeNode: async () => ({ name: null, role: 'button', states: {} }),
  });
}

describe('runProviders', () => {
  it('records capability-denied and does not call a denied provider', async () => {
    const run = vi.fn(async (): Promise<Draft[]> => [draft]);
    const provider: Provider = {
      id: 'fake-live',
      layer: 'fake',
      capabilities: ['live'],
      run,
    };
    const ctx = await makeContext();

    const result = await runProviders([provider], ctx, []);

    expect(run).not.toHaveBeenCalled();
    expect(result.drafts).toEqual([]);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({
      ref: 'provider:fake-live',
      state: 'capability-denied',
    });
    expect(result.gaps[0]?.reason).toContain('live');
  });

  it('runs an allowed provider and returns its drafts', async () => {
    const run = vi.fn(async (): Promise<Draft[]> => [draft]);
    const provider: Provider = {
      id: 'fake-live',
      layer: 'fake',
      capabilities: ['live'],
      run,
    };
    const ctx = await makeContext();

    const result = await runProviders([provider], ctx, ['live']);

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(ctx);
    expect(result.drafts).toEqual([draft]);
    expect(result.gaps).toEqual([]);
    // A provider that returns a bare Draft[] reports nothing about applicability, and an
    // empty list is the honest reading of that: it did not say, so nothing is claimed.
    expect(result.applicability).toEqual([]);
  });

  it('collects drafts and applicability from a provider that returns both', async () => {
    const provider: Provider = {
      id: 'fake-live',
      layer: 'fake',
      capabilities: ['live'],
      run: async (): Promise<ProviderOutput> => ({ drafts: [draft], applicability: [applicability] }),
    };
    const ctx = await makeContext();

    const result = await runProviders([provider], ctx, ['live']);

    expect(result.drafts).toEqual([draft]);
    expect(result.applicability).toEqual([applicability]);
    expect(result.gaps).toEqual([]);
  });

  it('treats a provider output with no applicability key as reporting none', async () => {
    const provider: Provider = {
      id: 'fake-live',
      layer: 'fake',
      capabilities: ['live'],
      run: async (): Promise<ProviderOutput> => ({ drafts: [draft] }),
    };
    const ctx = await makeContext();

    const result = await runProviders([provider], ctx, ['live']);

    expect(result.drafts).toEqual([draft]);
    expect(result.applicability).toEqual([]);
  });

  it('ignores an applicability field that is not an array', async () => {
    // Provider is an exported contract, so a provider written outside this package is a real
    // shape the compiler never saw. A string here used to spread character by character into
    // the record, which is worse than reporting nothing.
    const provider: Provider = {
      id: 'fake-live',
      layer: 'fake',
      capabilities: ['live'],
      run: async (): Promise<ProviderOutput> =>
        ({ drafts: [draft], applicability: 'oops' } as unknown as ProviderOutput),
    };
    const ctx = await makeContext();

    const result = await runProviders([provider], ctx, ['live']);

    expect(result.applicability).toEqual([]);
    expect(result.drafts).toEqual([draft]);
  });

  it('ignores a drafts field that is not an array', async () => {
    const provider: Provider = {
      id: 'fake-live',
      layer: 'fake',
      capabilities: ['live'],
      run: async (): Promise<ProviderOutput> =>
        ({ drafts: 'oops', applicability: [applicability] } as unknown as ProviderOutput),
    };
    const ctx = await makeContext();

    const result = await runProviders([provider], ctx, ['live']);

    expect(result.drafts).toEqual([]);
    expect(result.applicability).toEqual([applicability]);
  });

  it('keeps applicability from providers that reported it when another provider throws', async () => {
    const reporter: Provider = {
      id: 'reporter',
      layer: 'fake',
      capabilities: ['live'],
      run: async (): Promise<ProviderOutput> => ({ drafts: [], applicability: [applicability] }),
    };
    const thrower: Provider = {
      id: 'thrower',
      layer: 'fake',
      capabilities: ['live'],
      run: async (): Promise<Draft[]> => {
        throw new Error('runner exploded');
      },
    };
    const ctx = await makeContext();

    const result = await runProviders([reporter, thrower], ctx, ['live']);

    expect(result.applicability).toEqual([applicability]);
    expect(result.gaps).toHaveLength(1);
  });

  it('carries provider-returned gaps into the result', async () => {
    const provider: Provider = {
      id: 'fake-live',
      layer: 'fake',
      capabilities: ['live'],
      run: async (): Promise<ProviderOutput> => ({
        drafts: [draft],
        gaps: [{ ref: 'provider:fake-live/check-x', state: 'not-covered', reason: 'check-x failed: boom' }],
      }),
    };
    const ctx = await makeContext();

    const result = await runProviders([provider], ctx, ['live']);

    expect(result.drafts).toEqual([draft]);
    expect(result.gaps).toEqual([
      { ref: 'provider:fake-live/check-x', state: 'not-covered', reason: 'check-x failed: boom' },
    ]);
  });

  it('ignores a gaps field that is not an array', async () => {
    const provider: Provider = {
      id: 'fake-live',
      layer: 'fake',
      capabilities: ['live'],
      run: async (): Promise<ProviderOutput> =>
        ({ drafts: [draft], gaps: 'oops' } as unknown as ProviderOutput),
    };
    const ctx = await makeContext();

    const result = await runProviders([provider], ctx, ['live']);

    expect(result.drafts).toEqual([draft]);
    expect(result.gaps).toEqual([]);
  });

  it('merges provider-returned gaps with the gaps it raises itself', async () => {
    // One provider returns drafts and its own scoped gap. A second provider throws, so
    // runProviders raises a not-covered gap for it. The result carries both, and the good
    // provider still contributes its draft.
    const scoped: Provider = {
      id: 'scoped',
      layer: 'fake',
      capabilities: ['live'],
      run: async (): Promise<ProviderOutput> => ({
        drafts: [draft],
        gaps: [{ ref: 'provider:scoped/check-y', state: 'not-covered', reason: 'check-y failed: kaboom' }],
      }),
    };
    const thrower: Provider = {
      id: 'thrower',
      layer: 'fake',
      capabilities: ['live'],
      run: async (): Promise<Draft[]> => {
        throw new Error('runner exploded');
      },
    };
    const ctx = await makeContext();

    const result = await runProviders([scoped, thrower], ctx, ['live']);

    expect(result.drafts).toEqual([draft]);
    expect(result.gaps).toHaveLength(2);
    expect(result.gaps).toEqual(
      expect.arrayContaining([
        { ref: 'provider:scoped/check-y', state: 'not-covered', reason: 'check-y failed: kaboom' },
        expect.objectContaining({ ref: 'provider:thrower', state: 'not-covered' }),
      ]),
    );
  });

  it('records not-covered when a provider throws', async () => {
    const run = vi.fn(async (): Promise<Draft[]> => {
      throw new Error('runner exploded');
    });
    const provider: Provider = {
      id: 'thrower',
      layer: 'fake',
      capabilities: ['live'],
      run,
    };
    const ctx = await makeContext();

    const result = await runProviders([provider], ctx, ['live']);

    expect(run).toHaveBeenCalledOnce();
    expect(result.drafts).toEqual([]);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({
      ref: 'provider:thrower',
      state: 'not-covered',
    });
    expect(result.gaps[0]?.reason).toContain('runner exploded');
  });

  it('runs providers in the caller order when none declares a page-state flag', async () => {
    const calls: string[] = [];
    const ctx = await makeContext();

    const result = await runProviders(
      [recorder(calls, 'first'), recorder(calls, 'second'), recorder(calls, 'third')],
      ctx,
      ['live'],
    );

    expect(calls).toEqual(['first', 'second', 'third']);
    expect(result.gaps).toEqual([]);
  });

  it('runs a page-mutating provider last even when the caller lists it first', async () => {
    const calls: string[] = [];
    const ctx = await makeContext();

    const result = await runProviders(
      [recorder(calls, 'mutator', { mutatesPageState: true }), recorder(calls, 'walker', { requiresPristinePage: true })],
      ctx,
      ['live'],
    );

    expect(calls).toEqual(['walker', 'mutator']);
    expect(result.gaps).toEqual([]);
  });

  it('keeps the caller order inside the non-mutating group and inside the mutating group', async () => {
    const calls: string[] = [];
    const ctx = await makeContext();

    await runProviders(
      [
        recorder(calls, 'mutator-a', { mutatesPageState: true }),
        recorder(calls, 'plain-a'),
        recorder(calls, 'mutator-b', { mutatesPageState: true }),
        recorder(calls, 'plain-b'),
      ],
      ctx,
      ['live'],
    );

    expect(calls).toEqual(['plain-a', 'plain-b', 'mutator-a', 'mutator-b']);
  });

  it('records a gap instead of running a pristine-page provider on an already mutated page', async () => {
    const calls: string[] = [];
    const ctx = await makeContext();

    // The second provider mutates the page too, so no ordering can hand it a clean page.
    const result = await runProviders(
      [
        recorder(calls, 'prober', { mutatesPageState: true }),
        recorder(calls, 'walker', { mutatesPageState: true, requiresPristinePage: true }),
      ],
      ctx,
      ['live'],
    );

    expect(calls).toEqual(['prober']);
    expect(result.drafts).toEqual([]);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({ ref: 'provider:walker', state: 'skipped' });
    expect(result.gaps[0]?.reason).toContain('prober');
  });

  it('still collects keyboard walk drafts when the rulepack is listed first', async () => {
    const ctx: ProviderContext = {
      page: makeClickMutatedPage(),
      screen: SCREEN,
      config: testConfig(),
    };

    const result = await runProviders(
      [makeRulepackProvider(), makeKeyboardWalkProvider()],
      ctx,
      ['live'],
    );

    expect(result.drafts.map((d) => d.rule)).toContain('keyboard-walk-unnamed-interactive');
    expect(result.gaps).toEqual([]);
  });
});

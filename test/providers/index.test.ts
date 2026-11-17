import { describe, expect, it, vi } from 'vitest';
import type {
  Draft,
  Page,
  Provider,
  ProviderContext,
  ProviderOutput,
  RuleApplicability,
  WalkRecord,
} from '../../src/contracts/index.js';
import { makeFakeDeps, makeFakePage } from '../../src/deps/fakes.js';
import { ProviderRunFailed, runProviders } from '../../src/providers/index.js';
import { makeScanProviders } from '../../src/providers/core-stack.js';
import { makeKeyboardWalkProvider } from '../../src/providers/keyboard-walk/index.js';
import { LEVEL1_REQUIREMENTS } from '../../src/measure/sensitivity/level1.js';
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
  flags: Partial<Pick<Provider, 'mutatesPageState' | 'requiresPristinePage' | 'navigatesOnPurpose'>> = {},
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
    // A PatternFly page, so the rulepack runs its probes and clicks.
    countEverywhere: async (selector) => (selector === SEL.pfMarker ? 1 : 0),
    queryAll: async (selector) => {
      if (selector === SEL.pfMarker) {
        return [{ selector: '.pf-v6-c-page' }];
      }
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

  it('keeps only the first line of the message of a provider that threw ProviderRunFailed', async () => {
    // A browser error's later lines can be its call log, which can quote the element's markup.
    const message = [
      'click timed out on #delete after 5000ms',
      'Call log:',
      '  - locator resolved to <button id="delete" aria-label="Delete alice@example.com">Delete</button>',
    ].join('\n');
    const provider: Provider = {
      id: 'intake:flow-delete',
      layer: 'intake-flow',
      capabilities: ['live'],
      run: async () => {
        throw new ProviderRunFailed(message, []);
      },
    };

    const result = await runProviders([provider], await makeContext(), ['live']);

    expect(result.gaps).toEqual([
      { ref: 'provider:intake:flow-delete', state: 'not-covered', reason: 'provider intake:flow-delete failed: click timed out on #delete after 5000ms' },
    ]);
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

  it('carries provider notes through beside drafts, and never turns one into a gap', async () => {
    const note = { ref: 'provider:fake-live/out-of-document', reason: '2 widgets sit inside frames the fake does not read.' };
    const provider: Provider = {
      id: 'fake-live',
      layer: 'fake',
      capabilities: ['live'],
      run: async (): Promise<ProviderOutput> => ({ drafts: [draft], notes: [note] }),
    };
    const ctx = await makeContext();

    const result = await runProviders([provider], ctx, ['live']);

    expect(result.notes).toEqual([note]);
    expect(result.gaps).toEqual([]);
    expect(result.drafts).toEqual([draft]);
  });

  it('reads notes that are not a list, and a bare Draft[], as no notes', async () => {
    const notAList: Provider = {
      id: 'odd',
      layer: 'fake',
      capabilities: ['live'],
      run: async () => ({ drafts: [], notes: 'not a list' }) as unknown as ProviderOutput,
    };
    const bare: Provider = { id: 'bare', layer: 'fake', capabilities: ['live'], run: async () => [draft] };
    const result = await runProviders([notAList, bare], await makeContext(), ['live']);

    expect(result.notes).toEqual([]);
  });

  it('carries the walk record of a provider to the caller, beside the drafts and never as one', async () => {
    const walk = { stops: [{ index: 0, elementPath: '#app', announcement: [], onBody: true as const }], complete: true };
    const provider: Provider = {
      id: 'walker',
      layer: 'fake',
      capabilities: ['live'],
      run: async (): Promise<ProviderOutput> => ({ drafts: [draft], walk }),
    };

    const result = await runProviders([provider], await makeContext(), ['live']);

    expect(result.walk).toEqual(walk);
    expect(result.drafts).toEqual([draft]);
    expect(result.gaps).toEqual([]);
  });

  it('has no walk record when no provider returned one, or the one returned is not a record', async () => {
    const bare: Provider = { id: 'bare', layer: 'fake', capabilities: ['live'], run: async () => [draft] };
    const odd: Provider = {
      id: 'odd',
      layer: 'fake',
      capabilities: ['live'],
      run: async () => ({ drafts: [], walk: { stops: 'not a list', complete: true } }) as unknown as ProviderOutput,
    };
    const noFlag: Provider = {
      id: 'no-flag',
      layer: 'fake',
      capabilities: ['live'],
      run: async () => ({ drafts: [], walk: { stops: [] } }) as unknown as ProviderOutput,
    };

    const result = await runProviders([bare, odd, noFlag], await makeContext(), ['live']);

    expect('walk' in result).toBe(false);
  });

  it('keeps the first walk record when more than one provider returns one', async () => {
    const first: WalkRecord = { stops: [{ index: 0, elementPath: '#app', announcement: [], onBody: true }], complete: true };
    const second: WalkRecord = { stops: [{ index: 0, elementPath: '#save', announcement: [] }], complete: true };
    const walker = (id: string, walk: WalkRecord): Provider => ({
      id,
      layer: 'fake',
      capabilities: ['live'],
      run: async (): Promise<ProviderOutput> => ({ drafts: [], walk }),
    });

    const result = await runProviders([walker('one', first), walker('two', second)], await makeContext(), ['live']);

    expect(result.walk).toEqual(first);
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

  it('runs a provider that may move the page on purpose after every other provider that acts on it', async () => {
    const calls: string[] = [];
    const ctx = await makeContext();

    await runProviders(
      [
        recorder(calls, 'flow-a', { mutatesPageState: true, navigatesOnPurpose: true }),
        recorder(calls, 'prober-a', { mutatesPageState: true }),
        recorder(calls, 'plain-a'),
        recorder(calls, 'flow-b', { mutatesPageState: true, navigatesOnPurpose: true }),
        recorder(calls, 'prober-b', { mutatesPageState: true }),
      ],
      ctx,
      ['live'],
    );

    expect(calls).toEqual(['plain-a', 'prober-a', 'prober-b', 'flow-a', 'flow-b']);
  });

  it('marks only the flow and voice providers of the scan stack as moving the page on purpose', () => {
    // The scan stack with one flow and one voice requirement. The PatternFly rulepack clicks, but
    // never means to leave the page, so it runs before the address read and has no such flag.
    const stack = makeScanProviders(LEVEL1_REQUIREMENTS);
    const navigating = stack.filter((provider) => provider.navigatesOnPurpose === true).map((provider) => provider.id);
    const flowAndVoice = LEVEL1_REQUIREMENTS.requirements
      .filter((requirement) => requirement.assertion.type === 'flow' || requirement.assertion.type === 'voice')
      .map((requirement) => `intake:${requirement.id}`);

    expect(flowAndVoice.length).toBeGreaterThanOrEqual(2);
    expect(navigating.sort()).toEqual(flowAndVoice.sort());
    expect(stack.find((provider) => provider.id === 'pf-rulepack')?.mutatesPageState).toBe(true);
    expect(stack.find((provider) => provider.id === 'pf-rulepack')?.navigatesOnPurpose).toBeUndefined();
    // The caller order already lists the rulepack before every requirement provider.
    const ids = stack.map((provider) => provider.id);
    expect(Math.max(...flowAndVoice.map((id) => ids.indexOf(id)))).toBeGreaterThan(ids.indexOf('pf-rulepack'));
    expect(Math.min(...flowAndVoice.map((id) => ids.indexOf(id)))).toBeGreaterThan(ids.indexOf('pf-rulepack'));
  });

  it('calls beforeIntendedNavigation before every provider that may move the page, after every other provider', async () => {
    const calls: string[] = [];
    const ctx = await makeContext();

    const result = await runProviders(
      [
        recorder(calls, 'flow-a', { mutatesPageState: true, navigatesOnPurpose: true }),
        recorder(calls, 'prober', { mutatesPageState: true }),
        recorder(calls, 'plain-a'),
        recorder(calls, 'flow-b', { mutatesPageState: true, navigatesOnPurpose: true }),
      ],
      ctx,
      ['live'],
      {
        beforeIntendedNavigation: async (provider) => {
          calls.push(`read address before ${provider.id}`);
          return null;
        },
      },
    );

    expect(calls).toEqual(['plain-a', 'prober', 'read address before flow-a', 'flow-a', 'read address before flow-b', 'flow-b']);
    expect(result.gaps).toEqual([]);
  });

  it('hands afterIntendedNavigation the drafts each provider that may move the page added, and only for one that ran', async () => {
    const ctx = await makeContext();
    const flow = (id: string): Provider => ({
      id,
      layer: 'fake',
      capabilities: ['live'],
      mutatesPageState: true,
      navigatesOnPurpose: true,
      run: async (): Promise<Draft[]> => [{ ...draft, rule: `${id}-rule` }],
    });
    const seen: Array<[string, string[]]> = [];

    const result = await runProviders(
      [{ ...recorder([], 'plain'), run: async () => [draft] }, flow('flow-a'), flow('flow-b'), flow('flow-c')],
      ctx,
      ['live'],
      {
        beforeIntendedNavigation: async (provider) =>
          provider.id === 'flow-c' ? { ref: 'provider:flow-c', state: 'not-covered', reason: 'skipped' } : null,
        afterIntendedNavigation: (provider, added) => {
          seen.push([provider.id, added.map((d) => d.rule)]);
        },
      },
    );

    expect(seen).toEqual([
      ['flow-a', ['flow-a-rule']],
      ['flow-b', ['flow-b-rule']],
    ]);
    expect(result.drafts.map((d) => d.rule)).toEqual(['button-name', 'flow-a-rule', 'flow-b-rule']);
  });

  it('skips a provider that may move the page when beforeIntendedNavigation returns a gap for it, and keeps that gap', async () => {
    const calls: string[] = [];
    const ctx = await makeContext();
    const gap = { ref: 'provider:flow-b', state: 'not-covered' as const, reason: 'flow-b did not run' };

    const result = await runProviders(
      [
        recorder(calls, 'flow-a', { mutatesPageState: true, navigatesOnPurpose: true }),
        recorder(calls, 'flow-b', { mutatesPageState: true, navigatesOnPurpose: true }),
      ],
      ctx,
      ['live'],
      { beforeIntendedNavigation: async (provider) => (provider.id === 'flow-b' ? gap : null) },
    );

    expect(calls).toEqual(['flow-a']);
    expect(result.gaps).toEqual([gap]);
  });

  it('does not call beforeIntendedNavigation for a provider that only acts on the page, one that does not run, or one for another screen', async () => {
    const calls: string[] = [];
    const ctx = await makeContext();
    const hook = vi.fn(async () => null);
    const denied: Provider = {
      ...recorder(calls, 'needs-net', { mutatesPageState: true, navigatesOnPurpose: true }),
      capabilities: ['network'],
    };
    // A flow written for another screen still runs here and reports nothing, so it moves nothing.
    const elsewhere: Provider = {
      ...recorder(calls, 'flow-for-settings', { mutatesPageState: true, navigatesOnPurpose: true }),
      appliesBeforeScan: () => ({ applies: false, why: 'the requirement names another screen' }),
    };

    await runProviders(
      [recorder(calls, 'plain-a'), recorder(calls, 'prober', { mutatesPageState: true }), denied, elsewhere],
      ctx,
      ['live'],
      { beforeIntendedNavigation: hook },
    );

    expect(calls).toEqual(['plain-a', 'prober', 'flow-for-settings']);
    expect(hook).not.toHaveBeenCalled();
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
    // No gap says the walk was skipped on a changed page. The page gives every Tab the same path,
    // so the walk reads a cycle and gives the screen its own gap for a walk that was cut short.
    expect(result.gaps.filter((gap) => gap.state === 'skipped')).toEqual([]);
    expect(result.gaps.map((gap) => gap.reason)).toEqual([expect.stringContaining('the keyboard walk was cut short')]);
  });
});

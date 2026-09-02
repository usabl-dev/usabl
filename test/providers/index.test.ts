import { describe, expect, it, vi } from 'vitest';
import type { Draft, Page, Provider, ProviderContext } from '../../src/contracts/index.js';
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

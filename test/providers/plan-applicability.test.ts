/**
 * What each provider can say about a screen before any page opens, and the one sentence that says
 * what it checks. `usabl brief` prints both. A provider that says it does not apply must also do
 * nothing on that screen when it runs, or the brief would tell an agent a check is off while the
 * gate still runs it.
 */
import { describe, expect, it } from 'vitest';
import type { Provider, ProviderContext, RequirementBundle, UsablConfig } from '../../src/contracts/index.js';
import { DECIDED_ON_PAGE, plannedApplicability } from '../../src/providers/applicability.js';
import { makeScanProviders, providerProves } from '../../src/providers/core-stack.js';
import { makeEngineProviders } from '../../src/providers/engines/index.js';
import { makeFakePage } from '../../src/deps/fakes.js';
import { draftsOf } from '../helpers.js';

const bundle: RequirementBundle = {
  version: 1,
  requirements: [
    {
      id: 'clusters-heading',
      kind: 'content',
      surface: 'clusters',
      description: 'heading',
      assertion: { type: 'content', selector: 'h1', expectedText: 'Clusters' },
      approved: true,
    },
    {
      id: 'delete-row',
      kind: 'flow',
      surface: 'clusters',
      description: 'delete announces',
      assertion: { type: 'flow', steps: [{ do: 'tab' }], expectedAnnouncement: 'Cluster deleted' },
      approved: true,
    },
  ],
};

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: [],
};

function everyProvider(): Provider[] {
  return [
    ...makeScanProviders(bundle),
    ...makeEngineProviders({ deque: { enabled: true }, evinced: { enabled: true } }),
  ];
}

const appScreen = { id: 'clusters', profile: 'app' as const };
const otherAppScreen = { id: 'alerts', profile: 'app' as const };
const docsScreen = { id: 'getting-started', profile: 'docs' as const };

function planOf(id: string, screen: { id: string; profile: 'app' | 'docs' }) {
  const provider = everyProvider().find((entry) => entry.id === id);
  if (provider === undefined) throw new Error(`no provider ${id}`);
  return plannedApplicability(provider, screen);
}

describe('providerProves', () => {
  it('has one plain sentence for every provider a run can build', () => {
    for (const provider of everyProvider()) {
      const proves = providerProves(provider);
      expect(proves, `${provider.id} has no proves sentence`).not.toBeNull();
      expect(proves?.trim().length ?? 0).toBeGreaterThan(10);
      expect(proves).not.toMatch(/\u2014|-{2}/u);
    }
  });

  it('names the requirement kind for intake providers', () => {
    const proves = everyProvider()
      .filter((provider) => provider.id.startsWith('intake:'))
      .map((provider) => providerProves(provider));
    expect(proves[0]).toMatch(/^content requirement: /u);
    expect(proves[1]).toMatch(/^flow requirement: /u);
  });

  it('has no sentence for a provider it does not know', () => {
    expect(providerProves({ id: 'made-up', layer: 'x', capabilities: ['live'], run: async () => [] })).toBeNull();
  });
});

describe('plannedApplicability', () => {
  it('says axe-core and the keyboard walk apply to every screen', () => {
    for (const screen of [appScreen, docsScreen]) {
      expect(planOf('axe-core', screen)).toEqual({ applies: true });
      expect(planOf('keyboard-walk', screen)).toEqual({ applies: true });
    }
  });

  it('says the PatternFly rulepack is off on docs and decided on the page elsewhere', () => {
    expect(planOf('pf-rulepack', appScreen)).toEqual({ applies: true, why: DECIDED_ON_PAGE });
    expect(planOf('pf-rulepack', docsScreen)).toEqual({ applies: false, why: expect.stringMatching(/docs/u) });
  });

  it('says the RHDS rulepack is decided on the page on both profiles', () => {
    expect(planOf('rhds-rulepack', appScreen)).toEqual({ applies: true, why: DECIDED_ON_PAGE });
    expect(planOf('rhds-rulepack', docsScreen)).toEqual({ applies: true, why: DECIDED_ON_PAGE });
  });

  it('says the docs rulepack runs only on docs pages', () => {
    expect(planOf('docs-rulepack', docsScreen)).toEqual({ applies: true });
    expect(planOf('docs-rulepack', appScreen)).toEqual({ applies: false, why: expect.stringMatching(/docs/u) });
  });

  it('says an intake requirement applies only to the screen it names', () => {
    for (const id of ['intake:clusters-heading', 'intake:delete-row']) {
      expect(planOf(id, appScreen)).toEqual({ applies: true });
      expect(planOf(id, otherAppScreen)).toEqual({
        applies: false,
        why: expect.stringMatching(/another screen/u),
      });
    }
  });

  it('says a turned-on engine applies and that its findings are preview', () => {
    for (const id of ['deque', 'evinced']) {
      expect(planOf(id, appScreen)).toEqual({ applies: true, why: expect.stringMatching(/preview/u) });
    }
  });

  it('never guesses for a provider that says nothing: it is decided on the page', () => {
    const silent: Provider = { id: 'silent', layer: 'x', capabilities: ['live'], run: async () => [] };
    expect(plannedApplicability(silent, appScreen)).toEqual({ applies: true, why: DECIDED_ON_PAGE });
  });

  it('agrees with the provider run: a provider that does not apply reports nothing there', async () => {
    const screens = [appScreen, otherAppScreen, docsScreen];
    let checked = 0;
    for (const provider of makeScanProviders(bundle)) {
      for (const screen of screens) {
        if (plannedApplicability(provider, screen).applies) continue;
        checked += 1;
        // Every page method throws, so a provider that touches the page here fails the test.
        const page = makeFakePage(
          Object.fromEntries(
            Object.keys(makeFakePage()).map((key) => [
              key,
              async () => {
                throw new Error(`${provider.id} used page.${key} on ${screen.id}`);
              },
            ]),
          ),
        );
        const ctx: ProviderContext = {
          page,
          screen: { id: screen.id, url: 'http://127.0.0.1:5173/x' },
          config,
          profile: screen.profile,
        };
        expect(draftsOf(await provider.run(ctx)), `${provider.id} on ${screen.id}`).toEqual([]);
      }
    }
    // pf-rulepack on docs, docs-rulepack on the two app screens, and the two intake providers on
    // alerts and on the docs page.
    expect(checked).toBe(7);
  });
});

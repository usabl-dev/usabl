import { describe, expect, it, vi } from 'vitest';
import type {
  ApiResponse,
  AxNode,
  Draft,
  Page,
  Provider,
  ProviderOutput,
  ReadinessProbe,
  RuleApplicability,
  SurfaceConfig,
} from '../../src/contracts/index.js';
import { markUnseenScreens } from '../../src/coverage/unseen.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeCheckRunner } from '../../src/providers/check-runner.js';
import { makeStepRunner } from '../../src/providers/keyboard-walk/steps.js';
import { testConfig } from '../helpers.js';

const SCREEN = { id: 'clusters', url: 'http://127.0.0.1:5173/clusters' };

interface ScriptedPageSpec {
  activePaths: string[];
  activeNodes: Array<AxNode | null>;
  onClose?: () => void;
}

function readAt<T>(values: T[], index: number, fallback: T): T {
  return values[index] ?? fallback;
}

async function makeScriptedPage(spec: ScriptedPageSpec): Promise<Page> {
  const deps = makeFakeDeps();
  const page = await deps.browser.open(SCREEN.url);
  let cursor = -1;
  const currentIndex = (): number => (cursor < 0 ? 0 : cursor);

  return Object.assign(page, {
    tab: async () => {
      cursor += 1;
    },
    activePath: async () => readAt(spec.activePaths, currentIndex(), '#first'),
    activeNode: async () => readAt(spec.activeNodes, currentIndex(), null),
    drainAnnouncements: async () => [],
    close: async () => {
      spec.onClose?.();
    },
  });
}

function makeDraft(rule: string): Draft {
  return {
    rule,
    layer: 'fake',
    severity: 'serious',
    evidenceClass: 'deterministic',
    screenId: SCREEN.id,
    elementPath: '#first',
    elementName: 'Save',
    role: 'button',
    whatUserExperiences: 'A button has no accessible name',
    why: 'AT users hear an unlabeled control',
    fix: 'Add an accessible name to the button',
    evidence: {},
    confidence: 'fail',
  };
}

describe('makeCheckRunner', () => {
  it('records transcript stops, provider drafts, and capability-denied gaps', async () => {
    const page = await makeScriptedPage({
      activePaths: ['#first', '#second', '#first'],
      activeNodes: [
        { name: 'Save', role: 'button', states: {} },
        { name: 'Cancel', role: 'button', states: {} },
        { name: 'Save', role: 'button', states: {} },
      ],
    });
    const allowedDraft = makeDraft('allowed-provider-rule');
    const allowedProvider: Provider = {
      id: 'allowed-live',
      layer: 'fake',
      capabilities: ['live'],
      run: async (): Promise<Draft[]> => [allowedDraft],
    };
    const deniedRun = vi.fn(async (): Promise<Draft[]> => [makeDraft('should-not-run')]);
    const deniedProvider: Provider = {
      id: 'needs-net',
      layer: 'fake',
      capabilities: ['network'],
      run: deniedRun,
    };
    const runner = makeCheckRunner({
      browser: { open: async () => page, close: async () => {} },
      providers: [allowedProvider, deniedProvider],
      config: testConfig(),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
    });

    const scan = await runner.scan(SCREEN);

    expect(deniedRun).not.toHaveBeenCalled();
    expect(scan.drafts).toEqual([allowedDraft]);
    expect(scan.stops.length).toBeGreaterThan(0);
    expect(scan.gaps).toEqual([
      {
        ref: 'provider:needs-net',
        state: 'capability-denied',
        reason: 'provider needs-net denied capability: network',
      },
    ]);
  });

  it('carries provider applicability onto the scan', async () => {
    const page = await makeScriptedPage({ activePaths: ['#first', '#first'], activeNodes: [null, null] });
    const entry: RuleApplicability = {
      screenId: SCREEN.id,
      layer: 'fake',
      rule: 'video-caption',
      outcome: 'inapplicable',
      elementCount: 0,
    };
    const reporter: Provider = {
      id: 'reporter',
      layer: 'fake',
      capabilities: ['live'],
      run: async (): Promise<ProviderOutput> => ({ drafts: [], applicability: [entry] }),
    };
    const runner = makeCheckRunner({
      browser: { open: async () => page, close: async () => {} },
      providers: [reporter],
      config: testConfig(),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
    });

    const scan = await runner.scan(SCREEN);

    expect(scan.applicability).toEqual([entry]);
    expect(scan.drafts).toEqual([]);
    expect(scan.gaps).toEqual([]);
  });

  it('turns provider throws into not-covered gaps and closes the page', async () => {
    let closeCalls = 0;
    const page = await makeScriptedPage({
      activePaths: ['#first', '#first'],
      activeNodes: [{ name: 'Save', role: 'button', states: {} }, { name: 'Save', role: 'button', states: {} }],
      onClose: () => {
        closeCalls += 1;
      },
    });
    const thrower: Provider = {
      id: 'thrower',
      layer: 'fake',
      capabilities: ['live'],
      run: async (): Promise<Draft[]> => {
        throw new Error('provider exploded');
      },
    };
    const runner = makeCheckRunner({
      browser: { open: async () => page, close: async () => {} },
      providers: [thrower],
      config: testConfig(),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
    });

    const scan = await runner.scan(SCREEN);

    expect(scan.drafts).toEqual([]);
    expect(scan.gaps).toHaveLength(1);
    expect(scan.gaps[0]).toMatchObject({
      ref: 'provider:thrower',
      state: 'not-covered',
    });
    expect(scan.gaps[0]?.reason).toContain('provider exploded');
    expect(closeCalls).toBe(1);
  });

  it('threads the scan profile into the provider context and defaults to app', async () => {
    const seen: Array<string | undefined> = [];
    const spy: Provider = {
      id: 'profile-spy',
      layer: 'fake',
      capabilities: ['live'],
      run: async (ctx): Promise<Draft[]> => {
        seen.push(ctx.profile);
        return [];
      },
    };
    const runnerFor = (page: Page) =>
      makeCheckRunner({
        browser: { open: async () => page, close: async () => {} },
        providers: [spy],
        config: testConfig(),
        allowedCapabilities: ['live'],
        stepRunner: makeStepRunner(),
      });

    const docsPage = await makeScriptedPage({ activePaths: ['#first', '#first'], activeNodes: [null, null] });
    await runnerFor(docsPage).scan({ ...SCREEN, profile: 'docs' });
    expect(seen).toEqual(['docs']);

    seen.length = 0;
    const appPage = await makeScriptedPage({ activePaths: ['#first', '#first'], activeNodes: [null, null] });
    await runnerFor(appPage).scan(SCREEN);
    expect(seen).toEqual(['app']);
  });

  it('returns a not-covered gap when the page never becomes ready', async () => {
    const page = await makeScriptedPage({ activePaths: ['#first'], activeNodes: [null] });
    const runner = makeCheckRunner({
      browser: {
        open: async (): Promise<Page> =>
          Object.assign(page, {
            gotoReady: async (): Promise<void> => {
              throw new Error('page did not stop changing within 15000ms');
            },
          }),
        close: async () => {},
      },
      providers: [],
      config: testConfig(),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
    });

    const scan = await runner.scan(SCREEN);

    // A page that never settled is disclosed, never scanned and reported as clean.
    expect(scan.stops).toEqual([]);
    expect(scan.applicability).toEqual([]);
    expect(scan.gaps).toHaveLength(1);
    expect(scan.gaps[0]).toMatchObject({ ref: SCREEN.url, state: 'not-covered' });
    expect(scan.gaps[0]?.reason).toContain('page did not stop changing');
  });

  it('returns a not-covered gap when browser.open throws and never rejects', async () => {
    const runner = makeCheckRunner({
      browser: {
        open: async (): Promise<Page> => {
          throw new Error('open failed');
        },
        close: async () => {},
      },
      providers: [],
      config: testConfig(),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
    });

    await expect(runner.scan(SCREEN)).resolves.toEqual({
      screenId: SCREEN.id,
      url: SCREEN.url,
      stops: [],
      drafts: [],
      // Nothing was opened, so nothing is known about which rules applied here.
      applicability: [],
      // Nothing rendered, so no reachability claim is made either way.
      reachedSelectorPresent: null,
      reachedWhenSelector: null,
      gaps: [
        {
          ref: SCREEN.url,
          state: 'not-covered',
          reason: 'screen failed to open: open failed',
        },
      ],
    });
  });

  it('makes no reachability claim when the surface declares no reachedWhen', async () => {
    const page = await makeScriptedPage({ activePaths: ['#first', '#first'], activeNodes: [null, null] });
    const runner = makeCheckRunner({
      browser: { open: async () => page, close: async () => {} },
      providers: [],
      config: testConfig(),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
    });

    const scan = await runner.scan(SCREEN);

    expect(scan.reachedSelectorPresent).toBeNull();
    expect(scan.reachedWhenSelector).toBeNull();
  });

  it('records reachedSelectorPresent true when a declared reachedWhen matches the DOM', async () => {
    const page = await makeScriptedPage({ activePaths: ['#first', '#first'], activeNodes: [null, null] });
    // queryAll returns one match for the declared selector, so the screen provably rendered.
    Object.assign(page, { queryAll: async () => [{ selector: 'main#app-root' }] });
    const runner = makeCheckRunner({
      browser: { open: async () => page, close: async () => {} },
      providers: [],
      config: testConfig({
        surfaces: [{ id: SCREEN.id, url: SCREEN.url, files: [], reachedWhen: 'main#app-root' }],
      }),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
    });

    const scan = await runner.scan(SCREEN);

    expect(scan.reachedSelectorPresent).toBe(true);
    expect(scan.reachedWhenSelector).toBe('main#app-root');
  });

  it('records reachedSelectorPresent false when a declared reachedWhen matches nothing', async () => {
    const page = await makeScriptedPage({ activePaths: ['#first', '#first'], activeNodes: [null, null] });
    // queryAll returns no matches, so the element the operator said proves the load was absent.
    Object.assign(page, { queryAll: async () => [] });
    const runner = makeCheckRunner({
      browser: { open: async () => page, close: async () => {} },
      providers: [],
      config: testConfig({
        surfaces: [{ id: SCREEN.id, url: SCREEN.url, files: [], reachedWhen: 'main#app-root' }],
      }),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
    });

    const scan = await runner.scan(SCREEN);

    expect(scan.reachedSelectorPresent).toBe(false);
    expect(scan.reachedWhenSelector).toBe('main#app-root');
  });

  it('records whether a declared readiness response arrived, and names it', async () => {
    for (const [responses, seen] of [
      [[{ url: 'http://127.0.0.1:5173/api/clusters', status: 200, contentType: 'application/json', sentBeforeWalk: true }], true],
      [[{ url: 'http://127.0.0.1:5173/api/clusters', status: 401, contentType: 'application/json', sentBeforeWalk: true }], false],
      [[], false],
    ] as const) {
      const page = await makeScriptedPage({ activePaths: ['#first', '#first'], activeNodes: [null, null] });
      Object.assign(page, { apiResponses: async () => responses });
      const runner = makeCheckRunner({
        browser: { open: async () => page, close: async () => {} },
        providers: [],
        config: testConfig({
          appBaseUrl: 'http://127.0.0.1:5173',
          surfaces: [{ id: SCREEN.id, url: SCREEN.url, files: [], reachedWhen: { response: '/api/clusters' } }],
        }),
        allowedCapabilities: ['live'],
        stepRunner: makeStepRunner(),
      });

      const scan = await runner.scan(SCREEN);

      expect(scan.reachedResponseSeen).toBe(seen);
      expect(scan.reachedWhenResponse).toBe('/api/clusters');
      // No selector was declared, so no selector claim is made.
      expect(scan.reachedSelectorPresent).toBeNull();
    }
  });

  it('does not count a declared response that a check caused, only traffic sent before the walk', async () => {
    // A page with no data responses at load, where a provider's run then fires the declared path
    // and is answered 200. That request is usabl's doing, not the screen loading.
    const page = await makeScriptedPage({ activePaths: ['#first', '#first'], activeNodes: [null, null] });
    let walkStarted = false;
    const responses: ApiResponse[] = [];
    Object.assign(page, {
      markWalkStart: async () => {
        walkStarted = true;
      },
      apiResponses: async () => responses.map((response) => ({ ...response })),
    });
    const clickingProvider: Provider = {
      id: 'clicks-something',
      layer: 'fake',
      capabilities: ['live'],
      run: async (): Promise<Draft[]> => {
        responses.push({
          url: 'http://127.0.0.1:5173/api/clusters',
          status: 200,
          contentType: 'application/json',
          sentBeforeWalk: !walkStarted,
        });
        return [];
      },
    };
    const runner = makeCheckRunner({
      browser: { open: async () => page, close: async () => {} },
      providers: [clickingProvider],
      config: testConfig({
        appBaseUrl: 'http://127.0.0.1:5173',
        surfaces: [{ id: SCREEN.id, url: SCREEN.url, files: [], reachedWhen: { response: '/api/clusters' } }],
      }),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
    });

    const scan = await runner.scan(SCREEN);

    expect(walkStarted).toBe(true);
    expect(scan.reachedResponseSeen).toBe(false);
  });

  it('does not count a declared response the page sent on load that was answered only during the walk', async () => {
    // The request went out before the walk and its answer arrived after the walk began. Whatever
    // that answer mounted, the walk ran without it, so the screen's data was not there when usabl
    // checked it. The real readiness wait holds the walk while such a request is in flight, so this
    // only happens when the budget runs out first.
    const page = await makeScriptedPage({ activePaths: ['#first', '#first'], activeNodes: [null, null] });
    let walkStarted = false;
    Object.assign(page, {
      markWalkStart: async () => {
        walkStarted = true;
      },
      apiResponses: async () =>
        walkStarted
          ? [{ url: 'http://127.0.0.1:5173/api/clusters', status: 200, contentType: 'application/json', sentBeforeWalk: true }]
          : [],
    });
    const runner = makeCheckRunner({
      browser: { open: async () => page, close: async () => {} },
      providers: [],
      config: testConfig({
        appBaseUrl: 'http://127.0.0.1:5173',
        surfaces: [{ id: SCREEN.id, url: SCREEN.url, files: [], reachedWhen: { response: '/api/clusters' } }],
      }),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
    });

    const scan = await runner.scan(SCREEN);

    expect(walkStarted).toBe(true);
    expect(scan.reachedResponseSeen).toBe(false);
  });

  it('asks readiness to wait only for a declared selector, under the signal cap', async () => {
    // The fake readiness does not wait, so the test reads the probe the runner handed it and asks
    // it directly, the way the real driver does once the page has settled.
    const probes: Array<ReadinessProbe | undefined> = [];
    let contentMounted = false;
    const pageFor = async (): Promise<Page> => {
      const page = await makeScriptedPage({ activePaths: ['#first', '#first'], activeNodes: [null, null] });
      return Object.assign(page, {
        gotoReady: async (readyWhen?: ReadinessProbe): Promise<void> => {
          probes.push(readyWhen);
        },
        queryAll: async () => (contentMounted ? [{ selector: 'table#clusters' }] : []),
      });
    };
    const runnerFor = (reachedWhen: SurfaceConfig['reachedWhen'], signalTimeoutMs?: number) =>
      makeCheckRunner({
        browser: { open: pageFor, close: async () => {} },
        providers: [],
        config: testConfig({
          surfaces: [{ id: SCREEN.id, url: SCREEN.url, files: [], ...(reachedWhen === undefined ? {} : { reachedWhen }) }],
          ...(signalTimeoutMs === undefined ? {} : { signalTimeoutMs }),
        }),
        allowedCapabilities: ['live'],
        stepRunner: makeStepRunner(),
      });

    await runnerFor(undefined).scan(SCREEN);
    // A response stays seen once it arrived, so it cannot say the screen is still showing its
    // data. It never holds or ends the wait.
    await runnerFor({ response: '/api/clusters' }).scan(SCREEN);
    await runnerFor('table#clusters').scan(SCREEN);
    await runnerFor({ selector: 'table#clusters', response: '/api/clusters' }, 4_000).scan(SCREEN);

    expect(probes[0]).toBeUndefined();
    expect(probes[1]).toBeUndefined();
    const probe = probes[2];
    expect(probe?.timeoutMs).toBe(15_000);
    expect(probes[3]?.timeoutMs).toBe(4_000);
    // Shell only: the selector has not held, so readiness keeps waiting.
    await expect(probe?.holds()).resolves.toBe(false);
    contentMounted = true;
    await expect(probe?.holds()).resolves.toBe(true);
  });

  it('stops the readiness wait at once on a page that is plainly not this screen', async () => {
    // A redirect to a page with a password field is a sign-in page whatever the signal says, so
    // waiting the whole cap for the screen's content would only delay the gap.
    const probes: Array<ReadinessProbe | undefined> = [];
    const page = await makeScriptedPage({ activePaths: ['#first'], activeNodes: [null] });
    Object.assign(page, {
      gotoReady: async (readyWhen?: ReadinessProbe): Promise<void> => {
        probes.push(readyWhen);
      },
      currentUrl: async () => 'http://127.0.0.1:5173/sign-in',
      countEverywhere: async () => 1,
      queryAll: async () => [],
    });
    const runner = makeCheckRunner({
      browser: { open: async () => page, close: async () => {} },
      providers: [],
      config: testConfig({
        surfaces: [{ id: SCREEN.id, url: SCREEN.url, files: [], reachedWhen: 'table#clusters' }],
      }),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
    });

    const scan = await runner.scan(SCREEN);

    await expect(probes[0]?.holds()).resolves.toBe(true);
    expect(scan.gaps[0]?.reason).toContain('redirected away');
  });

  it('ends the screen as a gap with no walk when the selector did not hold within the cap', async () => {
    // The wait ran out with the declared selector absent. Walking and checking a page that does
    // not show the screen's content would only produce evidence about some other page.
    const page = await makeScriptedPage({ activePaths: ['#first', '#first'], activeNodes: [null, null] });
    let walkStarted = false;
    let tabs = 0;
    Object.assign(page, {
      markWalkStart: async () => {
        walkStarted = true;
      },
      tab: async () => {
        tabs += 1;
      },
      queryAll: async () => [],
    });
    const providerRun = vi.fn(async (): Promise<Draft[]> => [makeDraft('should-not-run')]);
    const runner = makeCheckRunner({
      browser: { open: async () => page, close: async () => {} },
      providers: [{ id: 'checks', layer: 'fake', capabilities: ['live'], run: providerRun }],
      config: testConfig({
        surfaces: [{ id: SCREEN.id, url: SCREEN.url, files: [], reachedWhen: 'table#clusters' }],
        signalTimeoutMs: 4_000,
      }),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
    });

    const scan = await runner.scan(SCREEN);

    expect(walkStarted).toBe(false);
    expect(tabs).toBe(0);
    expect(providerRun).not.toHaveBeenCalled();
    expect(scan.stops).toEqual([]);
    expect(scan.drafts).toEqual([]);
    expect(scan.reachedSelectorPresent).toBe(false);
    const reasons = markUnseenScreens([scan]).screens[0]?.gaps.map((gap) => gap.reason) ?? [];
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('table#clusters');
    expect(reasons[0]).toContain('4000');
    expect(reasons[0]).toContain('signalTimeoutMs');
  });

  it('does not count a selector that held before the walk and was gone after the checks', async () => {
    // The selector held before the walk and was gone after it, so the walk or a check changed
    // the page. The part holds only when it held at both moments.
    const page = await makeScriptedPage({ activePaths: ['#first', '#first'], activeNodes: [null, null] });
    let walkStarted = false;
    Object.assign(page, {
      markWalkStart: async () => {
        walkStarted = true;
      },
      queryAll: async () => (walkStarted ? [] : [{ selector: 'table#clusters' }]),
    });
    const runner = makeCheckRunner({
      browser: { open: async () => page, close: async () => {} },
      providers: [],
      config: testConfig({
        surfaces: [{ id: SCREEN.id, url: SCREEN.url, files: [], reachedWhen: 'table#clusters' }],
      }),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
    });

    const scan = await runner.scan(SCREEN);

    expect(walkStarted).toBe(true);
    expect(scan.reachedSelectorPresent).toBe(false);
  });

  it('reads a reachedWhen that throws in the DOM as absent, not a scan failure', async () => {
    const page = await makeScriptedPage({ activePaths: ['#first', '#first'], activeNodes: [null, null] });
    // A malformed selector makes the browser query throw. It cannot match, so it reads as absent
    // and the scan still completes rather than failing the whole screen.
    Object.assign(page, {
      queryAll: async () => {
        throw new Error('invalid selector');
      },
    });
    const runner = makeCheckRunner({
      browser: { open: async () => page, close: async () => {} },
      providers: [],
      config: testConfig({
        surfaces: [{ id: SCREEN.id, url: SCREEN.url, files: [], reachedWhen: ':::bad' }],
      }),
      allowedCapabilities: ['live'],
      stepRunner: makeStepRunner(),
    });

    const scan = await runner.scan(SCREEN);

    expect(scan.reachedSelectorPresent).toBe(false);
    expect(scan.gaps).toEqual([]);
  });
});

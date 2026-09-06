import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Deps, Result, UsablConfig } from '../../src/contracts/index.js';
import type { RealBrowserOptions, SharedBrowser } from '../../src/deps/real.js';
import { overlayClientSource } from '../../src/surfaces/overlay-client.js';
import {
  isRequestFromDevOrigin,
  makeResultCache,
  projectOverlay,
  usablVitePlugin,
  usablVitePluginFromConfig,
} from '../../src/surfaces/vite-plugin.js';
import { testConfig } from '../helpers.js';

const baseResult = (over: Partial<Result>): Result => ({
  schemaVersion: 'usabl.result.v1',
  verdict: 'verified',
  summary: 'verified: 0 gating finding(s)',
  screens: [],
  coverage: {
    changedFiles: [],
    affected: [],
    unresolvedFiles: [],
    gaps: [],
    nothingToCheck: false,
  },
  findings: [],
  receipt: null,
  dirtyGuardedPaths: [],
  exitCode: 0,
  accessibilityVerdict: null,
  accessibilityExitCode: 0,
  paidDownCount: 0,
  ...over,
});

describe('projectOverlay', () => {
  it('projects advisory payload with display exit code 0', () => {
    const overlay = projectOverlay(baseResult({ verdict: 'regression', exitCode: 1 }));

    expect(overlay).toEqual(
      expect.objectContaining({
        advisory: true,
        displayExitCode: 0,
        verdict: 'regression',
        schemaVersion: 'usabl.result.v1',
      }),
    );
  });

  it('scrubs sensitive text before JSON egress', () => {
    const overlay = projectOverlay(baseResult({ summary: 'password=hunter2 from page' }));

    expect(JSON.stringify(overlay)).not.toContain('hunter2');
  });

  it('includes scrubbed finding details for badge lists', () => {
    const overlay = projectOverlay(
      baseResult({
        findings: [
          {
            rule: 'color-contrast',
            layer: 'axe',
            severity: 'serious',
            evidenceClass: 'deterministic',
            screenId: 'clusters',
            elementPath: 'button',
            elementName: 'Save',
            role: 'button',
            whatUserExperiences: 'token=SECRETPOISON text is hard to read',
            why: 'token=SECRETPOISON explanation',
            fix: 'raise contrast',
            evidence: {},
            confidence: 'fail',
            elementKey: 'k',
            identityBasis: 'name',
            status: 'new',
          },
        ],
      }),
    );

    expect(overlay.findings).toEqual([
      expect.objectContaining({
        rule: 'color-contrast',
        fix: 'raise contrast',
      }),
    ]);
    expect(JSON.stringify(overlay.findings)).not.toContain('SECRETPOISON');
  });

  it('projects the complete gate-owned inspector contract', () => {
    const finding: Result['findings'][number] = {
      rule: 'pf-focus-into-dialog',
      layer: 'pf',
      severity: 'serious',
      evidenceClass: 'deterministic',
      screenId: 'clusters',
      elementPath: '#cluster-details',
      elementName: 'View cluster details',
      role: 'button',
      whatUserExperiences: 'Focus stays behind the dialog.',
      why: 'The dialog focus lifecycle is incomplete.',
      fix: 'Move focus into the dialog when it opens.',
      evidence: {},
      confidence: 'fail',
      elementKey: 'clusters|pf-focus-into-dialog|name:view-cluster-details',
      identityBasis: 'name',
      status: 'new',
    };
    const overlay = projectOverlay(
      baseResult({
        verdict: 'regression',
        exitCode: 1,
        coverage: {
          changedFiles: ['src/pages/Clusters.tsx'],
          affected: [
            {
              screenId: 'clusters',
              url: 'http://127.0.0.1:5173/clusters',
              provenance: 'route-graph',
              importChain: ['src/pages/Clusters.tsx', 'src/components/DemoModal.tsx'],
            },
          ],
          unresolvedFiles: ['src/pages/Unknown.tsx'],
          gaps: [{ ref: 'clusters', state: 'not-covered', reason: 'browser unavailable' }],
          nothingToCheck: false,
        },
        findings: [finding],
        receipt: null,
        dirtyGuardedPaths: [],
      }),
    );
    const verifiedOverlay = projectOverlay(
      baseResult({
        verdict: 'verified',
        exitCode: 0,
        findings: [{ ...finding, status: 'fixed' }],
        receipt: {
          schemaVersion: 1,
          sourceTree: 'abcdef1234567890',
          baseRevision: 'base123',
          policyHash: 'policy123',
          runnerVersion: '0.1.0',
          scannerVersions: { axeCore: '4.13.0', playwright: '1.62.1', chromium: '140' },
          surfaces: ['cli', 'vite'],
          coverage: { checked: ['clusters'], notCovered: [] },
          applicability: [],
          verdict: 'verified',
          findingsSummary: { new: 0, carried: 0, fixed: 2, unverified: 0 },
          activeWaivers: 0,
          mintedAt: '2026-08-27T00:00:00.000Z',
        },
        dirtyGuardedPaths: [],
      }),
    );
    const approvalOverlay = projectOverlay(
      baseResult({
        verdict: 'approval_required',
        exitCode: 2,
        findings: [],
        receipt: null,
        dirtyGuardedPaths: ['usabl.config.json'],
      }),
    );

    expect(overlay.exitCode).toBe(1);
    expect(overlay.coverage).toEqual({
      affected: [
        {
          screenId: 'clusters',
          url: 'http://127.0.0.1:5173/clusters',
          provenance: 'route-graph',
          importChain: ['src/pages/Clusters.tsx', 'src/components/DemoModal.tsx'],
        },
      ],
      unresolvedFiles: ['src/pages/Unknown.tsx'],
      gaps: [{ ref: 'clusters', state: 'not-covered', reason: 'browser unavailable' }],
      // Carried so the overlay can tell a run that had nothing to check apart from a run that
      // ended without a verdict. Those look identical without it, and one of them is a pass.
      nothingToCheck: false,
    });
    expect(overlay.findings[0]).toEqual(
      expect.objectContaining({
        rule: 'pf-focus-into-dialog',
        screenId: 'clusters',
        layer: 'pf',
        severity: 'serious',
        evidenceClass: 'deterministic',
        status: 'new',
        confidence: 'fail',
        identityBasis: 'name',
      }),
    );
    expect(verifiedOverlay.receipt).toEqual(
      expect.objectContaining({
        sourceTree: 'abcdef1234567890',
        policyHash: 'policy123',
        runnerVersion: '0.1.0',
        checkedScreens: ['clusters'],
        activeWaivers: 0,
      }),
    );
    expect(approvalOverlay.dirtyGuardedPaths).toEqual(['usabl.config.json']);
    expect(overlay.advisory).toBe(true);
    expect(overlay.displayExitCode).toBe(0);
    expect(overlay.findingsTotalCount).toBe(1);
  });

  it('lists every overlay finding and reports a total that matches the list', () => {
    // The overlay list is flat so that each finding can be located on the page by itself. There is
    // no collapsing, so the projection carries no "showing N of M" flag that would describe one.
    const findings = Array.from({ length: 6 }, (_, index) => ({
      rule: `rule-${index}`,
      layer: 'axe',
      severity: 'serious' as const,
      evidenceClass: 'deterministic' as const,
      screenId: 'clusters',
      elementPath: `button-${index}`,
      elementName: 'Save',
      role: 'button',
      whatUserExperiences: `problem ${index}`,
      why: 'because',
      fix: 'fix it',
      evidence: {},
      confidence: 'fail' as const,
      elementKey: `k-${index}`,
      identityBasis: 'name' as const,
      status: 'new' as const,
    }));
    const overlay = projectOverlay(baseResult({ findings }));

    expect(overlay.findings).toHaveLength(6);
    // The reported total is the length of the list the reader can actually see.
    expect(overlay.findingsTotalCount).toBe(overlay.findings.length);
    expect(overlay.findingsTotalCount).toBe(6);
    expect(Object.keys(overlay)).not.toContain('noiseBudgetCollapsed');
    expect(Object.keys(overlay)).not.toContain('showAllHint');
  });

  it('frames page-derived finding text before browser egress', () => {
    const overlay = projectOverlay(
      baseResult({
        findings: [
          {
            rule: 'button-name',
            layer: 'axe',
            severity: 'serious',
            evidenceClass: 'deterministic',
            screenId: 'clusters',
            elementPath: '#token=SECRETPOISON',
            elementName: 'token=SECRETPOISON',
            role: 'button',
            whatUserExperiences: 'token=SECRETPOISON has no accessible name',
            why: 'A button needs an accessible name.',
            fix: 'Add an accessible name.',
            evidence: {},
            confidence: 'fail',
            elementKey: 'clusters|button-name|name:token=SECRETPOISON',
            identityBasis: 'name',
            status: 'new',
          },
        ],
      }),
    );
    const finding = overlay.findings[0];

    expect(finding?.elementPath).toContain('[BEGIN UNTRUSTED PAGE TEXT');
    expect(finding?.elementName).toContain('[BEGIN UNTRUSTED PAGE TEXT');
    expect(finding?.role).toContain('[BEGIN UNTRUSTED PAGE TEXT');
    expect(finding?.elementKey).toContain('[BEGIN UNTRUSTED PAGE TEXT');
    expect(finding?.whatUserExperiences).toContain('[BEGIN UNTRUSTED PAGE TEXT');
    expect(JSON.stringify(finding)).not.toContain('SECRETPOISON');
  });
});

describe('makeResultCache', () => {
  it('coalesces concurrent reads into one execution', async () => {
    let calls = 0;
    const cache = makeResultCache(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'result-value';
    });

    const [a, b, c] = await Promise.all([cache.read(), cache.read(), cache.read()]);

    expect(calls).toBe(1);
    expect([a, b, c]).toEqual(['result-value', 'result-value', 'result-value']);
  });

  it('serves the completed result on later reads without running again', async () => {
    let calls = 0;
    const cache = makeResultCache(async () => {
      calls += 1;
      return calls;
    });

    await cache.read();
    const second = await cache.read();
    const third = await cache.read();

    expect(calls).toBe(1);
    expect(second).toBe(1);
    expect(third).toBe(1);
  });

  it('runs again after invalidate', async () => {
    let calls = 0;
    const cache = makeResultCache(async () => {
      calls += 1;
      return calls;
    });

    await cache.read();
    cache.invalidate();
    const second = await cache.read();

    expect(calls).toBe(2);
    expect(second).toBe(2);
  });

  it('does not cache a rejection, so the next read retries', async () => {
    let calls = 0;
    const cache = makeResultCache(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('engine failed');
      }
      return calls;
    });

    await expect(cache.read()).rejects.toThrow('engine failed');
    const second = await cache.read();

    expect(calls).toBe(2);
    expect(second).toBe(2);
  });

  it('runs again on a fresh read but joins a run already in flight', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const cache = makeResultCache(async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return calls;
    });

    // The run starts one tick after read() is called, so wait for it before releasing it.
    const started = () => new Promise((resolve) => setTimeout(resolve, 0));

    const first = cache.read();
    await started();
    release();
    expect(await first).toBe(1);

    // fresh skips the cache and starts a new run.
    const fresh = cache.read({ fresh: true });
    // A second fresh read while that run is in flight joins it instead of starting a third.
    const joined = cache.read({ fresh: true });
    await started();
    release();
    expect(await fresh).toBe(2);
    expect(await joined).toBe(2);
    expect(calls).toBe(2);

    // The fresh result replaced the cache.
    expect(await cache.read()).toBe(2);
    expect(calls).toBe(2);
  });

  it('holds a run until the wave settles and lets every read in the wave join it', async () => {
    // Reads that arrive while an invalidation wave is open do not start runs. They wait for the wave
    // to close and share the one run that starts then, which reads the final generation.
    let calls = 0;
    let settle: () => void = () => {};
    let open = true;
    const wave = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const cache = makeResultCache(
      async () => {
        calls += 1;
        return calls;
      },
      { settled: () => (open ? wave : Promise.resolve()) },
    );

    cache.invalidate();
    const a = cache.read();
    cache.invalidate();
    const b = cache.read({ fresh: true });
    cache.invalidate();
    const c = cache.read();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(0);

    open = false;
    settle();
    expect(await Promise.all([a, b, c])).toEqual([1, 1, 1]);
    expect(calls).toBe(1);
    // The run read the generation current when it started, so it is the cache.
    expect(await cache.read()).toBe(1);
    expect(calls).toBe(1);
  });

  it('does not cache or join a run that was in flight when invalidated', async () => {
    // The run measured the tree before the change that invalidated it. A reader after the change
    // must get a run that saw the change, and the stale run's result must not become the cache.
    let calls = 0;
    const releases: Array<() => void> = [];
    const cache = makeResultCache(async () => {
      calls += 1;
      const mine = calls;
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      return mine;
    });

    const stale = cache.read();
    // The run starts one tick after read(). It has to be under way for it to count as in flight;
    // a run that has not started yet reads the generation current when it starts and may be joined.
    await new Promise((resolve) => setTimeout(resolve, 0));
    cache.invalidate();
    const afterChange = cache.read();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);

    for (const release of releases) {
      release();
    }
    expect(await stale).toBe(1);
    expect(await afterChange).toBe(2);
    // The cache holds the run that saw the change.
    expect(await cache.read()).toBe(2);
    expect(calls).toBe(2);
  });
});

describe('usablVitePlugin', () => {
  it('injects a guarded overlay loader into HTML', async () => {
    const plugin = usablVitePlugin({ run: async () => baseResult({}) });
    const html = '<html><body><main>app</main></body></html>';

    const transformed = await plugin.transformIndexHtml?.(html);

    expect(transformed).toContain('/__usabl/client.js');
    expect(transformed).toContain('navigator.webdriver');
    expect(transformed).toContain('usabl');
  });

  it('ships client source that fetches result JSON and uses textContent', () => {
    expect(overlayClientSource).toContain('/__usabl/result');
    expect(overlayClientSource).toContain('textContent');
  });

  it('registers middleware handlers for client and result endpoints', async () => {
    let runCount = 0;
    const plugin = usablVitePlugin({
      run: async () => {
        runCount += 1;
        return baseResult({
          verdict: 'regression',
          exitCode: 1,
          findings: [],
          summary: `regression run ${runCount}`,
        });
      },
    });
    const middlewares: Array<
      (
        req: { method?: string; url?: string; headers?: Record<string, string | string[] | undefined> },
        res: FakeResponse,
        next: () => void,
      ) => void | Promise<void>
    > = [];
    const watcherHandlers = new Map<string, Array<() => void>>();
    const sentEvents: Array<{ type: string; event: string }> = [];

    plugin.configureServer?.({
      middlewares: {
        use(handler) {
          middlewares.push(handler);
        },
      },
      ws: {
        send(payload) {
          sentEvents.push(payload);
        },
      },
      watcher: {
        on(event, handler) {
          const list = watcherHandlers.get(event) ?? [];
          list.push(handler);
          watcherHandlers.set(event, list);
        },
      },
    });

    const middleware = middlewares[0];
    expect(middleware).toBeDefined();
    if (middleware === undefined) {
      throw new Error('expected middleware registration');
    }

    const clientResponse = await callMiddleware(middleware, '/__usabl/client.js');
    expect(clientResponse.headers['content-type']).toContain('application/javascript');
    expect(clientResponse.body).toContain('/__usabl/result');
    expect(clientResponse.body).toContain('createHotContext');
    expect(clientResponse.body).toContain("import.meta.hot = __vite__createHotContext('/__usabl/client.js')");

    const resultResponse = await callMiddleware(middleware, '/__usabl/result');
    expect(resultResponse.headers['content-type']).toContain('application/json');
    expect(JSON.parse(resultResponse.body)).toEqual(
      expect.objectContaining({
        advisory: true,
        displayExitCode: 0,
        verdict: 'regression',
      }),
    );
    expect(runCount).toBe(1);

    const changeHandlers = watcherHandlers.get('change') ?? [];
    expect(changeHandlers.length).toBeGreaterThan(0);
    for (const handler of changeHandlers) {
      handler();
    }
    await new Promise((resolve) => setTimeout(resolve, 120));

    const secondResult = await callMiddleware(middleware, '/__usabl/result');
    expect(JSON.parse(secondResult.body).summary).toContain('run 2');
    expect(runCount).toBe(2);
    expect(sentEvents).toContainEqual({ type: 'custom', event: 'usabl:refresh' });
  });

  it('serves the cached result on repeated fetches without re-running the engine', async () => {
    let runCount = 0;
    const plugin = usablVitePlugin({
      run: async () => {
        runCount += 1;
        return baseResult({ verdict: 'regression', exitCode: 1, summary: `run ${runCount}` });
      },
    });
    const middleware = getMiddleware(plugin);

    const first = await callMiddleware(middleware, '/__usabl/result');
    expect(JSON.parse(first.body).summary).toBe('run 1');
    // Every later read, for example a panel open or a re-render, is served from the cache.
    for (let read = 0; read < 5; read += 1) {
      const again = await callMiddleware(middleware, '/__usabl/result');
      expect(JSON.parse(again.body).summary).toBe('run 1');
    }
    expect(runCount).toBe(1);
  });

  it('re-runs the engine after the watcher invalidates the cache', async () => {
    let runCount = 0;
    const plugin = usablVitePlugin({
      run: async () => {
        runCount += 1;
        return baseResult({ summary: `run ${runCount}` });
      },
    });
    const watcherHandlers = new Map<string, Array<() => void>>();
    const middlewares: Array<
      (
        req: { method?: string; url?: string; headers?: Record<string, string | string[] | undefined> },
        res: FakeResponse,
        next: () => void,
      ) => void | Promise<void>
    > = [];
    plugin.configureServer?.({
      middlewares: {
        use(handler) {
          middlewares.push(handler);
        },
      },
      ws: { send() {} },
      watcher: {
        on(event, handler) {
          const list = watcherHandlers.get(event) ?? [];
          list.push(handler);
          watcherHandlers.set(event, list);
        },
      },
    });
    const middleware = middlewares[0];
    if (middleware === undefined) {
      throw new Error('expected middleware registration');
    }

    await callMiddleware(middleware, '/__usabl/result');
    await callMiddleware(middleware, '/__usabl/result');
    expect(runCount).toBe(1);

    for (const event of ['change', 'add', 'unlink']) {
      for (const handler of watcherHandlers.get(event) ?? []) {
        handler();
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
      const after = await callMiddleware(middleware, '/__usabl/result');
      expect(JSON.parse(after.body).summary).toBe(`run ${runCount}`);
    }
    // One re-run per invalidation, three invalidations.
    expect(runCount).toBe(4);
  });

  it('does not cache a failed run, so the next fetch retries', async () => {
    let runCount = 0;
    const plugin = usablVitePlugin({
      run: async () => {
        runCount += 1;
        if (runCount === 1) {
          throw new Error('engine failed');
        }
        return baseResult({ summary: `run ${runCount}` });
      },
    });
    const middleware = getMiddleware(plugin);

    await expect(
      middleware(
        { method: 'GET', url: '/__usabl/result', headers: { host: 'localhost:5173' } },
        makeResponse(),
        () => {},
      ),
    ).rejects.toThrow('engine failed');

    const retried = await callMiddleware(middleware, '/__usabl/result');
    expect(JSON.parse(retried.body).summary).toBe('run 2');
    expect(runCount).toBe(2);

    // And the retry's success is cached.
    await callMiddleware(middleware, '/__usabl/result');
    expect(runCount).toBe(2);
  });

  it('shares one execution between concurrent fetches during a run', async () => {
    let runCount = 0;
    const plugin = usablVitePlugin({
      run: async () => {
        runCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return baseResult({ summary: `run ${runCount}` });
      },
    });
    const middleware = getMiddleware(plugin);

    const responses = await Promise.all([
      callMiddleware(middleware, '/__usabl/result'),
      callMiddleware(middleware, '/__usabl/result'),
      callMiddleware(middleware, '/__usabl/result'),
    ]);
    expect(runCount).toBe(1);
    for (const response of responses) {
      expect(JSON.parse(response.body).summary).toBe('run 1');
    }
  });

  it('re-runs the engine for a fresh fetch and serves that result afterwards', async () => {
    // fresh=1 is the panel's "Check again". It must produce a real run even with a cached result,
    // and the new result becomes the one later plain reads see.
    let runCount = 0;
    const plugin = usablVitePlugin({
      run: async () => {
        runCount += 1;
        return baseResult({ summary: `run ${runCount}` });
      },
    });
    const middleware = getMiddleware(plugin);

    await callMiddleware(middleware, '/__usabl/result');
    const fresh = await callMiddleware(middleware, '/__usabl/result?fresh=1');
    expect(JSON.parse(fresh.body).summary).toBe('run 2');
    const plain = await callMiddleware(middleware, '/__usabl/result');
    expect(JSON.parse(plain.body).summary).toBe('run 2');
    expect(runCount).toBe(2);
  });

  it('drops the cached result the instant the watcher fires, before any timer', async () => {
    // The notification to the browser is debounced. The cache must not be. A read that lands between
    // the file event and the debounce timer used to get the result of the tree before the change,
    // and a fresh read in that window started a second engine run for one save.
    let runCount = 0;
    const plugin = usablVitePlugin({
      run: async () => {
        runCount += 1;
        return baseResult({ summary: `run ${runCount}` });
      },
    });
    const watcherHandlers = new Map<string, Array<() => void>>();
    const sentEvents: Array<{ type: string; event: string }> = [];
    const middlewares: Array<
      (
        req: { method?: string; url?: string; headers?: Record<string, string | string[] | undefined> },
        res: FakeResponse,
        next: () => void,
      ) => void | Promise<void>
    > = [];
    plugin.configureServer?.({
      middlewares: {
        use(handler) {
          middlewares.push(handler);
        },
      },
      ws: {
        send(payload) {
          sentEvents.push(payload);
        },
      },
      watcher: {
        on(event, handler) {
          const list = watcherHandlers.get(event) ?? [];
          list.push(handler);
          watcherHandlers.set(event, list);
        },
      },
    });
    const middleware = middlewares[0];
    if (middleware === undefined) {
      throw new Error('expected middleware registration');
    }

    await callMiddleware(middleware, '/__usabl/result');
    expect(runCount).toBe(1);

    // One wave per event. The read in the window after the event, plain or fresh, sees a new run,
    // and the read the browser makes after the debounced notification sees that same run rather
    // than a second one. Before the fix the window read got the old result and the fresh read plus
    // the post-notification read cost two runs for one save.
    for (const [event, path] of [
      ['change', '/__usabl/result'],
      ['add', '/__usabl/result?fresh=1'],
      ['unlink', '/__usabl/result'],
    ] as const) {
      const before = runCount;
      const notified = sentEvents.length;
      for (const handler of watcherHandlers.get(event) ?? []) {
        handler();
      }
      // No timer has fired yet: the notification is still pending.
      expect(sentEvents.length).toBe(notified);
      const inWindow = await callMiddleware(middleware, path);
      expect(JSON.parse(inWindow.body).summary).toBe(`run ${before + 1}`);
      expect(runCount).toBe(before + 1);

      // The debounce settles and the browser is told. Its read must not start another run.
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(sentEvents.length).toBe(notified + 1);
      const afterNotification = await callMiddleware(middleware, '/__usabl/result');
      expect(JSON.parse(afterNotification.body).summary).toBe(`run ${before + 1}`);
      expect(runCount).toBe(before + 1);
    }
  });

  it('runs the engine once for a burst of interleaved watcher events and reads', async () => {
    // change, add, and unlink land a few milliseconds apart with reads, one of them fresh, between
    // them. That is one save as the file system reports it. It must cost one engine run, every
    // reader in the burst must receive that run, and one notification goes out when it settles.
    let runCount = 0;
    const plugin = usablVitePlugin({
      run: async () => {
        runCount += 1;
        return baseResult({ summary: `run ${runCount}` });
      },
    });
    const watcherHandlers = new Map<string, Array<() => void>>();
    const sentEvents: Array<{ type: string; event: string }> = [];
    const middlewares: Array<
      (
        req: { method?: string; url?: string; headers?: Record<string, string | string[] | undefined> },
        res: FakeResponse,
        next: () => void,
      ) => void | Promise<void>
    > = [];
    plugin.configureServer?.({
      middlewares: {
        use(handler) {
          middlewares.push(handler);
        },
      },
      ws: {
        send(payload) {
          sentEvents.push(payload);
        },
      },
      watcher: {
        on(event, handler) {
          const list = watcherHandlers.get(event) ?? [];
          list.push(handler);
          watcherHandlers.set(event, list);
        },
      },
    });
    const middleware = middlewares[0];
    if (middleware === undefined) {
      throw new Error('expected middleware registration');
    }
    const fire = (event: string): void => {
      for (const handler of watcherHandlers.get(event) ?? []) {
        handler();
      }
    };
    const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    await callMiddleware(middleware, '/__usabl/result');
    expect(runCount).toBe(1);

    fire('change');
    const afterChange = callMiddleware(middleware, '/__usabl/result');
    await pause(20);
    fire('add');
    const afterAdd = callMiddleware(middleware, '/__usabl/result?fresh=1');
    await pause(20);
    fire('unlink');
    const afterUnlink = callMiddleware(middleware, '/__usabl/result');
    await pause(20);
    // The wave is still open: nothing has run and nothing has been announced.
    expect(runCount).toBe(1);
    expect(sentEvents.length).toBe(0);

    const responses = await Promise.all([afterChange, afterAdd, afterUnlink]);
    expect(runCount).toBe(2);
    expect(responses.map((response) => JSON.parse(response.body).summary)).toEqual(['run 2', 'run 2', 'run 2']);
    expect(sentEvents).toEqual([{ type: 'custom', event: 'usabl:refresh' }]);

    // The browser's read after the notification is that same run.
    const afterNotification = await callMiddleware(middleware, '/__usabl/result');
    expect(JSON.parse(afterNotification.body).summary).toBe('run 2');
    expect(runCount).toBe(2);
  });

  it('accepts a configured IPv6 host and refuses an Origin that is not a bare origin', async () => {
    const plugin = usablVitePlugin({ run: async () => baseResult({}) });
    // Vite carries an IPv6 bind address without brackets. The Host header carries it bracketed.
    plugin.configResolved?.({ command: 'serve', server: { host: 'fd00::1', port: 4000 } });
    const middleware = getMiddleware(plugin);
    const status = async (headers: Record<string, string>): Promise<number> => {
      const response = makeResponse();
      await middleware({ method: 'GET', url: '/__usabl/result', headers }, response, () => {});
      return response.statusCode;
    };

    expect(await status({ host: '[fd00::1]:4000' })).toBe(200);
    expect(await status({ host: '[fd00::1]:4000', origin: 'http://[fd00::1]:4000' })).toBe(200);
    expect(await status({ host: 'localhost:4000', origin: 'http://[fd00::1]:4000' })).toBe(200);

    // A browser writes Origin as scheme://host[:port] and nothing else. Anything more was not
    // written by a browser's Origin logic.
    expect(await status({ host: 'localhost:4000', origin: 'http://localhost:4000/' })).toBe(403);
    expect(await status({ host: 'localhost:4000', origin: 'http://localhost:4000/path' })).toBe(403);
    expect(await status({ host: 'localhost:4000', origin: 'http://localhost:4000?q=1' })).toBe(403);
    expect(await status({ host: 'localhost:4000', origin: 'http://localhost:4000#frag' })).toBe(403);
    expect(await status({ host: 'localhost:4000', origin: 'HTTP://LOCALHOST:4000' })).toBe(403);
    expect(await status({ host: 'localhost:4000', origin: 'http://localhost:4000' })).toBe(200);
  });

  it('rejects the result and client endpoints when the Host header is not local', async () => {
    // These handlers run before Vite validates the Host header and they end the response, so a DNS
    // rebinding request that reaches them would otherwise read back the workspace root, source paths,
    // import chains, guarded paths, and findings. A non-local Host is refused with 403.
    const plugin = usablVitePlugin({ run: async () => baseResult({ verdict: 'regression', exitCode: 1 }) });
    const middleware = getMiddleware(plugin);

    for (const path of ['/__usabl/result', '/__usabl/client.js']) {
      const response = makeResponse();
      let nextCalled = false;
      await middleware(
        { method: 'GET', url: path, headers: { host: 'attacker.example.com' } },
        response,
        () => {
          nextCalled = true;
        },
      );
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain('regression');
      expect(response.body).not.toContain('advisory');
      expect(nextCalled).toBe(false);
    }
  });

  it('rejects the result endpoint when the Origin header is cross-origin', async () => {
    const plugin = usablVitePlugin({ run: async () => baseResult({ verdict: 'regression', exitCode: 1 }) });
    const middleware = getMiddleware(plugin);

    const response = makeResponse();
    await middleware(
      {
        method: 'GET',
        url: '/__usabl/result',
        // The Host is local, but the Origin is not. A cross-origin fetch from a hostile page is what
        // this guards.
        headers: { host: 'localhost:5173', origin: 'https://attacker.example.com' },
      },
      response,
      () => {},
    );
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('regression');
  });

  it('rejects a request with no Host header', async () => {
    const plugin = usablVitePlugin({ run: async () => baseResult({}) });
    const middleware = getMiddleware(plugin);
    const response = makeResponse();
    await middleware({ method: 'GET', url: '/__usabl/result', headers: {} }, response, () => {});
    expect(response.statusCode).toBe(403);
  });

  it('allows local hosts and a same-origin request', async () => {
    const plugin = usablVitePlugin({ run: async () => baseResult({ verdict: 'regression', exitCode: 1 }) });
    const middleware = getMiddleware(plugin);

    for (const host of ['localhost:5173', '127.0.0.1:5173', '[::1]:5173']) {
      const response = await callMiddleware(middleware, '/__usabl/result', { host });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).verdict).toBe('regression');
    }

    // A same-origin request carries a matching local Origin and is allowed.
    const sameOrigin = await callMiddleware(middleware, '/__usabl/result', {
      host: 'localhost:5173',
      origin: 'http://localhost:5173',
    });
    expect(sameOrigin.statusCode).toBe(200);
  });

  it('requires an exact origin match and one Host header on this server port', async () => {
    const plugin = usablVitePlugin({ run: async () => baseResult({ verdict: 'regression', exitCode: 1 }) });
    const middleware = getMiddleware(plugin);
    const status = async (headers: Record<string, string>, rawHeaders?: string[]): Promise<number> => {
      const response = makeResponse();
      await middleware(
        { method: 'GET', url: '/__usabl/result', headers, ...(rawHeaders ? { rawHeaders } : {}) },
        response,
        () => {},
      );
      return response.statusCode;
    };

    // Served on http://localhost:5173, the Vite default when nothing else names a port.
    // "null" is not an origin the page can be trusted from.
    expect(await status({ host: 'localhost:5173', origin: 'null' })).toBe(403);
    // Host on another port than the one this server listens on.
    expect(await status({ host: 'localhost:9999' })).toBe(403);
    expect(await status({ host: 'localhost' })).toBe(403);
    // A local Origin that is not the origin this request's Host names.
    expect(await status({ host: 'localhost:5173', origin: 'http://127.0.0.1:5173' })).toBe(403);
    // Right host, wrong scheme.
    expect(await status({ host: 'localhost:5173', origin: 'https://localhost:5173' })).toBe(403);
    // Right host, wrong effective port (80).
    expect(await status({ host: 'localhost:5173', origin: 'http://localhost' })).toBe(403);
    // Two Host headers are refused in either order. The folded value is whichever one the runtime
    // kept, so it cannot be trusted.
    expect(
      await status({ host: 'localhost:5173' }, ['Host', 'localhost:5173', 'Host', 'attacker.example.com']),
    ).toBe(403);
    expect(
      await status({ host: 'localhost:5173' }, ['Host', 'attacker.example.com', 'Host', 'localhost:5173']),
    ).toBe(403);
    expect(await status({ host: 'localhost:5173' }, ['host', 'localhost:5173', 'HOST', 'localhost:5173'])).toBe(
      403,
    );

    // The exact origin, and a single Host in rawHeaders, are still allowed.
    expect(await status({ host: 'localhost:5173', origin: 'http://localhost:5173' })).toBe(200);
    expect(await status({ host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' })).toBe(200);
    expect(await status({ host: '[::1]:5173', origin: 'http://[::1]:5173' })).toBe(200);
    expect(await status({ host: 'localhost:5173' }, ['Host', 'localhost:5173', 'Accept', '*/*'])).toBe(200);
  });

  it('checks the origin against the port the server really listens on and its scheme', () => {
    // The live listener can sit on a different port than the config asked for. The origin is judged
    // against the real one. Under https the effective port of a bare origin is 443, not 80.
    const server = { scheme: 'http' as const, port: 5174, configuredHost: null };
    expect(isRequestFromDevOrigin({ headers: { host: 'localhost:5174' } }, server)).toBe(true);
    expect(isRequestFromDevOrigin({ headers: { host: 'localhost:5173' } }, server)).toBe(false);
    expect(
      isRequestFromDevOrigin({ headers: { host: 'localhost:5174', origin: 'http://localhost:5174' } }, server),
    ).toBe(true);

    const secure = { scheme: 'https' as const, port: 443, configuredHost: 'dev.internal' };
    expect(
      isRequestFromDevOrigin({ headers: { host: 'dev.internal', origin: 'https://dev.internal' } }, secure),
    ).toBe(true);
    expect(
      isRequestFromDevOrigin({ headers: { host: 'dev.internal', origin: 'http://dev.internal' } }, secure),
    ).toBe(false);
    // The configured dev origin is accepted as the Origin of a request whose Host is another local
    // name on the same server.
    expect(
      isRequestFromDevOrigin({ headers: { host: 'localhost', origin: 'https://dev.internal' } }, secure),
    ).toBe(true);
    expect(isRequestFromDevOrigin({ headers: { host: 'other.internal' } }, secure)).toBe(false);
  });

  it('reads the listening port from the http server when it differs from the config', async () => {
    const plugin = usablVitePlugin({ run: async () => baseResult({}) });
    plugin.configResolved?.({ command: 'serve', server: { port: 5173 } });
    const middlewares: Array<
      (
        req: { method?: string; url?: string; headers?: Record<string, string | string[] | undefined> },
        res: FakeResponse,
        next: () => void,
      ) => void | Promise<void>
    > = [];
    plugin.configureServer?.({
      middlewares: {
        use(handler) {
          middlewares.push(handler);
        },
      },
      ws: { send() {} },
      // The configured port was taken, so the server listens on the next one.
      httpServer: { on() {}, address: () => ({ address: '127.0.0.1', family: 'IPv4', port: 5174 }) },
    });
    const middleware = middlewares[0];
    if (middleware === undefined) {
      throw new Error('expected middleware registration');
    }
    const live = await callMiddleware(middleware, '/__usabl/result', { host: 'localhost:5174' });
    expect(live.statusCode).toBe(200);
    const stale = makeResponse();
    await middleware({ method: 'GET', url: '/__usabl/result', headers: { host: 'localhost:5173' } }, stale, () => {});
    expect(stale.statusCode).toBe(403);
  });

  it('allows the dev server configured host', async () => {
    const plugin = usablVitePlugin({ run: async () => baseResult({ verdict: 'verified', exitCode: 0 }) });
    // The dev server was told to bind to a specific host and port.
    plugin.configResolved?.({ command: 'serve', server: { host: 'dev.internal', port: 4000 } });
    const middleware = getMiddleware(plugin);

    const allowed = await callMiddleware(middleware, '/__usabl/result', { host: 'dev.internal:4000' });
    expect(allowed.statusCode).toBe(200);

    // A host that was not configured and is not a standard local name is still refused.
    const refused = await callMiddleware(middleware, '/__usabl/result', { host: 'other.internal:4000' });
    expect(refused.statusCode).toBe(403);
  });

  it('runs before the host JSX transform so it sees raw tags', () => {
    // Without enforce 'pre' the host's JSX plugin (for example @vitejs/plugin-react) rewrites
    // "<button>" into jsx() calls first, and the source injector finds no tags to annotate. This
    // pins the ordering so jump-to-source keeps resolving to a line.
    const plugin = usablVitePlugin({ run: async () => baseResult({ findings: [] }) });
    expect(plugin.enforce).toBe('pre');
  });

  it('injects source only in serve, on host source, on raw JSX tags', () => {
    const plugin = usablVitePlugin({
      workspaceRoot: '/repo',
      run: async () => baseResult({ findings: [] }),
    });
    const raw = 'export const A = () => <button type="submit">Go</button>;\n';

    // Before configResolved, and in build, the injector stays off.
    expect(plugin.transform?.(raw, '/repo/src/A.tsx')).toBeNull();
    plugin.configResolved?.({ command: 'build' });
    expect(plugin.transform?.(raw, '/repo/src/A.tsx')).toBeNull();

    // In serve it injects file and line on a native element in host source.
    plugin.configResolved?.({ command: 'serve' });
    const injected = plugin.transform?.(raw, '/repo/src/A.tsx');
    expect(injected?.code).toContain('data-source-file="src/A.tsx"');
    expect(injected?.code).toContain('data-source-line="1"');

    // Dependencies under node_modules are never annotated.
    expect(plugin.transform?.(raw, '/repo/node_modules/pkg/A.tsx')).toBeNull();
  });
});

describe('usablVitePluginFromConfig', () => {
  it('injects the same guarded loader as the base plugin', async () => {
    const plugin = usablVitePluginFromConfig({ cwd: '/repo/app' }, makeFactoryPorts({}));
    const html = '<html><body><main>app</main></body></html>';

    const transformed = await plugin.transformIndexHtml?.(html);

    expect(transformed).toContain('/__usabl/client.js');
    expect(transformed).toContain('navigator.webdriver');
    expect(transformed).toContain("search.get('usabl') !== 'off'");
  });

  it('loads config, builds deps, and runs engine for one overlay request without closing the browser', async () => {
    const config = makeConfig();
    const deps = makeDeps();
    const engineResult = baseResult({
      verdict: 'regression',
      summary: 'regression from gate',
      exitCode: 1,
    });
    const calls: string[] = [];
    let loadConfigPath = '';
    let buildDepsConfig: UsablConfig | null = null;
    let buildDepsCwd = '';
    let buildDepsBrowserFor: ((options: RealBrowserOptions) => Deps['browser']) | undefined;
    let runEngineDeps: Deps | null = null;
    let runEngineConfig: UsablConfig | null = null;
    // The browser process the factory keeps across refreshes. It is made once, and every buildDeps
    // call gets a factory that draws a per-run driver from it. A run must not close it.
    const warm = fakeSharedBrowser({ onClose: () => calls.push('close') });
    let makeBrowserCalls = 0;

    const plugin = usablVitePluginFromConfig(
      { cwd: '/repo/app' },
      makeFactoryPorts({
        loadConfig: async (path) => {
          loadConfigPath = path;
          calls.push('loadConfig');
          return config;
        },
        makeBrowser: () => {
          makeBrowserCalls += 1;
          return warm.shared;
        },
        buildDeps: async (resolvedConfig, options) => {
          buildDepsConfig = resolvedConfig;
          buildDepsCwd = options.cwd;
          buildDepsBrowserFor = options.browserFor;
          calls.push('buildDeps');
          return deps;
        },
        runEngine: async (runDeps, runConfig) => {
          runEngineDeps = runDeps;
          runEngineConfig = runConfig;
          calls.push('runEngine');
          return engineResult;
        },
      }),
    );
    const middleware = getMiddleware(plugin);

    const response = await callMiddleware(middleware, '/__usabl/result');

    expect(loadConfigPath).toBe(resolve('/repo/app', 'usabl.config.json'));
    expect(buildDepsConfig).toBe(config);
    expect(buildDepsCwd).toBe('/repo/app');
    // The browser process was made once and buildDeps got a factory that draws from it, passing the
    // run's own options through.
    expect(makeBrowserCalls).toBe(1);
    expect(buildDepsBrowserFor).toBeDefined();
    buildDepsBrowserFor?.({ readyTimeoutMs: 1234, storageStatePath: '/tmp/session.json' });
    expect(warm.driverOptions).toEqual([{ readyTimeoutMs: 1234, storageStatePath: '/tmp/session.json' }]);
    expect(runEngineDeps).toBe(deps);
    expect(runEngineConfig).toBe(config);
    // No close during a run. The process stays alive for the next refresh.
    expect(warm.closeCalls()).toBe(0);
    expect(calls).toEqual(['loadConfig', 'buildDeps', 'runEngine']);
    expect(JSON.parse(response.body)).toEqual(projectOverlay(engineResult, '/repo/app'));

    // A second refresh reuses the same process and still never makes a new one.
    await callMiddleware(middleware, '/__usabl/result');
    expect(makeBrowserCalls).toBe(1);
    expect(warm.closeCalls()).toBe(0);

    // Shutdown closes the process exactly once.
    await plugin.closeBundle?.();
    expect(warm.closeCalls()).toBe(1);
    // A second shutdown is a no-op.
    await plugin.closeBundle?.();
    expect(warm.closeCalls()).toBe(1);
  });

  it('hands each run its own storage state and ready timeout through the shared browser', async () => {
    // The real buildDeps resolves the authenticated session from the environment and the readiness
    // budget from the config. Both must reach the driver the shared process hands out for THAT run.
    // A process that took them once at launch would scan signed out after the operator exported a
    // session, and would keep the first run's budget after the config changed.
    const sessionDir = await mkdtemp(join(tmpdir(), 'usabl-session-'));
    const sessionPath = join(sessionDir, 'state.json');
    await writeFile(sessionPath, JSON.stringify({ cookies: [], origins: [] }), 'utf8');
    const previousEnv = process.env.USABL_STORAGE_STATE;
    process.env.USABL_STORAGE_STATE = sessionPath;
    try {
      const warm = fakeSharedBrowser({});
      let readyTimeoutMs = 1234;
      const plugin = usablVitePluginFromConfig(
        { cwd: process.cwd() },
        {
          loadConfig: async () => testConfig({ readyTimeoutMs }),
          makeBrowser: () => warm.shared,
          runEngine: async () => baseResult({}),
        },
      );
      const middleware = getMiddleware(plugin);

      await callMiddleware(middleware, '/__usabl/result');
      expect(warm.driverOptions).toEqual([{ storageStatePath: sessionPath, readyTimeoutMs: 1234 }]);

      // The config changed between saves. The next run must read the new budget, and the session
      // must still reach it.
      readyTimeoutMs = 5678;
      await callMiddleware(middleware, '/__usabl/result?fresh=1');
      expect(warm.driverOptions).toEqual([
        { storageStatePath: sessionPath, readyTimeoutMs: 1234 },
        { storageStatePath: sessionPath, readyTimeoutMs: 5678 },
      ]);
      // And the session reaches the context the process opens, not only the driver.
      const view = warm.shared.driver(warm.driverOptions[1]);
      await expect(view.open('http://127.0.0.1:1/never')).rejects.toThrow('fake open');
      expect(warm.contextOptions).toEqual([{ storageState: sessionPath }]);

      await plugin.closeBundle?.();
      expect(warm.closeCalls()).toBe(1);
    } finally {
      if (previousEnv === undefined) {
        delete process.env.USABL_STORAGE_STATE;
      } else {
        process.env.USABL_STORAGE_STATE = previousEnv;
      }
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('keeps the warm browser alive when runEngine throws', async () => {
    // A run that throws must not tear down the shared browser, or the next save would pay a cold
    // launch again. The browser is closed only at shutdown.
    const warm = fakeSharedBrowser({});
    const closeCalls = () => warm.closeCalls();
    const plugin = usablVitePluginFromConfig(
      { cwd: '/repo/app' },
      makeFactoryPorts({
        makeBrowser: () => warm.shared,
        buildDeps: async () => makeDeps(),
        runEngine: async () => {
          throw new Error('engine failed');
        },
      }),
    );
    const middleware = getMiddleware(plugin);
    const response = makeResponse();

    await expect(
      middleware(
        { method: 'GET', url: '/__usabl/result', headers: { host: 'localhost:5173' } },
        response,
        () => {
          // middleware should throw before next() on this endpoint
        },
      ),
    ).rejects.toThrow('engine failed');
    // The throw did not close the warm browser.
    expect(closeCalls()).toBe(0);

    // Shutdown still closes it once.
    await plugin.closeBundle?.();
    expect(closeCalls()).toBe(1);
  });

  it('closes the warm browser on dev server close', async () => {
    const warm = fakeSharedBrowser({});
    const closeCalls = () => warm.closeCalls();
    const plugin = usablVitePluginFromConfig(
      { cwd: '/repo/app' },
      makeFactoryPorts({ makeBrowser: () => warm.shared }),
    );

    // Wire a fake http server so the plugin can hook its close event, and drive one request so the
    // warm browser is actually created.
    const closeHandlers: Array<() => void> = [];
    const middlewares: Array<
      (
        req: { method?: string; url?: string; headers?: Record<string, string | string[] | undefined> },
        res: FakeResponse,
        next: () => void,
      ) => void | Promise<void>
    > = [];
    plugin.configureServer?.({
      middlewares: {
        use(handler) {
          middlewares.push(handler);
        },
      },
      ws: { send() {} },
      httpServer: {
        on(_event, handler) {
          closeHandlers.push(handler);
        },
      },
    });
    const middleware = middlewares[0];
    if (middleware === undefined) {
      throw new Error('expected middleware registration');
    }
    await callMiddleware(middleware, '/__usabl/result');

    expect(closeHandlers.length).toBe(1);
    for (const handler of closeHandlers) {
      handler();
    }
    // The close handler runs the teardown asynchronously, so wait a tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeCalls()).toBe(1);
  });

  it('uses process.cwd() and usabl.config.json defaults when opts are omitted', async () => {
    const config = makeConfig();
    let loadPath = '';
    let seenCwd = '';
    const plugin = usablVitePluginFromConfig(
      undefined,
      makeFactoryPorts({
        loadConfig: async (path) => {
          loadPath = path;
          return config;
        },
        buildDeps: async (_config, options) => {
          seenCwd = options.cwd;
          return makeDeps();
        },
      }),
    );
    const middleware = getMiddleware(plugin);

    await callMiddleware(middleware, '/__usabl/result');

    expect(seenCwd).toBe(process.cwd());
    expect(loadPath).toBe(resolve(process.cwd(), 'usabl.config.json'));
  });

  it('resolves custom cwd and configPath', async () => {
    const config = makeConfig();
    let loadPath = '';
    let seenCwd = '';
    const plugin = usablVitePluginFromConfig(
      { cwd: '/tmp/fixture', configPath: 'config/usabl.dev.json' },
      makeFactoryPorts({
        loadConfig: async (path) => {
          loadPath = path;
          return config;
        },
        buildDeps: async (_config, options) => {
          seenCwd = options.cwd;
          return makeDeps();
        },
      }),
    );
    const middleware = getMiddleware(plugin);

    await callMiddleware(middleware, '/__usabl/result');

    expect(seenCwd).toBe('/tmp/fixture');
    expect(loadPath).toBe(resolve('/tmp/fixture', 'config/usabl.dev.json'));
  });
});

interface FakeResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader(name: string, value: string): void;
  end(chunk?: string): void;
}

function makeResponse(): FakeResponse {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk = '') {
      this.body = String(chunk);
    },
  };
}

async function callMiddleware(
  middleware: (
    req: { method?: string; url?: string; headers?: Record<string, string | string[] | undefined> },
    res: FakeResponse,
    next: () => void,
  ) => void | Promise<void>,
  url: string,
  headers: Record<string, string | string[] | undefined> = { host: 'localhost:5173' },
): Promise<FakeResponse> {
  const res = makeResponse();
  let nextCalled = false;
  await middleware({ method: 'GET', url, headers }, res, () => {
    nextCalled = true;
  });
  expect(nextCalled).toBe(false);
  return res;
}

function getMiddleware(
  plugin: ReturnType<typeof usablVitePlugin>,
): (
  req: { method?: string; url?: string; headers?: Record<string, string | string[] | undefined> },
  res: FakeResponse,
  next: () => void,
) => Promise<void> | void {
  const middlewares: Array<
    (
      req: { method?: string; url?: string; headers?: Record<string, string | string[] | undefined> },
      res: FakeResponse,
      next: () => void,
    ) => void | Promise<void>
  > = [];
  plugin.configureServer?.({
    middlewares: {
      use(handler) {
        middlewares.push(handler);
      },
    },
    ws: { send() {} },
  });
  const middleware = middlewares[0];
  expect(middleware).toBeDefined();
  if (middleware === undefined) {
    throw new Error('expected middleware registration');
  }
  return middleware;
}

function makeConfig(): UsablConfig {
  return {
    appBaseUrl: 'http://127.0.0.1:5173',
    uiFileGlobs: ['src/**/*.tsx'],
    discovery: {
      routerFile: 'src/router.tsx',
      wideBlastGlobs: ['src/**/*.tsx'],
    },
    surfaces: [],
    guardedPaths: [],
  };
}

function makeDeps(): Deps {
  return {
    clock: () => new Date().toISOString(),
    runnerVersion: '0.1.0-test',
    scannerVersions: { axeCore: 'test', playwright: 'test', chromium: 'test' },
    browser: {
      open: async () => {
        throw new Error('open not used in this test');
      },
      close: async () => {},
    },
    git: {
      writeTree: async () => 'tree',
      show: async () => null,
      statusZ: async () => [],
      diffNameOnly: async () => [],
      lsTree: async () => ({}),
      lsFiles: async () => [],
      headRef: async () => 'HEAD',
    },
    fs: {
      readFile: async () => null,
      glob: async () => [],
    },
    requirements: { version: 1, requirements: [] },
    checkRunner: {
      scan: async () => ({
        screenId: 'screen',
        url: 'http://127.0.0.1:5173',
        stops: [],
        drafts: [],
        gaps: [],
        applicability: [],
        reachedSelectorPresent: null,
      }),
    },
  };
}

type BuildDepsPort = (
  config: UsablConfig,
  options: { cwd: string; browserFor?: (options: RealBrowserOptions) => Deps['browser'] },
) => Promise<Deps>;

/**
 * A stand-in for the one browser process the overlay keeps. It records the options each run asked a
 * driver for, the options each opened context was given, and how many times it was closed. open
 * always fails, because no test here needs a page, but it fails only after recording the context
 * options so the session's arrival at the context can be asserted.
 */
function fakeSharedBrowser(hooks: { onClose?: () => void }): {
  shared: SharedBrowser;
  driverOptions: RealBrowserOptions[];
  contextOptions: Array<{ storageState?: string }>;
  closeCalls: () => number;
} {
  const driverOptions: RealBrowserOptions[] = [];
  const contextOptions: Array<{ storageState?: string }> = [];
  let closed = 0;
  const shared: SharedBrowser = {
    driver(options = {}) {
      driverOptions.push(options);
      return {
        open: async () => {
          contextOptions.push(
            options.storageStatePath === undefined ? {} : { storageState: options.storageStatePath },
          );
          throw new Error('fake open');
        },
        close: async () => {},
      };
    },
    close: async () => {
      closed += 1;
      hooks.onClose?.();
    },
  };
  return { shared, driverOptions, contextOptions, closeCalls: () => closed };
}

function makeFactoryPorts(overrides: {
  loadConfig?: (path: string) => Promise<UsablConfig>;
  buildDeps?: BuildDepsPort;
  runEngine?: (deps: Deps, config: UsablConfig) => Promise<Result>;
  makeBrowser?: () => SharedBrowser;
}): {
  loadConfig: (path: string) => Promise<UsablConfig>;
  buildDeps: BuildDepsPort;
  runEngine: (deps: Deps, config: UsablConfig) => Promise<Result>;
  makeBrowser: () => SharedBrowser;
} {
  return {
    loadConfig: overrides.loadConfig ?? (async () => makeConfig()),
    buildDeps: overrides.buildDeps ?? (async () => makeDeps()),
    runEngine: overrides.runEngine ?? (async () => baseResult({})),
    makeBrowser: overrides.makeBrowser ?? (() => fakeSharedBrowser({}).shared),
  };
}

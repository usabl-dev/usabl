import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import type { Deps, Result, UsablConfig } from '../../src/contracts/index.js';
import { overlayClientSource } from '../../src/surfaces/overlay-client.js';
import { projectOverlay, singleFlight, usablVitePlugin, usablVitePluginFromConfig } from '../../src/surfaces/vite-plugin.js';

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

describe('singleFlight', () => {
  it('coalesces concurrent calls to one in-flight execution', async () => {
    let calls = 0;
    const run = singleFlight(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'result-value';
    });

    const [a, b, c] = await Promise.all([run(), run(), run()]);

    expect(calls).toBe(1);
    expect(a).toBe('result-value');
    expect(b).toBe('result-value');
    expect(c).toBe('result-value');
  });

  it('runs again after the previous call settles', async () => {
    let calls = 0;
    const run = singleFlight(async () => {
      calls += 1;
      return calls;
    });

    await run();
    const second = await run();

    expect(calls).toBe(2);
    expect(second).toBe(2);
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
      (req: { method?: string; url?: string }, res: FakeResponse, next: () => void) => void | Promise<void>
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

  it('loads config, builds deps, runs engine, and closes browser for one overlay request', async () => {
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
    let runEngineDeps: Deps | null = null;
    let runEngineConfig: UsablConfig | null = null;
    let closeCalls = 0;
    deps.browser.close = async () => {
      closeCalls += 1;
      calls.push('close');
    };

    const plugin = usablVitePluginFromConfig(
      { cwd: '/repo/app' },
      makeFactoryPorts({
        loadConfig: async (path) => {
          loadConfigPath = path;
          calls.push('loadConfig');
          return config;
        },
        buildDeps: async (resolvedConfig, options) => {
          buildDepsConfig = resolvedConfig;
          buildDepsCwd = options.cwd;
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
    expect(runEngineDeps).toBe(deps);
    expect(runEngineConfig).toBe(config);
    expect(closeCalls).toBe(1);
    expect(calls).toEqual(['loadConfig', 'buildDeps', 'runEngine', 'close']);
    expect(JSON.parse(response.body)).toEqual(projectOverlay(engineResult, '/repo/app'));
  });

  it('closes browser when runEngine throws', async () => {
    const deps = makeDeps();
    let closeCalls = 0;
    deps.browser.close = async () => {
      closeCalls += 1;
    };
    const plugin = usablVitePluginFromConfig(
      { cwd: '/repo/app' },
      makeFactoryPorts({
        buildDeps: async () => deps,
        runEngine: async () => {
          throw new Error('engine failed');
        },
      }),
    );
    const middleware = getMiddleware(plugin);
    const response = makeResponse();

    await expect(
      middleware({ method: 'GET', url: '/__usabl/result' }, response, () => {
        // middleware should throw before next() on this endpoint
      }),
    ).rejects.toThrow('engine failed');
    expect(closeCalls).toBe(1);
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
  middleware: (req: { method?: string; url?: string }, res: FakeResponse, next: () => void) => void | Promise<void>,
  url: string,
): Promise<FakeResponse> {
  const res = makeResponse();
  let nextCalled = false;
  await middleware({ method: 'GET', url }, res, () => {
    nextCalled = true;
  });
  expect(nextCalled).toBe(false);
  return res;
}

function getMiddleware(
  plugin: ReturnType<typeof usablVitePlugin>,
): (req: { method?: string; url?: string }, res: FakeResponse, next: () => void) => Promise<void> | void {
  const middlewares: Array<
    (req: { method?: string; url?: string }, res: FakeResponse, next: () => void) => void | Promise<void>
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

function makeFactoryPorts(overrides: {
  loadConfig?: (path: string) => Promise<UsablConfig>;
  buildDeps?: (config: UsablConfig, options: { cwd: string }) => Promise<Deps>;
  runEngine?: (deps: Deps, config: UsablConfig) => Promise<Result>;
}): {
  loadConfig: (path: string) => Promise<UsablConfig>;
  buildDeps: (config: UsablConfig, options: { cwd: string }) => Promise<Deps>;
  runEngine: (deps: Deps, config: UsablConfig) => Promise<Result>;
} {
  return {
    loadConfig: overrides.loadConfig ?? (async () => makeConfig()),
    buildDeps: overrides.buildDeps ?? (async () => makeDeps()),
    runEngine: overrides.runEngine ?? (async () => baseResult({})),
  };
}

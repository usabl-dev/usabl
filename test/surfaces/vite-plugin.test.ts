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
    expect(JSON.parse(response.body)).toEqual(projectOverlay(engineResult));
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
    checkRunner: {
      scan: async () => ({
        screenId: 'screen',
        url: 'http://127.0.0.1:5173',
        stops: [],
        drafts: [],
        gaps: [],
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

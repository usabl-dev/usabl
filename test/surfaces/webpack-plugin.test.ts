/**
 * The webpack overlay plugin, built with real webpack against a seed-shaped app.
 *
 * It must behave like the Vite plugin: source location attributes and the overlay loader in
 * development only, the same guarded endpoints, and nothing at all in a production build. These
 * tests compile the fixture with webpack and read the emitted bundle, and drive the dev server
 * middleware the plugin registers through the same setupMiddlewares option `webpack serve` reads.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import webpack from 'webpack';
import type { Result } from '../../src/contracts/index.js';
import { UsablWebpackPlugin } from '../../src/surfaces/webpack-plugin.js';
import { BARRIER_FILE, BARRIER_LINE, copySeedApp, seedDevConfig, seedProdConfig } from '../fixtures/webpack-seed-app.js';

const baseResult = (over: Partial<Result> = {}): Result => ({
  schemaVersion: 'usabl.result.v1',
  verdict: 'verified',
  summary: 'verified: 0 gating finding(s)',
  screens: [],
  coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
  findings: [],
  receipt: null,
  dirtyGuardedPaths: [],
  exitCode: 0,
  accessibilityVerdict: null,
  accessibilityExitCode: 0,
  paidDownCount: 0,
  floorHeadroom: [],
  floorUnconfirmed: [],
  ...over,
});

// A plugin whose engine run is a fixed Result, so no config, git, or browser is needed.
function pluginWithResult(root: string, result: Result = baseResult()): UsablWebpackPlugin {
  return new UsablWebpackPlugin(
    { cwd: root },
    {
      loadConfig: async () => ({}) as never,
      buildDeps: async () => ({}) as never,
      runEngine: async () => result,
      makeBrowser: () => ({ driver: () => ({}) as never, close: async () => {} }) as never,
      logError: () => {},
    },
  );
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function appRoot(): Promise<string> {
  const root = await copySeedApp();
  roots.push(root);
  return root;
}

type Compiler = webpack.Compiler;

function compile(config: Record<string, unknown>): Compiler {
  return webpack(config as webpack.Configuration);
}

async function build(config: Record<string, unknown>): Promise<{ bundle: string; compiler: Compiler; files: string[] }> {
  const compiler = compile(config);
  const stats = await new Promise<webpack.Stats>((resolve, reject) => {
    compiler.run((error, result) => {
      if (error !== null && error !== undefined) {
        reject(error);
        return;
      }
      resolve(result as webpack.Stats);
    });
  });
  await new Promise<void>((resolve) => compiler.close(() => resolve()));
  expect(stats.hasErrors(), stats.toString('errors-only')).toBe(false);
  const output = (config['output'] as { path: string }).path;
  const bundle = await readFile(join(output, 'main.bundle.js'), 'utf8');
  return { bundle, compiler, files: [...stats.compilation.fileDependencies].sort() };
}

interface Middleware {
  name?: string;
  middleware: (req: unknown, res: unknown, next: () => void) => unknown;
}

// Calls the setupMiddlewares option the way webpack-dev-server does, with a listening address.
function middlewaresOf(compiler: Compiler, port: number, existing: Middleware[] = []): Middleware[] {
  const devServer = compiler.options.devServer as {
    setupMiddlewares?: (middlewares: Middleware[], server: unknown) => Middleware[];
  };
  expect(typeof devServer.setupMiddlewares).toBe('function');
  const server = {
    options: { host: '127.0.0.1', port, server: { type: 'http' } },
    server: { address: () => ({ port }), on: () => {} },
  };
  return devServer.setupMiddlewares!([...existing], server);
}

interface FakeResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  chunks: string[];
  ended: boolean;
  setHeader(name: string, value: string): void;
  end(chunk?: string): void;
  write(chunk: string): void;
}

function fakeResponse(): FakeResponse {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    chunks: [],
    ended: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk) {
      this.body = chunk ?? '';
      this.ended = true;
    },
    write(chunk) {
      this.chunks.push(chunk);
    },
  };
}

async function request(
  middleware: Middleware,
  url: string,
  headers: Record<string, string>,
): Promise<{ res: FakeResponse; passed: boolean }> {
  const res = fakeResponse();
  let passed = false;
  await middleware.middleware(
    { method: 'GET', url, headers, rawHeaders: Object.entries(headers).flat(), on: () => {} },
    res,
    () => {
      passed = true;
    },
  );
  return { res, passed };
}

describe('UsablWebpackPlugin in a development build', () => {
  it('adds source attributes with the exact line, and the overlay loader, to the bundle', async () => {
    const root = await appRoot();
    const { bundle } = await build(seedDevConfig(root, [pluginWithResult(root)], 9000));

    // The barrier's own opening tag carries its repo-relative file and its line in App.tsx.
    expect(bundle).toContain(
      `type: \\"button\\", class: \\"icon-only\\", \\"data-source-file\\": \\"${BARRIER_FILE}\\", \\"data-source-line\\": \\"${BARRIER_LINE}\\"`,
    );
    expect(bundle).toContain('/__usabl/client.js');
    // The loader skips the overlay for a webdriver browser and for ?usabl=off, as the Vite one does.
    expect(bundle).toContain('navigator.webdriver');
    expect(bundle).toContain("'usabl'");
  }, 60_000);

  it('watches the usabl config so an edit to it drops the cached result', async () => {
    const root = await appRoot();
    const { files } = await build(seedDevConfig(root, [pluginWithResult(root)], 9000));
    expect(files).toContain(join(root, 'usabl.config.json'));
  }, 60_000);
});

describe('UsablWebpackPlugin in a production build', () => {
  it('leaves no source attributes and no overlay loader in the bundle', async () => {
    const root = await appRoot();
    const plugin = pluginWithResult(root);
    const { bundle, compiler } = await build(seedProdConfig(root, [plugin]));

    expect(bundle).not.toContain('data-source-file');
    expect(bundle).not.toContain('data-source-line');
    expect(bundle).not.toContain('__usabl');
    // The plugin adds no rule and no dev server hook outside development.
    const rules = compiler.options.module.rules as Array<{ loader?: string }>;
    expect(rules.some((rule) => typeof rule.loader === 'string' && rule.loader.includes('webpack-loader'))).toBe(false);
    expect(compiler.options.devServer).toBeUndefined();
  }, 60_000);

  it('treats a config with no mode as production, the way webpack does', async () => {
    const root = await appRoot();
    const config = seedProdConfig(root, [pluginWithResult(root)]);
    delete config['mode'];
    const { bundle } = await build(config);

    expect(bundle).not.toContain('data-source-file');
    expect(bundle).not.toContain('__usabl');
  }, 60_000);
});

describe('UsablWebpackPlugin dev server middleware', () => {
  const PORT = 9000;
  const local = { host: `127.0.0.1:${PORT}` };

  function devCompiler(root: string, plugin: UsablWebpackPlugin, devServer?: Record<string, unknown> | false): Compiler {
    const config = seedDevConfig(root, [plugin], PORT);
    if (devServer !== undefined) {
      config['devServer'] = devServer;
    }
    return compile(config);
  }

  it('runs first, keeps the middlewares the app set up, and serves the client without Vite', async () => {
    const root = await appRoot();
    const own: Middleware = { name: 'app-api', middleware: (_req, _res, next) => next() };
    const compiler = devCompiler(root, pluginWithResult(root), {
      host: '127.0.0.1',
      port: PORT,
      setupMiddlewares: (middlewares: Middleware[]) => [...middlewares, own],
    });
    const list = middlewaresOf(compiler, PORT);
    expect(list[0]?.name).toBe('usabl-overlay');
    expect(list).toContain(own);

    const { res } = await request(list[0]!, '/__usabl/client.js', local);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.body).not.toContain('/@vite/client');
    expect(res.body).toContain("new EventSource('/__usabl/events')");
    await new Promise<void>((resolve) => compiler.close(() => resolve()));
  });

  it('serves the projected result and passes other paths on', async () => {
    const root = await appRoot();
    const compiler = devCompiler(root, pluginWithResult(root, baseResult({ verdict: 'regression', exitCode: 1 })));
    const [usabl] = middlewaresOf(compiler, PORT);

    const result = await request(usabl!, '/__usabl/result', local);
    expect(result.res.statusCode).toBe(200);
    const projected = JSON.parse(result.res.body) as { advisory: boolean; displayExitCode: number; verdict: string };
    expect(projected).toMatchObject({ advisory: true, displayExitCode: 0, verdict: 'regression' });

    const other = await request(usabl!, '/main.bundle.js', local);
    expect(other.passed).toBe(true);
    await new Promise<void>((resolve) => compiler.close(() => resolve()));
  });

  it('refuses the result and the client to another host or origin', async () => {
    const root = await appRoot();
    const compiler = devCompiler(root, pluginWithResult(root));
    const [usabl] = middlewaresOf(compiler, PORT);

    for (const path of ['/__usabl/result', '/__usabl/client.js', '/__usabl/events']) {
      const rebound = await request(usabl!, path, { host: `attacker.example:${PORT}` });
      expect(rebound.res.statusCode).toBe(403);
      const crossOrigin = await request(usabl!, path, { ...local, origin: 'http://attacker.example' });
      expect(crossOrigin.res.statusCode).toBe(403);
      const otherPort = await request(usabl!, path, { host: '127.0.0.1:9001' });
      expect(otherPort.res.statusCode).toBe(403);
    }
    await new Promise<void>((resolve) => compiler.close(() => resolve()));
  });

  it('pushes a refresh event, and nothing else, after webpack reports a change', async () => {
    const root = await appRoot();
    const compiler = devCompiler(root, pluginWithResult(root));
    const [usabl] = middlewaresOf(compiler, PORT);

    const stream = await request(usabl!, '/__usabl/events', local);
    expect(stream.res.statusCode).toBe(200);
    expect(stream.res.headers['content-type']).toContain('text/event-stream');
    expect(stream.res.ended).toBe(false);

    compiler.hooks.invalid.call(join(root, BARRIER_FILE), Date.now());
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(stream.res.chunks.join('')).toContain('event: usabl:refresh\ndata: {}\n\n');
    await new Promise<void>((resolve) => compiler.close(() => resolve()));
  });

  it('leaves a dev server the config turned off alone', async () => {
    const root = await appRoot();
    const compiler = devCompiler(root, pluginWithResult(root), false);
    expect(compiler.options.devServer).toBe(false);
    await new Promise<void>((resolve) => compiler.close(() => resolve()));
  });
});

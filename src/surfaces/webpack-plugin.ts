/**
 * Advisory webpack overlay plugin: the same overlay the Vite plugin serves, for apps built with
 * webpack and served by webpack-dev-server (`webpack serve`).
 *
 * It adapts webpack's hooks to the shared overlay host, so the panel, the guarded endpoints, the
 * cached run, and the source attributes behave as they do under Vite. It must never convert
 * advisory display state into a process exit.
 *
 * Development only. In any mode other than "development" the plugin does nothing: it adds no
 * loader, no entry, and no dev server hook, so a production build is byte for byte what it would
 * be without usabl. webpack treats a config with no mode as production, and so does this plugin.
 *
 * In development it does four things:
 *  1. Adds a pre-loader that writes data-source-file and data-source-line on JSX opening tags,
 *     using the same transform as the Vite plugin, so a finding points to its source line.
 *  2. Adds a small entry that loads the overlay client from the dev server, skipped for a
 *     webdriver browser and for ?usabl=off, so usabl's own scans never grade the panel.
 *  3. Wraps devServer.setupMiddlewares so the overlay endpoints run before the app's own.
 *     `webpack serve` reads the devServer options from the compiler after plugins are applied,
 *     which is what makes this work without a second edit to the config.
 *  4. Drops the cached result when webpack reports a change, and pushes a refresh over a
 *     server-sent event stream, because webpack-dev-server has no channel a plugin can send a
 *     custom event on.
 *
 * webpack is not imported here, not even for types. The compiler shape below is the part this
 * plugin uses, and the app provides webpack itself. That keeps webpack out of usabl's runtime
 * dependencies.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { overlayClientSource } from './overlay-client.js';
import {
  OVERLAY_CLIENT_PATH,
  OVERLAY_EVENTS_PATH,
  OVERLAY_REFRESH_EVENT,
  makeConfigBackedOverlayRun,
  makeOverlayHost,
  type Middleware,
  type OverlayFactoryPorts,
  type OverlayFromConfigOptions,
  type ResolvedServerAddress,
  type UsablHttpServer,
} from './overlay-host.js';

// The key the loader reads the transform from. It must match webpack-loader.ts, which cannot
// import it because the loader is kept free of imports.
export const WEBPACK_SOURCE_TRANSFORM_KEY = Symbol.for('usabl.webpack.sourceTransform');

// webpack-dev-server's default port, used only when neither the live listener nor the config names one.
const DEFAULT_DEV_PORT = 8080;

const PLUGIN_NAME = 'usabl-overlay';

// Policy files a run reads that are not part of the app's module graph. webpack watches only the
// graph, so these are added to each compilation; an edit to one then drops the cached result the
// way any watched file does under Vite. Other inputs are picked up by "Check again".
const WATCHED_POLICY_FILES = ['usabl.routes.json', '.usabl-evidence.json', '.usabl-waivers.json'];

interface Tap<Args extends unknown[]> {
  tap(name: string, fn: (...args: Args) => void): void;
}

interface DevServerMiddleware {
  name?: string;
  path?: string;
  middleware: Middleware;
}

interface DevServerOptions {
  host?: unknown;
  port?: unknown;
  server?: unknown;
  https?: unknown;
  setupMiddlewares?: (middlewares: DevServerMiddleware[], devServer: DevServerInstance) => DevServerMiddleware[];
  [key: string]: unknown;
}

// What webpack-dev-server passes as the second argument of setupMiddlewares: its normalized
// options and, once it listens, the Node server.
interface DevServerInstance {
  options?: DevServerOptions;
  server?: { address?(): unknown } | null;
}

interface CompilationShape {
  fileDependencies: { add(path: string): void };
}

export interface WebpackCompilerShape {
  context: string;
  options: {
    mode?: string | undefined;
    module: { rules: unknown[] };
    devServer?: DevServerOptions | false | undefined;
  };
  webpack: {
    EntryPlugin: new (
      context: string,
      entry: string,
      options: { name?: string | undefined },
    ) => { apply(compiler: never): void };
  };
  hooks: {
    invalid: Tap<[string | null, number]>;
    thisCompilation: Tap<[CompilationShape]>;
    watchClose: Tap<[]>;
    shutdown?: { tapPromise(name: string, fn: () => Promise<void>): void };
  };
}

export interface UsablWebpackPluginOptions extends OverlayFromConfigOptions {}

interface WebpackPluginPorts extends OverlayFactoryPorts {
  // Where the loader file is. A port so a test can point at a copy; the default is the file next to
  // this module, which is the built loader in the published package.
  loaderPath: string;
  logWarning: (message: string) => void;
}

function defaultLoaderPath(): string {
  // From the published package this module is dist/webpack-plugin.js and the loader is
  // dist/webpack-loader.js. From the source tree, in this repository's tests, both are .ts.
  const here = fileURLToPath(import.meta.url);
  const extension = here.endsWith('.ts') ? '.ts' : '.js';
  return join(dirname(here), `webpack-loader${extension}`);
}

// The browser side of the refresh channel. The shared client listens on import.meta.hot, so this
// gives it one backed by the event stream. The stream carries only the event name.
function overlayClientModuleSource(): string {
  return [
    'import.meta.hot = {',
    '  on(event, callback) {',
    `    if (event !== '${OVERLAY_REFRESH_EVENT}' || typeof EventSource !== 'function') return;`,
    `    const source = new EventSource('${OVERLAY_EVENTS_PATH}');`,
    `    source.addEventListener('${OVERLAY_REFRESH_EVENT}', () => callback());`,
    '  },',
    '};',
    overlayClientSource,
  ].join('\n');
}

// The entry added to the app bundle. It is a data URI, so no file of usabl's passes through the
// app's own loaders. It adds the client as a module script rather than importing it, so webpack
// never tries to bundle the client path.
const LOADER_ENTRY_SOURCE = [
  "if (typeof window !== 'undefined' && !navigator.webdriver &&",
  "  new URLSearchParams(window.location.search).get('usabl') !== 'off') {",
  "  const script = document.createElement('script');",
  "  script.type = 'module';",
  `  script.src = '${OVERLAY_CLIENT_PATH}';`,
  '  document.head.appendChild(script);',
  '}',
].join('\n');

function serverAddressOf(options: DevServerOptions | undefined): ResolvedServerAddress {
  const address: ResolvedServerAddress = {};
  if (options === undefined) {
    return address;
  }
  if (typeof options.host === 'string') {
    address.host = options.host;
  }
  const port = typeof options.port === 'string' ? Number(options.port) : options.port;
  if (typeof port === 'number' && Number.isInteger(port) && port > 0) {
    address.port = port;
  }
  // webpack-dev-server 5 names the protocol in server, as a string or as { type }. 4 used https.
  const server = options.server;
  const type =
    typeof server === 'string'
      ? server
      : typeof server === 'object' && server !== null
        ? Reflect.get(server, 'type')
        : undefined;
  if (type === 'https' || type === 'spdy' || type === 'http2' || (options.https !== undefined && options.https !== false)) {
    address.https = true;
  }
  return address;
}

export class UsablWebpackPlugin {
  readonly name = PLUGIN_NAME;
  private readonly options: UsablWebpackPluginOptions;
  private readonly ports: Partial<WebpackPluginPorts>;

  constructor(options: UsablWebpackPluginOptions = {}, ports: Partial<WebpackPluginPorts> = {}) {
    this.options = options;
    this.ports = ports;
  }

  apply(compiler: WebpackCompilerShape): void {
    if (compiler.options.mode !== 'development') {
      // Production, "none", or no mode at all. Nothing is added, so nothing can leak into the build.
      return;
    }
    const engine = makeConfigBackedOverlayRun(
      { ...this.options, cwd: resolve(this.options.cwd ?? this.ports.cwd?.() ?? process.cwd()) },
      this.ports,
    );
    const host = makeOverlayHost({
      run: engine.run,
      workspaceRoot: engine.workspaceRoot,
      onClose: engine.onClose,
      logError: engine.logError,
      ...(this.ports.logWarning === undefined ? {} : { logWarning: this.ports.logWarning }),
      clientModuleSource: overlayClientModuleSource,
      defaultPort: DEFAULT_DEV_PORT,
      eventStream: true,
    });

    // 1. Source attributes. The loader runs first, before ts-loader or babel-loader turn JSX into
    // calls, for the same reason the Vite plugin runs with enforce: 'pre'.
    Reflect.set(compiler, WEBPACK_SOURCE_TRANSFORM_KEY, (code: string, file: string) => host.transformSource(code, file));
    compiler.options.module.rules.push({
      test: /\.(tsx|jsx)$/,
      exclude: /node_modules/,
      enforce: 'pre',
      loader: this.ports.loaderPath ?? defaultLoaderPath(),
    });

    // 2. The overlay loader, added to every entry the way webpack-dev-server adds its own client.
    new compiler.webpack.EntryPlugin(
      compiler.context,
      `data:text/javascript,${encodeURIComponent(LOADER_ENTRY_SOURCE)}`,
      { name: undefined },
    ).apply(compiler as never);

    // 3. The dev server endpoints. false means the config turned the dev server off on purpose.
    if (compiler.options.devServer !== false) {
      const devServer: DevServerOptions = compiler.options.devServer ?? {};
      compiler.options.devServer = devServer;
      host.applyServerConfig(serverAddressOf(devServer));
      const previous = devServer.setupMiddlewares;
      devServer.setupMiddlewares = (middlewares, instance) => {
        const list = typeof previous === 'function' ? previous(middlewares, instance) : middlewares;
        host.applyServerConfig(serverAddressOf(instance.options ?? devServer));
        // The listener is read per request, because the server may not be listening yet.
        const listener: UsablHttpServer = {
          on: () => {},
          address: () => instance.server?.address?.(),
        };
        host.setHttpServer(listener);
        list.unshift({ name: PLUGIN_NAME, middleware: host.middleware });
        return list;
      };
    }

    // 4. Change tracking and shutdown.
    compiler.hooks.invalid.tap(PLUGIN_NAME, () => {
      host.scheduleRefresh();
    });
    const configPath = resolve(engine.workspaceRoot, this.options.configPath ?? 'usabl.config.json');
    const policyFiles = [configPath, ...WATCHED_POLICY_FILES.map((file) => join(engine.workspaceRoot, file))];
    compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
      for (const file of policyFiles) {
        if (existsSync(file) || file === configPath) {
          compilation.fileDependencies.add(file);
        }
      }
    });
    compiler.hooks.watchClose.tap(PLUGIN_NAME, () => {
      void host.close();
    });
    compiler.hooks.shutdown?.tapPromise(PLUGIN_NAME, () => host.close());
  }
}

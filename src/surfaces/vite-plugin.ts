/**
 * Advisory Vite overlay plugin that projects an existing Result inside host apps.
 * This unit serves read-only overlay assets and wires host config to run().
 * It must never convert advisory display state into process exits.
 */
import { resolve, relative } from 'node:path';
import { loadConfig } from '../cli.js';
import type { BrowserDriver, Deps, Result, UsablConfig } from '../contracts/index.js';
import { buildDeps } from '../deps/build.js';
import { makeSharedBrowser, type RealBrowserOptions, type SharedBrowser } from '../deps/real.js';
import { run } from '../run.js';
import { frameUntrusted, scrubResult } from './scrub.js';
import { overlayClientSource } from './overlay-client.js';
import { injectJsxSourceAttributes, shouldInjectJsxSource } from './vite-jsx-source.js';

function overlayClientModuleSource(): string {
  return [
    "import { createHotContext as __vite__createHotContext } from '/@vite/client';",
    "import.meta.hot = __vite__createHotContext('/__usabl/client.js');",
    overlayClientSource,
  ].join('\n');
}

export interface OverlayProjection {
  advisory: true;
  displayExitCode: 0;
  workspaceRoot: string | null;
  exitCode: Result['exitCode'];
  verdict: Result['verdict'];
  schemaVersion: Result['schemaVersion'];
  summary: string;
  coverage: {
    affected: Result['coverage']['affected'];
    unresolvedFiles: Result['coverage']['unresolvedFiles'];
    gaps: Result['coverage']['gaps'];
    // Carried through because a null verdict means two different things. With nothingToCheck true
    // and exit code 0 it means the run had no affected screen and there was nothing to prove.
    // Without it, a null verdict is an absence of proof, and the overlay must not draw that green.
    nothingToCheck: Result['coverage']['nothingToCheck'];
  };
  findings: Array<{
    rule: string;
    screenId: string;
    layer: string;
    severity: Result['findings'][number]['severity'];
    evidenceClass: Result['findings'][number]['evidenceClass'];
    status: Result['findings'][number]['status'];
    confidence: Result['findings'][number]['confidence'];
    elementPath: string;
    elementName: string | null;
    role: string | null;
    elementKey: string | null;
    identityBasis: Result['findings'][number]['identityBasis'];
    whatUserExperiences: string;
    why: string;
    fix: string;
    appSource: Result['findings'][number]['appSource'] | null;
  }>;
  // The number of findings in this projection. The list is flat, one entry per finding, so this is
  // simply its length. There is no collapsing here and therefore no "showing N of M" to disclose.
  findingsTotalCount: number;
  receipt: {
    sourceTree: string;
    baseRevision: string | null;
    policyHash: string;
    runnerVersion: string;
    scannerVersions: NonNullable<Result['receipt']>['scannerVersions'];
    surfaces: string[];
    checkedScreens: string[];
    notCovered: string[];
    findingsSummary: NonNullable<Result['receipt']>['findingsSummary'];
    activeWaivers: number;
    mintedAt: string;
  } | null;
  dirtyGuardedPaths: string[];
  paidDownCount: number;
}

type IncomingHeaders = Record<string, string | string[] | undefined>;

// rawHeaders is the flat name, value, name, value list Node keeps before it folds duplicates. It is
// the only place a second Host header is still visible: the folded headers object keeps one of them
// and which one depends on the runtime, so a check made on it can be steered by header order.
interface IncomingRequest {
  method?: string;
  url?: string;
  headers?: IncomingHeaders;
  rawHeaders?: string[];
}

type Middleware = (
  req: IncomingRequest,
  res: {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(chunk?: string): void;
  },
  next: () => void,
) => void | Promise<void>;

interface UsablWatcher {
  on(event: string, cb: () => void): void;
}

interface UsablWs {
  send(payload: { type: string; event: string }): void;
}

interface UsablHttpServer {
  on(event: 'close', handler: () => void): void;
  // Node's net.Server.address(): the port the server actually listens on, which can differ from the
  // configured one when that port was taken. Read at request time, because it is null until listen.
  address?(): unknown;
}

interface UsablServer {
  middlewares: { use(middleware: Middleware): void };
  ws: UsablWs;
  watcher?: UsablWatcher;
  httpServer?: UsablHttpServer | null;
  config?: { server?: ResolvedServerAddress };
}

interface ResolvedServerAddress {
  host?: string | boolean;
  port?: number;
  https?: unknown;
}

// Vite's default dev port, used only when neither the live listener nor the config names one.
const DEFAULT_DEV_PORT = 5173;

export interface UsablVitePlugin {
  name: string;
  enforce?: 'pre' | 'post';
  configureServer?: (server: UsablServer) => void;
  configResolved?: (config: { command: string; server?: ResolvedServerAddress }) => void;
  transformIndexHtml?: (html: string) => string | Promise<string>;
  transform?: (code: string, id: string) => { code: string; map: null } | null;
  // Vite calls closeBundle when the dev server or a build shuts down. It is the backstop that closes
  // the warm browser when there is no httpServer close event, for example in a middleware-mode host.
  closeBundle?: () => void | Promise<void>;
}

// The origin this dev server answers as: its scheme, its listening port, and the host it was told to
// bind to when that host is a name. It is what a request's Host and Origin are compared against.
interface DevServerOrigin {
  scheme: 'http' | 'https';
  port: number;
  configuredHost: string | null;
}

// A parsed authority: a lowercased hostname, bracketed for IPv6, and the port when one was written.
interface Authority {
  hostname: string;
  port: number | null;
}

// Parses a Host header value. IPv6 hosts arrive in brackets, for example "[::1]:5173", and the
// brackets are kept so the value compares equal to the bracketed form URL.hostname produces.
function parseHostHeader(hostHeader: string): Authority | null {
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed === '') {
    return null;
  }
  let hostname: string;
  let rest: string;
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    if (close === -1) {
      return null;
    }
    hostname = trimmed.slice(0, close + 1);
    rest = trimmed.slice(close + 1);
  } else {
    const colon = trimmed.indexOf(':');
    hostname = colon === -1 ? trimmed : trimmed.slice(0, colon);
    rest = colon === -1 ? '' : trimmed.slice(colon);
  }
  if (rest === '') {
    return { hostname, port: null };
  }
  if (!/^:\d{1,5}$/.test(rest)) {
    return null;
  }
  return { hostname, port: Number(rest.slice(1)) };
}

function isLocalHostname(hostname: string, configuredHost: string | null): boolean {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') {
    return true;
  }
  return configuredHost !== null && hostname === configuredHost;
}

// The port a URL or authority means when none was written.
function effectivePort(port: number | null, scheme: 'http' | 'https'): number {
  if (port !== null) {
    return port;
  }
  return scheme === 'https' ? 443 : 80;
}

function countHeader(rawHeaders: string[] | undefined, name: string): number {
  if (rawHeaders === undefined) {
    return 0;
  }
  let count = 0;
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) {
      count += 1;
    }
  }
  return count;
}

// The result projection exposes the absolute workspace root, source paths, import chains, guarded
// paths, and findings. These handlers run before Vite validates the Host header and they end the
// response, so without this check they answer a request aimed at the dev server from another origin
// through DNS rebinding or a cross-origin fetch.
//
// The Host must name a local host or the configured bind host, on this server's port. When an Origin
// is present it must match exactly, scheme and hostname and effective port, either the origin this
// request's own Host names under the server's scheme, or the configured dev origin. "null" is not an
// origin the page can be trusted from, so it is refused. A request carrying two Host headers is
// refused outright: the folded header keeps one of them and which one depends on the runtime, so a
// check on the folded value could be steered by header order.
export function isRequestFromDevOrigin(req: IncomingRequest, server: DevServerOrigin): boolean {
  if (countHeader(req.rawHeaders, 'host') > 1 || Array.isArray(req.headers?.host)) {
    return false;
  }
  const hostHeader = req.headers?.host;
  if (typeof hostHeader !== 'string') {
    // A missing Host header on HTTP/1.1 is malformed. Refuse rather than guess.
    return false;
  }
  const host = parseHostHeader(hostHeader);
  if (host === null || !isLocalHostname(host.hostname, server.configuredHost)) {
    return false;
  }
  if (effectivePort(host.port, server.scheme) !== server.port) {
    return false;
  }

  const originHeader = req.headers?.origin;
  if (originHeader === undefined) {
    return true;
  }
  if (Array.isArray(originHeader) || originHeader.trim() === '' || originHeader.trim() === 'null') {
    return false;
  }
  let origin: URL;
  try {
    origin = new URL(originHeader.trim());
  } catch {
    return false;
  }
  const originScheme = origin.protocol === 'https:' ? 'https' : origin.protocol === 'http:' ? 'http' : null;
  if (originScheme !== server.scheme) {
    return false;
  }
  const originHostname = origin.hostname.toLowerCase();
  const allowedHostnames = new Set([host.hostname]);
  if (server.configuredHost !== null) {
    allowedHostnames.add(server.configuredHost);
  }
  if (!allowedHostnames.has(originHostname)) {
    return false;
  }
  const originPort = origin.port === '' ? null : Number(origin.port);
  return effectivePort(originPort, originScheme) === server.port;
}

function portOfAddress(address: unknown): number | null {
  if (typeof address !== 'object' || address === null) {
    return null;
  }
  const port = Reflect.get(address, 'port');
  return typeof port === 'number' && Number.isInteger(port) && port > 0 ? port : null;
}

function toRepoRelativeSourcePath(workspaceRoot: string, id: string): string {
  const normalizedId = id.replace(/\\/g, '/');
  const normalizedRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '');
  if (normalizedRoot !== '' && normalizedId.startsWith(`${normalizedRoot}/`)) {
    return normalizedId.slice(normalizedRoot.length + 1);
  }
  return relative(workspaceRoot || process.cwd(), id).replace(/\\/g, '/');
}

export interface UsablVitePluginFromConfigOptions {
  cwd?: string;
  configPath?: string;
}

interface UsablVitePluginFactoryPorts {
  cwd: () => string;
  resolvePath: (cwd: string, configPath: string) => string;
  loadConfig: (path: string) => Promise<UsablConfig>;
  buildDeps: (
    config: UsablConfig,
    options: { cwd: string; browserFor?: (options: RealBrowserOptions) => BrowserDriver },
  ) => Promise<Deps>;
  runEngine: (deps: Deps, config: UsablConfig) => Promise<Result>;
  // Makes the one browser process the overlay keeps across refresh waves. It is a port so a test can
  // inject a fake and prove the process is made once, receives each run's options, and is closed
  // once, without a real Chromium.
  makeBrowser: () => SharedBrowser;
}

function makeUsablVitePluginFactoryPorts(
  overrides: Partial<UsablVitePluginFactoryPorts> = {},
): UsablVitePluginFactoryPorts {
  return {
    cwd: overrides.cwd ?? (() => process.cwd()),
    resolvePath: overrides.resolvePath ?? ((cwd: string, configPath: string) => resolve(cwd, configPath)),
    loadConfig: overrides.loadConfig ?? (async (path: string) => loadConfig(path)),
    buildDeps:
      overrides.buildDeps ??
      (async (
        config: UsablConfig,
        options: { cwd: string; browserFor?: (options: RealBrowserOptions) => BrowserDriver },
      ) => buildDeps(config, options)),
    runEngine: overrides.runEngine ?? (async (deps: Deps, config: UsablConfig) => run(deps, config)),
    makeBrowser: overrides.makeBrowser ?? (() => makeSharedBrowser()),
  };
}

export function projectOverlay(
  result: Result,
  workspaceRoot: string | null = null,
): OverlayProjection {
  // Overlay is advisory only, so displayExitCode stays 0 even when the gated Result blocked.
  const safe = scrubResult(result);
  // No noise budget here. The overlay list is flat, one row per finding, so each one can be located
  // on the page by itself. A collapsed representative row cannot be located, because it stands for
  // elements it does not name. Carrying a "showing N of M" flag beside a list that shows all of them
  // would describe a projection that no longer exists, so those fields are gone rather than stale.
  return {
    advisory: true,
    displayExitCode: 0,
    workspaceRoot,
    exitCode: safe.exitCode,
    verdict: safe.verdict,
    schemaVersion: safe.schemaVersion,
    summary: safe.summary,
    coverage: {
      affected: safe.coverage.affected,
      unresolvedFiles: safe.coverage.unresolvedFiles,
      gaps: safe.coverage.gaps,
      nothingToCheck: safe.coverage.nothingToCheck,
    },
    findings: safe.findings.map((finding) => {
      return {
        rule: finding.rule,
        screenId: finding.screenId,
        layer: finding.layer,
        severity: finding.severity,
        evidenceClass: finding.evidenceClass,
        status: finding.status,
        confidence: finding.confidence,
        elementPath: frameUntrusted(finding.elementPath),
        elementName: finding.elementName === null ? null : frameUntrusted(finding.elementName),
        role: finding.role === null ? null : frameUntrusted(finding.role),
        elementKey: finding.elementKey === null ? null : frameUntrusted(finding.elementKey),
        identityBasis: finding.identityBasis,
        whatUserExperiences: frameUntrusted(finding.whatUserExperiences),
        why: finding.why,
        fix: finding.fix,
        appSource: finding.appSource ?? null,
      };
    }),
    findingsTotalCount: safe.findings.length,
    receipt:
      safe.receipt === null
        ? null
        : {
            sourceTree: safe.receipt.sourceTree,
            baseRevision: safe.receipt.baseRevision,
            policyHash: safe.receipt.policyHash,
            runnerVersion: safe.receipt.runnerVersion,
            scannerVersions: safe.receipt.scannerVersions,
            surfaces: safe.receipt.surfaces,
            checkedScreens: safe.receipt.coverage.checked,
            notCovered: safe.receipt.coverage.notCovered,
            findingsSummary: safe.receipt.findingsSummary,
            activeWaivers: safe.receipt.activeWaivers,
            mintedAt: safe.receipt.mintedAt,
          },
    dirtyGuardedPaths: safe.dirtyGuardedPaths,
    paidDownCount: safe.paidDownCount,
  };
}

export interface ResultCache<T> {
  // The current result. Joins a run already in flight, serves the cached result when one exists,
  // and starts a run otherwise. fresh: true skips the cache but still joins an in-flight run.
  read(options?: { fresh?: boolean }): Promise<T>;
  // Drops the cached result. A run already in flight keeps going but its result is not cached,
  // because it measured the tree as it was before the change that invalidated it.
  invalidate(): void;
}

/**
 * One completed result, served until the next invalidation.
 *
 * The earlier wrapper only shared one execution between CONCURRENT callers and forgot the result
 * the moment it settled, so the very next read after a run re-ran the whole engine. A scan is
 * dominated by the keyboard focus transcript, which is real evidence and cannot be cut, so every
 * panel open and every re-read paid the full scan again. The file watcher is the only thing that
 * makes a completed result stale, so its invalidation is the only thing that drops the cache.
 *
 * A rejected run is never cached: the next read retries. A run that was in flight when the cache
 * was invalidated is neither joined nor cached, so a reader after a save always gets a run that saw
 * the save.
 */
export function makeResultCache<T>(fn: () => Promise<T>): ResultCache<T> {
  let generation = 0;
  let cached: Promise<T> | null = null;
  let running: { generation: number; promise: Promise<T> } | null = null;

  return {
    read(options = {}) {
      if (running !== null && running.generation === generation) {
        return running.promise;
      }
      if (options.fresh !== true && cached !== null) {
        return cached;
      }
      const runGeneration = generation;
      const promise = Promise.resolve().then(() => fn());
      const entry = { generation: runGeneration, promise };
      running = entry;
      // Bookkeeping runs in the first reaction on the promise, registered here before any caller
      // can await it, so by the time a caller continues the run is no longer marked as in flight.
      // Clearing it in a later chained step left a window where a fresh read issued right after
      // completion joined the finished run instead of starting a new one.
      const settle = (): void => {
        if (running === entry) {
          running = null;
        }
      };
      promise.then(
        () => {
          if (runGeneration === generation) {
            cached = promise;
          }
          settle();
        },
        () => {
          // Not cached. The caller sees the rejection and the next read starts a new run.
          settle();
        },
      );
      return promise;
    },
    invalidate() {
      generation += 1;
      cached = null;
    },
  };
}

function injectLoader(html: string): string {
  const loader = [
    '<script type="module">',
    "const search = new URLSearchParams(window.location.search);",
    "if (!navigator.webdriver && search.get('usabl') !== 'off') {",
    "  import('/__usabl/client.js').catch(() => {});",
    '}',
    '</script>',
  ].join('\n');
  return html.includes('</body>') ? html.replace('</body>', `${loader}\n</body>`) : `${html}\n${loader}`;
}

export function usablVitePlugin(opts: {
  run: () => Promise<Result>;
  workspaceRoot?: string;
  // Called once when the dev server or build shuts down. The config-backed factory uses it to close
  // the one warm browser it kept alive across refresh waves. It is guarded so it runs at most once.
  onClose?: () => void | Promise<void>;
}): UsablVitePlugin {
  const results = makeResultCache(opts.run);
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let injectSourceAttributes = false;
  let configuredHost: string | null = null;
  let configuredPort: number | null = null;
  let scheme: 'http' | 'https' = 'http';
  let httpServer: UsablHttpServer | null = null;
  let closed = false;
  const workspaceRoot = opts.workspaceRoot ?? '';

  // The one invalidation point. The file watcher calls this on change, add, and unlink, which are
  // the only events that make a completed result stale.
  const resetRun = (): void => {
    results.invalidate();
  };

  const closeOnce = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    if (opts.onClose !== undefined) {
      await opts.onClose();
    }
  };

  // The port this server answers on: the live listener first, then the configured port, then the
  // Vite default. The listener is consulted per request because it is null until the server listens.
  const devOrigin = (): DevServerOrigin => ({
    scheme,
    port: portOfAddress(httpServer?.address?.()) ?? configuredPort ?? DEFAULT_DEV_PORT,
    configuredHost,
  });

  const applyServerConfig = (config: ResolvedServerAddress | undefined): void => {
    const host = config?.host;
    // A string host is a specific bind address. true means all interfaces and false means
    // localhost, neither of which names an extra allowed host, so only a string is captured.
    configuredHost = typeof host === 'string' ? host.toLowerCase() : null;
    configuredPort = typeof config?.port === 'number' ? config.port : null;
    scheme = config?.https ? 'https' : 'http';
  };

  const rejectNonLocal = (
    req: IncomingRequest,
    res: { statusCode: number; setHeader(name: string, value: string): void; end(chunk?: string): void },
  ): boolean => {
    if (isRequestFromDevOrigin(req, devOrigin())) {
      return false;
    }
    res.statusCode = 403;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('forbidden');
    return true;
  };

  return {
    // We keep a minimal plugin shape so host apps provide Vite, and this package stays engine-focused.
    name: 'usabl-overlay',
    // Run before the host's JSX transform (for example @vitejs/plugin-react). That plugin rewrites
    // "<button>" into jsx() calls, so our string-level source injector must see the raw JSX first,
    // or it finds no tags to annotate and jump-to-source never gets a line.
    enforce: 'pre',
    configResolved(config) {
      injectSourceAttributes = config.command === 'serve';
      applyServerConfig(config.server);
    },
    configureServer(server) {
      httpServer = server.httpServer ?? null;
      if (server.config?.server !== undefined) {
        applyServerConfig(server.config.server);
      }
      server.middlewares.use(async (req, res, next) => {
        const method = req.method ?? 'GET';
        const requestUrl = new URL(req.url ?? '/', 'http://localhost');
        const pathname = requestUrl.pathname;
        if (method === 'GET' && pathname === '/__usabl/client.js') {
          if (rejectNonLocal(req, res)) {
            return;
          }
          res.statusCode = 200;
          res.setHeader('content-type', 'application/javascript; charset=utf-8');
          res.end(overlayClientModuleSource());
          return;
        }
        if (method === 'GET' && pathname === '/__usabl/result') {
          if (rejectNonLocal(req, res)) {
            return;
          }
          // fresh=1 is the panel's "Check again". It is the one user-driven way to re-run the engine
          // without a file change: the scan measures the live application, which can change without
          // a source edit, so a person who asks to check again gets a real check. Every other read
          // serves the cached result, and a fresh read still joins a run already in flight rather
          // than starting a second one beside it.
          const fresh = requestUrl.searchParams.get('fresh') === '1';
          const result = await results.read({ fresh });
          const projected = projectOverlay(result, opts.workspaceRoot ?? null);
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(projected));
          return;
        }
        next();
      });

      // The cache is dropped the instant the watcher reports a change. Only the browser notification
      // is debounced. Dropping the cache inside the debounce left a window, between the file event
      // and the timer, where a read was answered with the result of the tree before the change, and
      // a fresh read in that window started a second engine run for one save.
      const scheduleRefresh = (): void => {
        resetRun();
        if (refreshTimer !== null) {
          clearTimeout(refreshTimer);
        }
        refreshTimer = setTimeout(() => {
          server.ws.send({ type: 'custom', event: 'usabl:refresh' });
        }, 80);
      };

      if (server.watcher !== undefined) {
        server.watcher.on('change', scheduleRefresh);
        server.watcher.on('add', scheduleRefresh);
        server.watcher.on('unlink', scheduleRefresh);
      }

      // Close the warm browser when the dev server stops. closeBundle is the backstop for hosts with
      // no httpServer, and closeOnce guards against running the teardown twice.
      if (server.httpServer !== undefined && server.httpServer !== null) {
        server.httpServer.on('close', () => {
          void closeOnce();
        });
      }
    },
    transformIndexHtml(html) {
      // webdriver and usabl=off prevent the engine and Playwright oracles from grading the badge itself.
      return injectLoader(html);
    },
    transform(code, id) {
      if (!injectSourceAttributes || !shouldInjectJsxSource(id)) {
        return null;
      }
      return {
        code: injectJsxSourceAttributes(code, toRepoRelativeSourcePath(workspaceRoot, id)),
        map: null,
      };
    },
    async closeBundle() {
      await closeOnce();
    },
  };
}

export function usablVitePluginFromConfig(
  opts: UsablVitePluginFromConfigOptions = {},
  ports: Partial<UsablVitePluginFactoryPorts> = {},
): UsablVitePlugin {
  const resolvedPorts = makeUsablVitePluginFactoryPorts(ports);
  const cwd = opts.cwd ?? resolvedPorts.cwd();
  const configPath = opts.configPath ?? 'usabl.config.json';
  const resolvedConfigPath = resolvedPorts.resolvePath(cwd, configPath);

  // One warm browser for the whole dev session. It is launched lazily on the first run and reused by
  // every later run, so a save no longer pays a cold Chromium launch and teardown. Each run still
  // builds fresh Deps for correct git and intake state, and each open still makes a fresh context, so
  // run isolation is unchanged. The driver is closed once when the dev server shuts down.
  let warmBrowser: SharedBrowser | null = null;

  // Hosts should not assemble Deps. This factory keeps wiring in-package and
  // still returns a projection-only overlay backed by the gate-owned Result.
  return usablVitePlugin({
    workspaceRoot: cwd,
    run: async () => {
      const config = await resolvedPorts.loadConfig(resolvedConfigPath);
      warmBrowser ??= resolvedPorts.makeBrowser();
      const shared = warmBrowser;
      // buildDeps resolves this run's storage state and readiness budget and hands them back here,
      // so every context the shared process opens for this run carries this run's session and
      // budget. A process that took them once at launch would scan signed out after the operator
      // exported a session, and would keep the first run's budget after the config changed.
      const deps = await resolvedPorts.buildDeps(config, {
        cwd,
        browserFor: (options) => shared.driver(options),
      });
      // No browser teardown here on purpose. The process is shared across refresh waves and is
      // closed once at shutdown. Each open opens and closes its own context, so a run still leaves no
      // page or context state behind.
      return resolvedPorts.runEngine(deps, config);
    },
    onClose: async () => {
      if (warmBrowser !== null) {
        const browser = warmBrowser;
        warmBrowser = null;
        await browser.close();
      }
    },
  });
}

/**
 * Advisory Vite overlay plugin that projects an existing Result inside host apps.
 * This unit serves read-only overlay assets and wires host config to run().
 * It must never convert advisory display state into process exits.
 */
import { resolve } from 'node:path';
import { loadConfig } from '../cli.js';
import type { Deps, Result, UsablConfig } from '../contracts/index.js';
import { buildDeps } from '../deps/build.js';
import { run } from '../run.js';
import { frameUntrusted, scrubResult } from './scrub.js';
import { overlayClientSource } from './overlay-client.js';

export interface OverlayProjection {
  advisory: true;
  displayExitCode: 0;
  exitCode: Result['exitCode'];
  verdict: Result['verdict'];
  schemaVersion: Result['schemaVersion'];
  summary: string;
  coverage: {
    affected: Result['coverage']['affected'];
    unresolvedFiles: Result['coverage']['unresolvedFiles'];
    gaps: Result['coverage']['gaps'];
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
  }>;
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
}

type Middleware = (
  req: { method?: string; url?: string },
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

interface UsablServer {
  middlewares: { use(middleware: Middleware): void };
  ws: UsablWs;
  watcher?: UsablWatcher;
}

export interface UsablVitePlugin {
  name: string;
  configureServer?: (server: UsablServer) => void;
  transformIndexHtml?: (html: string) => string | Promise<string>;
}

export interface UsablVitePluginFromConfigOptions {
  cwd?: string;
  configPath?: string;
}

interface UsablVitePluginFactoryPorts {
  cwd: () => string;
  resolvePath: (cwd: string, configPath: string) => string;
  loadConfig: (path: string) => Promise<UsablConfig>;
  buildDeps: (config: UsablConfig, options: { cwd: string }) => Promise<Deps>;
  runEngine: (deps: Deps, config: UsablConfig) => Promise<Result>;
}

function makeUsablVitePluginFactoryPorts(
  overrides: Partial<UsablVitePluginFactoryPorts> = {},
): UsablVitePluginFactoryPorts {
  return {
    cwd: overrides.cwd ?? (() => process.cwd()),
    resolvePath: overrides.resolvePath ?? ((cwd: string, configPath: string) => resolve(cwd, configPath)),
    loadConfig: overrides.loadConfig ?? (async (path: string) => loadConfig(path)),
    buildDeps:
      overrides.buildDeps ?? (async (config: UsablConfig, options: { cwd: string }) => buildDeps(config, options)),
    runEngine: overrides.runEngine ?? (async (deps: Deps, config: UsablConfig) => run(deps, config)),
  };
}

export function projectOverlay(result: Result): OverlayProjection {
  // Overlay is advisory only, so displayExitCode stays 0 even when the gated Result blocked.
  const safe = scrubResult(result);
  return {
    advisory: true,
    displayExitCode: 0,
    exitCode: safe.exitCode,
    verdict: safe.verdict,
    schemaVersion: safe.schemaVersion,
    summary: safe.summary,
    coverage: {
      affected: safe.coverage.affected,
      unresolvedFiles: safe.coverage.unresolvedFiles,
      gaps: safe.coverage.gaps,
    },
    findings: safe.findings.map((finding) => ({
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
    })),
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
  };
}

export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return async () => {
    if (inFlight !== null) {
      return inFlight;
    }
    // One save can trigger multiple refresh paths; single-flight keeps one truthy run per wave.
    inFlight = Promise.resolve().then(() => fn());
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
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

export function usablVitePlugin(opts: { run: () => Promise<Result> }): UsablVitePlugin {
  let runOnce = singleFlight(opts.run);
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  const resetRun = (): void => {
    runOnce = singleFlight(opts.run);
  };

  return {
    // We keep a minimal plugin shape so host apps provide Vite, and this package stays engine-focused.
    name: 'usabl-overlay',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const method = req.method ?? 'GET';
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (method === 'GET' && pathname === '/__usabl/client.js') {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/javascript; charset=utf-8');
          res.end(overlayClientSource);
          return;
        }
        if (method === 'GET' && pathname === '/__usabl/result') {
          const result = projectOverlay(await runOnce());
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(result));
          return;
        }
        next();
      });

      const scheduleRefresh = (): void => {
        if (refreshTimer !== null) {
          clearTimeout(refreshTimer);
        }
        refreshTimer = setTimeout(() => {
          resetRun();
          server.ws.send({ type: 'custom', event: 'usabl:refresh' });
        }, 80);
      };

      if (server.watcher !== undefined) {
        server.watcher.on('change', scheduleRefresh);
        server.watcher.on('add', scheduleRefresh);
        server.watcher.on('unlink', scheduleRefresh);
      }
    },
    transformIndexHtml(html) {
      // webdriver and usabl=off prevent the engine and Playwright oracles from grading the badge itself.
      return injectLoader(html);
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

  // Hosts should not assemble Deps. This factory keeps wiring in-package and
  // still returns a projection-only overlay backed by the gate-owned Result.
  return usablVitePlugin({
    run: async () => {
      const config = await resolvedPorts.loadConfig(resolvedConfigPath);
      const deps = await resolvedPorts.buildDeps(config, { cwd });
      try {
        return await resolvedPorts.runEngine(deps, config);
      } finally {
        // Vite refresh waves must always close browser state, even on throw.
        await deps.browser.close();
      }
    },
  });
}

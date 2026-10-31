/**
 * Advisory Vite overlay plugin that projects an existing Result inside host apps.
 * This unit adapts Vite's hooks to the shared overlay host, which serves read-only overlay assets
 * and wires host config to run(). It must never convert advisory display state into process exits.
 */
import type { Result } from '../contracts/index.js';
import { overlayClientSource } from './overlay-client.js';
import {
  OVERLAY_CLIENT_PATH,
  OVERLAY_REFRESH_EVENT,
  makeConfigBackedOverlayRun,
  makeOverlayHost,
  type Middleware,
  type OverlayFactoryPorts,
  type OverlayFromConfigOptions,
  type ResolvedServerAddress,
  type UsablHttpServer,
} from './overlay-host.js';

// The shared pieces moved to overlay-host.ts. They stay importable from here for existing callers.
export {
  isRequestFromDevOrigin,
  makeResultCache,
  projectOverlay,
  type OverlayProjection,
  type ResultCache,
} from './overlay-host.js';

export type UsablVitePluginFromConfigOptions = OverlayFromConfigOptions;

function overlayClientModuleSource(): string {
  return [
    "import { createHotContext as __vite__createHotContext } from '/@vite/client';",
    `import.meta.hot = __vite__createHotContext('${OVERLAY_CLIENT_PATH}');`,
    overlayClientSource,
  ].join('\n');
}

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
  httpServer?: UsablHttpServer | null;
  config?: { server?: ResolvedServerAddress };
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

function injectLoader(html: string): string {
  const loader = [
    '<script type="module">',
    "const search = new URLSearchParams(window.location.search);",
    "if (!navigator.webdriver && search.get('usabl') !== 'off') {",
    `  import('${OVERLAY_CLIENT_PATH}').catch(() => {});`,
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
  // Where the reason for a failed run goes. See OverlayHostOptions.logError.
  logError?: (error: unknown) => void;
  // Where a warning for the developer goes. See OverlayHostOptions.logWarning.
  logWarning?: (message: string) => void;
}): UsablVitePlugin {
  const host = makeOverlayHost({
    run: opts.run,
    ...(opts.workspaceRoot === undefined ? {} : { workspaceRoot: opts.workspaceRoot }),
    ...(opts.onClose === undefined ? {} : { onClose: opts.onClose }),
    ...(opts.logError === undefined ? {} : { logError: opts.logError }),
    ...(opts.logWarning === undefined ? {} : { logWarning: opts.logWarning }),
    clientModuleSource: overlayClientModuleSource,
    defaultPort: DEFAULT_DEV_PORT,
  });
  let injectSourceAttributes = false;

  return {
    // We keep a minimal plugin shape so host apps provide Vite, and this package stays engine-focused.
    name: 'usabl-overlay',
    // Run before the host's JSX transform (for example @vitejs/plugin-react). That plugin rewrites
    // "<button>" into jsx() calls, so our string-level source injector must see the raw JSX first,
    // or it finds no tags to annotate and jump-to-source never gets a line.
    enforce: 'pre',
    configResolved(config) {
      injectSourceAttributes = config.command === 'serve';
      host.applyServerConfig(config.server);
    },
    configureServer(server) {
      host.setHttpServer(server.httpServer ?? null);
      if (server.config?.server !== undefined) {
        host.applyServerConfig(server.config.server);
      }
      server.middlewares.use(host.middleware);
      host.setNotify(() => {
        server.ws.send({ type: 'custom', event: OVERLAY_REFRESH_EVENT });
      });

      if (server.watcher !== undefined) {
        server.watcher.on('change', host.scheduleRefresh);
        server.watcher.on('add', host.scheduleRefresh);
        server.watcher.on('unlink', host.scheduleRefresh);
      }

      // Close the warm browser when the dev server stops. closeBundle is the backstop for hosts with
      // no httpServer, and the host guards against running the teardown twice.
      if (server.httpServer !== undefined && server.httpServer !== null) {
        server.httpServer.on('close', () => {
          void host.close();
        });
      }
    },
    transformIndexHtml(html) {
      // webdriver and usabl=off prevent the engine and Playwright oracles from grading the badge itself.
      return injectLoader(html);
    },
    transform(code, id) {
      if (!injectSourceAttributes) {
        return null;
      }
      const injected = host.transformSource(code, id);
      return injected === null ? null : { code: injected, map: null };
    },
    async closeBundle() {
      await host.close();
    },
  };
}

export function usablVitePluginFromConfig(
  opts: UsablVitePluginFromConfigOptions = {},
  ports: Partial<OverlayFactoryPorts> = {},
): UsablVitePlugin {
  const engine = makeConfigBackedOverlayRun(opts, ports);
  return usablVitePlugin({
    workspaceRoot: engine.workspaceRoot,
    run: engine.run,
    onClose: engine.onClose,
    logError: engine.logError,
  });
}

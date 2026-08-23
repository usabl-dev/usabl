/**
 * Advisory Vite overlay plugin that projects an existing Result inside host apps.
 * This unit serves read-only overlay assets and never gates a run.
 * It must never convert advisory display state into process exits.
 */
import type { Result } from '../contracts/index.js';
import { frameUntrusted, scrubResult } from './scrub.js';
import { overlayClientSource } from './overlay-client.js';

export interface OverlayProjection {
  advisory: true;
  displayExitCode: 0;
  verdict: Result['verdict'];
  schemaVersion: Result['schemaVersion'];
  summary: string;
  findings: Array<{ rule: string; whatUserExperiences: string; why: string; fix: string }>;
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

export function projectOverlay(result: Result): OverlayProjection {
  // Overlay is advisory only, so displayExitCode stays 0 even when the gated Result blocked.
  const safe = scrubResult(result);
  return {
    advisory: true,
    displayExitCode: 0,
    verdict: safe.verdict,
    schemaVersion: safe.schemaVersion,
    summary: safe.summary,
    findings: safe.findings.map((finding) => ({
      rule: finding.rule,
      whatUserExperiences: frameUntrusted(finding.whatUserExperiences),
      why: finding.why,
      fix: finding.fix,
    })),
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

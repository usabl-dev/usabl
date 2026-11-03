/**
 * Request filtering for the judge's isolated browser.
 *
 * In the judge the page is the pull request's own build, so its script is untrusted. The browser
 * may only reach the app origin the trusted configuration scans, plus origins that same trusted
 * configuration lists in judge.allowOrigins. Everything else is aborted before it leaves the
 * browser. A request that needs no network (data:, blob:, about:) is left alone.
 *
 * This is request filtering inside Chromium, on top of the Chromium sandbox. It is not full
 * network confinement: a renderer escape would sit outside both, and WebRTC and DNS prefetch are
 * not routed at all.
 */
import { parseUsablConfig } from '../intake/config.js';

const NO_NETWORK_SCHEMES = new Set(['data:', 'blob:', 'about:']);

// What the browser driver needs to isolate one run: the allowed origins, and a callback for the
// run's total count of blocked requests.
export interface BrowserIsolation {
  allowedOrigins: ReadonlySet<string>;
  onBlocked(url: string): void;
}

export function decideRequest(allowedOrigins: ReadonlySet<string>, url: string): 'allow' | 'block' {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'block';
  }
  if (NO_NETWORK_SCHEMES.has(parsed.protocol)) {
    return 'allow';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'block';
  }
  return allowedOrigins.has(parsed.origin) ? 'allow' : 'block';
}

// Request routing never sees a WebSocket, so a socket is judged on its own. It may reach only the
// host and port of an allowed origin, over ws for an http origin and wss for an https one.
const SOCKET_SCHEMES: Record<string, string> = { 'ws:': 'http:', 'wss:': 'https:' };

export function decideWebSocket(allowedOrigins: ReadonlySet<string>, url: string): 'allow' | 'block' {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'block';
  }
  const scheme = SOCKET_SCHEMES[parsed.protocol];
  if (scheme === undefined) {
    return 'block';
  }
  return allowedOrigins.has(`${scheme}//${parsed.host}`) ? 'allow' : 'block';
}

// What a coverage gap says about a blocked request: its origin only. The path and query are
// page-chosen and can carry anything, so they never reach a report.
export function blockedOriginLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'null' ? parsed.protocol : parsed.origin;
  } catch {
    return 'an unparseable URL';
  }
}

function originOf(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * The origins the judge's browser may reach, read from trusted-ref bytes only: the app origin and
 * judge.allowOrigins from usabl.config.json, and the docs origin from usabl.docs.json when there
 * is one. A missing or unreadable trusted config allows nothing, so every screen becomes a
 * coverage gap rather than being scanned against an origin the head chose.
 */
export function allowedOriginsFrom(trustedConfigRaw: string | null, trustedDocsRaw: string | null): string[] {
  const origins = new Set<string>();
  if (trustedConfigRaw !== null) {
    try {
      const config = parseUsablConfig(trustedConfigRaw);
      const app = originOf(config.appBaseUrl);
      if (app !== null) origins.add(app);
      for (const entry of config.judge?.allowOrigins ?? []) {
        const origin = originOf(entry);
        if (origin !== null) origins.add(origin);
      }
    } catch {
      return [];
    }
  } else {
    return [];
  }
  if (trustedDocsRaw !== null) {
    try {
      const docs: unknown = JSON.parse(trustedDocsRaw);
      const origin = originOf(docs !== null && typeof docs === 'object' ? Reflect.get(docs, 'docsBaseUrl') : undefined);
      if (origin !== null) origins.add(origin);
    } catch {
      // An unreadable docs manifest adds nothing. The run itself reports it.
    }
  }
  return [...origins];
}

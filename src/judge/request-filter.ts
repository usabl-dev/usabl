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
 * not routed at all. A redirect hop is not routed either, so it cannot be stopped here; it is
 * checked when the browser reports it, and a hop outside the allowed origins, or a response from
 * an address the URL should not reach, makes the screen a coverage gap.
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

// The server address a response came from, as the browser reports it.
export interface ServerAddress {
  ipAddress: string;
  port: number;
}

function ipVersion(text: string): 0 | 4 | 6 {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return 4;
  return text.includes(':') ? 6 : 0;
}

// An IPv4-mapped IPv6 address is the IPv4 address it carries.
function normalizeIp(text: string): string {
  const bare = text.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(\.\d{1,3}){3})$/.exec(bare);
  return mapped?.[1] ?? bare;
}

function isLoopbackIp(ip: string): boolean {
  return ip === '::1' || ip.startsWith('127.');
}

// Loopback, private, link-local, shared, unspecified, multicast, and unique local addresses. A
// public hostname must not be answered from any of them.
function isNonPublicIp(ip: string): boolean {
  if (ipVersion(ip) === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || ip.startsWith('ff');
}

/**
 * Whether a response came from the server its URL should reach. An allowed origin given by an IP
 * address must be answered by that address and port. localhost must be answered on loopback, on
 * its port. Any other hostname must be answered by a public address on its port, so an allowed
 * hostname whose DNS answer points at a loopback or private service, or a loopback origin that
 * another port answered, is caught. A response that did not come from the network has nothing to
 * check.
 */
export function decideServerAddress(
  allowedOrigins: ReadonlySet<string>,
  url: string,
  address: ServerAddress,
): 'expected' | 'unexpected' {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'unexpected';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'expected';
  }
  if (!allowedOrigins.has(parsed.origin)) {
    return 'unexpected';
  }
  const port = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port);
  if (address.port !== port) {
    return 'unexpected';
  }
  const ip = normalizeIp(address.ipAddress);
  const host = normalizeIp(parsed.hostname);
  if (ipVersion(host) !== 0) {
    return ip === host ? 'expected' : 'unexpected';
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return isLoopbackIp(ip) ? 'expected' : 'unexpected';
  }
  return ipVersion(ip) !== 0 && !isNonPublicIp(ip) ? 'expected' : 'unexpected';
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

/**
 * The per-screen readiness signal: positive evidence that this screen really rendered.
 *
 * A surface can declare a reachedWhen signal with up to two parts, and every declared part has to
 * hold:
 *
 *   selector  a CSS selector that must match at least one element in the rendered page;
 *   response  a URL path that a fetch or XHR request to the application's own host must have
 *             answered with a 2xx status.
 *
 * This is the opposite of inferring a blank page from what two screens have in common, and of the
 * session heuristics in redirected.ts, which look for signs of a sign-in page. A sign-in page that
 * makes no API call and has no password field (a passkey prompt, a magic-link page), and an
 * authentication wall that answers 200 to everything, give those heuristics nothing to see. They
 * still fail a signal, because none of them renders this screen's own content or asks for this
 * screen's own data.
 *
 * The signal is general on purpose. It answers "did this screen render", not "is the session
 * alive", so anything that needs that answer can use it.
 *
 * Every part is measured as a plain presence test, so nothing that leans on it can depend on how
 * many nodes matched, on DOM iteration order, or on the order responses arrived in.
 *
 * Each part reads as a tri-state:
 *   null  = the part was not declared, so no claim is made.
 *   true  = the part was declared and held.
 *   false = the part was declared and did not hold, so the screen did not show what the operator
 *           said proves it loaded.
 *
 * A probe that fails reads as false, never as true. A malformed selector cannot match anything, and
 * a response record that cannot be read has shown nothing. Either way the screen becomes a gap
 * rather than a pass, and the gap names the part, which is what the operator needs to fix it.
 */
import type { ApiResponse, Page, ReachedWhenSignal } from '../contracts/index.js';
import { appHostname, isAppHost, requestHostname } from './app-host.js';

/** A declared signal with both parts spelled out. Null means the part was not declared. */
export interface ReadinessSignal {
  selector: string | null;
  response: string | null;
}

/** What one measurement of a signal found, part by part. */
export interface ReadinessMeasurement {
  selectorPresent: boolean | null;
  responseSeen: boolean | null;
}

/**
 * The declared signal in one shape. The string form of reachedWhen is a selector on its own, which
 * is the shape every config written before the object form existed uses.
 */
export function readinessSignalOf(reachedWhen: string | ReachedWhenSignal | undefined): ReadinessSignal | null {
  if (reachedWhen === undefined) {
    return null;
  }
  if (typeof reachedWhen === 'string') {
    return { selector: reachedWhen, response: null };
  }
  return { selector: reachedWhen.selector ?? null, response: reachedWhen.response ?? null };
}

/**
 * Whether the signal held as a whole: null when nothing was declared, true only when every declared
 * part held, false when any declared part did not.
 */
export function readinessMet(measured: ReadinessMeasurement): boolean | null {
  const parts = [measured.selectorPresent, measured.responseSeen].filter((part) => part !== null);
  if (parts.length === 0) {
    return null;
  }
  return parts.every((part) => part === true);
}

/**
 * The configured path in the form a browser puts on the wire. URL parsing percent-encodes what a
 * request line cannot carry, so a path written with a non-ASCII letter compares equal to the
 * request the browser actually sent for it.
 */
function encodedPath(path: string): string | null {
  try {
    return new URL(path, 'http://usabl.invalid').pathname;
  } catch {
    return null;
  }
}

function pathContinues(requestPath: string, declared: string): boolean {
  if (requestPath === declared) {
    return true;
  }
  const prefix = declared.endsWith('/') ? declared : `${declared}/`;
  return requestPath.startsWith(prefix);
}

/**
 * Whether the declared response path was answered with a success on the application's own host.
 *
 * Host: the appBaseUrl hostname or a subdomain of it, on any scheme and port, the same match the
 * refused-request rule uses. A third-party service answering a request with the same path must not
 * stand in for this screen. When appBaseUrl cannot be read there is no host to match, and nothing
 * counts: the screen becomes a gap, which is the safe direction for a positive signal.
 *
 * Path: the request path equals the declared path, or continues it after a slash. So "/api/users"
 * matches "/api/users", "/api/users?page=2", and "/api/users/42", and does not match
 * "/api/users-archive". The query string is never compared.
 *
 * Status: 200 to 299 only. A refusal, a redirect, and a server error are not the screen's data.
 *
 * Exported so the rule can be held without a browser.
 */
export function responseSignalSeen(
  responses: readonly ApiResponse[],
  declaredPath: string,
  appBaseUrl: string,
): boolean {
  const appHost = appHostname(appBaseUrl);
  const declared = encodedPath(declaredPath);
  if (appHost === null || declared === null) {
    return false;
  }
  return responses.some((response) => {
    if (response.status < 200 || response.status > 299) {
      return false;
    }
    const host = requestHostname(response.url);
    if (host === null || !isAppHost(host, appHost)) {
      return false;
    }
    return pathContinues(new URL(response.url).pathname, declared);
  });
}

/**
 * Measure the selector part on its own. Kept as its own export because the password-field rule
 * and older callers ask only this question.
 */
export async function measureReachability(
  page: Page,
  reachedWhen: string | undefined,
): Promise<boolean | null> {
  if (reachedWhen === undefined) {
    return null;
  }
  try {
    const matches = await page.queryAll(reachedWhen);
    return matches.length > 0;
  } catch {
    return false;
  }
}

/** Read the page's data responses. A record that cannot be read is an empty one. */
export async function readApiResponses(page: Page): Promise<ApiResponse[]> {
  try {
    const responses = await page.apiResponses();
    return Array.isArray(responses)
      ? responses.filter(
          (response) =>
            typeof response === 'object' &&
            response !== null &&
            typeof response.url === 'string' &&
            typeof response.status === 'number',
        )
      : [];
  } catch {
    return [];
  }
}

/**
 * Measure every declared part of a signal against the live page, at one moment.
 */
export async function measureReadiness(
  page: Page,
  signal: ReadinessSignal | null,
  appBaseUrl: string,
): Promise<ReadinessMeasurement> {
  const selectorPresent = await measureReachability(page, signal?.selector ?? undefined);
  const responseSeen =
    signal === null || signal.response === null
      ? null
      : responseSignalSeen(await readApiResponses(page), signal.response, appBaseUrl);
  return { selectorPresent, responseSeen };
}

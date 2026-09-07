/**
 * Detects that a scan did not reach the screen it was asked for, signed in.
 *
 * The failure this closes, measured on a real login-gated application. The scan session expired.
 * usabl scanned what it got back under the requested screen ids, filed the sign-in page's barriers
 * as that screen's barriers, disclosed nothing, and told the gate that all twenty-nine accepted
 * barriers on those screens were resolved. The verdict came back red only because the page it
 * measured happened to carry barriers of its own. A clean one would have produced verified, with a
 * receipt, and a claim that the debt was paid.
 *
 * How that application actually behaves, measured. The browser never leaves the requested address.
 * The single page application renders a blank shell for over five seconds and then swaps a login
 * form in at the same URL: a heading, a text input, a password input, three focusable elements. A
 * scan that settles mid transition sees a partial page. So neither the address nor the password
 * field is reliable on its own here. What is reliable is the network: three of the page's own API
 * calls to identity endpoints answered 401 immediately. The same screen loaded with a working
 * session made nine API calls, all 200, and no 401 at all.
 *
 * THE RULES, and exactly when each fires.
 *
 * Two of them apply only when the operator configured a storage state, because only then has
 * anyone asserted that this scan is signed in. Without that assertion a 401 and a login form are
 * ordinary things for a signed-out visitor to meet, and firing on them would turn every deliberate
 * signed-out scan into a coverage gap.
 *
 * Rule A, refused data requests. Fires when a storage state is configured AND at least one of the
 *   page's own fetch or XHR requests answered 401 between navigation and readiness settling. This
 *   is the primary signal: it is present from the first moment of load, so no render timing can
 *   hide it, and it needs nothing from the address or the DOM. 401 only. 403 means authenticated
 *   and not permitted, which is a state a correctly signed-in scan can legitimately meet.
 *
 * Rule B, a password field anywhere. Fires when a storage state is configured AND at least one
 *   password input exists anywhere in the page: any frame, and inside open shadow roots. The
 *   address is not consulted, because the application that produced this defect never changes it.
 *   A signed-in session has no business being shown a password field.
 *
 * Rule C, redirected to a login page. Fires whether or not a storage state is configured, when the
 *   address the browser ended on differs from the one requested AND a password field is present.
 *   With no session configured this is still the wrong page: usabl was asked to measure one screen
 *   and measured another. With a session configured Rule B already covers it.
 *
 * Address comparison for Rule C normalizes scheme case, host case, default port, and one trailing
 * slash on the path. The query string is ignored, because a login redirect usually adds a return
 * address and a legitimately requested login screen often has one too, so a query difference
 * separates nothing. The fragment IS compared, because hash routers keep the whole route there and
 * ignoring it would leave every hash-routed application uncovered by Rule C.
 *
 * FALSE POSITIVES, which this can produce.
 *
 * Rule A fires on any refused fetch or XHR, including one to a third party whose own credentials
 * are stale while the application session is fine. Rule B fires on a signed-in screen that really
 * does contain a password field, such as a change-password form or a re-authentication prompt on a
 * settings page. Rule C fires on a screen reached at a different path or fragment than the one
 * configured that also shows a password field, which in practice is a stale configured URL. In all
 * three the cost is a coverage gap, so the run reports not_covered rather than a verdict, and the
 * fix is to correct the surface URL or to declare a reachedWhen selector for that screen.
 *
 * FALSE NEGATIVES, which matter more and are real.
 *
 * A server-rendered login page that makes no API calls and carries no password input is not caught
 * by any rule here: a passkey prompt, a magic-link page, an email-first identity provider, or a
 * consent screen. An authentication wall that answers 200 to everything and renders a branded
 * landing page is not caught either. A login page served at the very address that was requested,
 * with no session configured, cannot be told from the screen itself. The body-only detector in
 * coverage/unseen.ts catches the subset of these that render nothing focusable; the rest stay open.
 * A miss leaves the behaviour that was there before, so it never manufactures a new false green,
 * and the reachedWhen selector on a surface is the operator's positive assertion for a screen where
 * these heuristics are not enough.
 *
 * This unit reports coverage. It must never mint a verdict.
 */
import type { CoverageGap, Page } from '../contracts/index.js';
import { STORAGE_STATE_ENV_VAR } from '../deps/session.js';

/**
 * A password input is the strongest generic sign-in signal a page can carry. It is one element
 * type defined by the HTML specification, so it needs no framework knowledge, no wordlist, and no
 * guess about the application's routing. Every other candidate signal is weaker: a URL containing
 * "login" is a naming convention, a "Sign in" string is language dependent, and a form action is
 * whatever the application chose.
 */
const PASSWORD_INPUT_SELECTOR = 'input[type="password"]';

export interface LandingObservation {
  /** The address the scan asked for, from operator config. */
  requestedUrl: string;
  /** The address the browser reported. Null when the page could not answer, so no claim is made. */
  landedUrl: string | null;
  /** Whether a password input was anywhere in the page. False when the probe could not run. */
  passwordFieldPresent: boolean;
  /** URLs of the page's own fetch or XHR requests that answered 401 during load. */
  unauthorizedApiUrls: string[];
  /**
   * Whether the operator configured a storage state for this run. Rules A and B are claims about
   * a session that was asserted and did not work, so without the assertion they say nothing.
   */
  sessionConfigured: boolean;
}

/**
 * Read the facts the rules need, while the live page is in hand.
 *
 * Every read fails soft. A page that cannot report its address, a count that throws, and a
 * network record that cannot be fetched are all absence of evidence, and absence of evidence must
 * never raise a gap: the caller would then drop a real screen's findings over a browser hiccup.
 * Every soft failure lands on "no claim".
 */
export async function observeLanding(
  page: Page,
  requestedUrl: string,
  sessionConfigured: boolean,
): Promise<LandingObservation> {
  let landedUrl: string | null = null;
  try {
    const reported = await page.currentUrl();
    landedUrl = typeof reported === 'string' && reported.trim().length > 0 ? reported : null;
  } catch {
    landedUrl = null;
  }
  let passwordFieldPresent = false;
  try {
    passwordFieldPresent = (await page.countEverywhere(PASSWORD_INPUT_SELECTOR)) > 0;
  } catch {
    passwordFieldPresent = false;
  }
  let unauthorizedApiUrls: string[] = [];
  try {
    const refused = await page.unauthorizedApiRequests();
    unauthorizedApiUrls = Array.isArray(refused) ? refused.filter((url) => typeof url === 'string') : [];
  } catch {
    unauthorizedApiUrls = [];
  }
  return { requestedUrl, landedUrl, passwordFieldPresent, unauthorizedApiUrls, sessionConfigured };
}

/**
 * The comparable form of an address: origin, path with one trailing slash removed, and fragment.
 * Returns null when the string is not a URL this can parse, which the caller falls back from.
 */
function normalizeUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const path =
    parsed.pathname.length > 1 && parsed.pathname.endsWith('/')
      ? parsed.pathname.slice(0, -1)
      : parsed.pathname;
  return `${parsed.origin}${path.length === 0 ? '/' : path}${parsed.hash}`;
}

/**
 * An address as it is safe to print: scheme, host, port, and path, and nothing else.
 *
 * Three parts of a URL can hold a credential and all three are removed. The userinfo carries HTTP
 * basic credentials as `user:password@host`, which is how a lab or a preview environment is often
 * reached. The query can carry a return address, a CSRF nonce, or an OAuth authorization code. The
 * fragment carries a live access token in the OAuth implicit flow.
 *
 * This is applied to the requested URL as well as the landing URL. The requested URL comes from
 * operator config, which is usually harmless, but "usually" is not a property to publish on: an
 * operator can put a basic-auth credential or a preview token in a configured surface URL, and this
 * text is rendered by the CLI, the overlay, and the pull request comment.
 *
 * Exported so surfaces and tests can hold the one definition rather than each writing their own.
 */
export function sanitizeUrlForDisplay(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'an address usabl could not parse';
  }
  // Rebuilt from the parsed URL rather than assembled from origin and path, so a scheme with no
  // ordinary origin still prints as itself instead of the string "null" and a path.
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function gapFor(requestedUrl: string, reason: string): CoverageGap {
  return {
    // The configured surface URL, verbatim. The overlay attributes a gap to a screen by matching
    // this against the scan target exactly, and every other gap in the result uses the operator's
    // own configured value, so a sanitized ref here would silently orphan the gap. Nothing is
    // published from this field that the operator did not put in their own config file; the
    // reason below is where the sanitized form goes.
    ref: requestedUrl,
    state: 'not-covered',
    reason,
  };
}

// One closing sentence for all three rules, so an operator meets the same instruction wherever the
// detection came from.
const SESSION_ADVICE =
  `The usual cause is a missing or expired ${STORAGE_STATE_ENV_VAR} session. Mint a new session, ` +
  `point ${STORAGE_STATE_ENV_VAR} at it, and run usabl again.`;

function notMeasured(screenId: string): string {
  return (
    `usabl did not measure ${screenId}: it reports no findings for it and confirms no accepted ` +
    'barrier on it as resolved.'
  );
}

/**
 * Judge one observation. Returns the coverage gap when the screen was not reached signed in, or
 * null when there is no case to answer.
 *
 * Pure, so every rule can be held in tests without a browser. The gap is `not-covered`, the state
 * the codebase already uses for a surface that was in scope and could not be exercised. That state
 * is what the gate reads as unverified, and a screen carrying any gap is excluded from the
 * cleanly-scanned set run() hands the gate, which is what stops a floored barrier on this screen
 * from being claimed as paid down.
 *
 * Rule order is A, then B, then C. It only decides which sentence an operator reads when more than
 * one rule holds, and the most specific evidence goes first: a refused request names an endpoint,
 * a password field names only itself.
 */
export function redirectedAwayGap(screenId: string, observation: LandingObservation): CoverageGap | null {
  const requested = sanitizeUrlForDisplay(observation.requestedUrl);

  // Rule A: the page's own data requests were refused as unauthenticated.
  const refused = observation.unauthorizedApiUrls;
  if (observation.sessionConfigured && refused.length > 0) {
    const example = sanitizeUrlForDisplay(refused[0] as string);
    const count = refused.length;
    return gapFor(
      observation.requestedUrl,
      `usabl asked for ${requested} with a configured session, and ${count} of the page's own data ` +
        `request${count === 1 ? '' : 's'} came back 401, meaning the server did not accept the ` +
        `session as authenticated. One of them was ${example}. Whatever rendered is what a refused ` +
        `visitor sees, not this screen, so ${notMeasured(screenId)} Addresses are shown without ` +
        'their sign-in credentials, query string, or fragment, because any of the three can carry ' +
        `a token. ${SESSION_ADVICE}`,
    );
  }

  // Rule B: a password field anywhere, with a session asserted.
  if (observation.sessionConfigured && observation.passwordFieldPresent) {
    return gapFor(
      observation.requestedUrl,
      `usabl asked for ${requested} with a configured session and the page it got asks for a ` +
        'password, in this document, a frame of it, or a component inside it. A signed-in session ' +
        `is never shown a password field, so this is a sign-in page and ${notMeasured(screenId)} ` +
        'The address is shown without its sign-in credentials, query string, or fragment, because ' +
        `any of the three can carry a token. ${SESSION_ADVICE}`,
    );
  }

  // Rule C: the browser ended somewhere else and that somewhere asks for a password.
  if (observation.landedUrl === null || !observation.passwordFieldPresent) {
    return null;
  }
  const requestedKey = normalizeUrl(observation.requestedUrl);
  const landedKey = normalizeUrl(observation.landedUrl);
  // When either address will not parse, fall back to comparing the raw strings. That is stricter
  // than parsing, not looser, and the password condition still has to hold.
  const sameScreen =
    requestedKey !== null && landedKey !== null
      ? requestedKey === landedKey
      : observation.requestedUrl.trim() === observation.landedUrl.trim();
  if (sameScreen) {
    return null;
  }
  const landing = sanitizeUrlForDisplay(observation.landedUrl);
  return gapFor(
    observation.requestedUrl,
    `usabl asked for ${requested} and the browser was redirected away, ending on ${landing}, ` +
      `which asks for a password. That is a sign-in page and not this screen, so ${notMeasured(screenId)} ` +
      'Addresses are shown without their sign-in credentials, query string, or fragment, because ' +
      `any of the three can carry a token. ${SESSION_ADVICE}`,
  );
}

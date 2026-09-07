/**
 * Redirect detection for one screen: did the browser end up somewhere that is not the screen
 * usabl asked for, and does that somewhere look like a sign-in page.
 *
 * The failure this closes, measured on a real login-gated application. The session expired, so
 * every screen request answered with the application's own login page. usabl scanned that login
 * page, filed its findings under the screen ids it had asked for, disclosed nothing, and told the
 * gate that all twenty-nine accepted barriers on those screens were resolved. The verdict came
 * back red only because the login page happened to carry barriers of its own. A clean login page
 * would have produced verified, with a receipt, and a claim that the debt was paid.
 *
 * The rule, stated so it can be attacked. A screen is redirected away when BOTH hold:
 *
 *   1. The address the browser ended on is not the address that was requested, after normalizing
 *      scheme case, host case, default port, and one trailing slash on the path. Query string is
 *      ignored; fragment is compared.
 *   2. The page carries at least one password input.
 *
 * Both, never either. Condition 1 alone fires on ordinary and correct redirects: a bare path that
 * settles to a canonical one, a locale prefix, an added query parameter, a same-screen hash. Those
 * still land on the intended screen and must be scanned normally. Condition 2 alone fires on the
 * sign-in screen an operator deliberately listed as a surface, which is a real screen with a real
 * password field and must be measured like any other. Requiring both means the only thing that
 * fires is a request for one screen that arrived at a different page asking for a password.
 *
 * Why query is ignored and fragment is not. A login redirect usually keeps a return address in the
 * query (`?next=/users`), and a legitimately requested login screen often gains one too, so a query
 * difference separates nothing. The fragment is different: hash routers keep the whole route there,
 * so `#/users` becoming `#/login` is the redirect, and ignoring it would leave every hash-routed
 * application uncovered by this check.
 *
 * False positives, which this rule can produce. A screen that is genuinely reached but reached at
 * a different fragment or path than the one configured, and that also shows a password field, is
 * called redirected. In practice that is a change-password or re-authenticate screen listed under
 * a stale URL. The cost is a coverage gap on that screen, so the run reports not_covered instead
 * of a verdict it should not have minted anyway, and the fix is to correct the configured URL.
 *
 * False negatives, which matter more and are real. A sign-in page with no password input is not
 * caught: an identity provider that asks for an email first, a passkey or magic-link page, or a
 * consent screen. A tenant that answers an unauthenticated request with its own branded landing
 * page and no login form is not caught. And a redirect that lands on a login page at the very
 * address that was requested cannot be told apart from the screen itself. The body-only detector
 * in coverage/unseen.ts catches the subset of these that render nothing focusable; the rest stay
 * open. Nothing here claims a screen was measured, so a miss leaves the previous behaviour and
 * never manufactures a new false green of its own.
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
  /** Whether a password input was in the rendered page. False when the probe could not run. */
  passwordFieldPresent: boolean;
}

/**
 * Read the two facts the rule needs, while the live page is in hand.
 *
 * Both reads fail soft. A page that cannot report its address and a query that throws are both
 * absence of evidence, and absence of evidence must not raise a gap: the caller would then have
 * dropped a real screen's findings over a browser hiccup. Every soft failure lands on "no claim".
 */
export async function observeLanding(page: Page, requestedUrl: string): Promise<LandingObservation> {
  let landedUrl: string | null = null;
  try {
    const reported = await page.currentUrl();
    landedUrl = typeof reported === 'string' && reported.trim().length > 0 ? reported : null;
  } catch {
    landedUrl = null;
  }
  let passwordFieldPresent = false;
  try {
    passwordFieldPresent = (await page.queryAll(PASSWORD_INPUT_SELECTOR)).length > 0;
  } catch {
    passwordFieldPresent = false;
  }
  return { requestedUrl, landedUrl, passwordFieldPresent };
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
 * The landing address as it is safe to print: origin and path only.
 *
 * The query string and the fragment are dropped on purpose. A sign-in redirect can carry a return
 * address, a CSRF nonce, or an authorization code in the query, and the OAuth implicit flow puts a
 * live access token in the fragment. This gap reason is rendered by the CLI, the overlay, and the
 * pull request comment, so nothing that can hold a credential may reach it. Origin and path are
 * enough to tell an operator where the browser went.
 */
function landingLabel(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'an address usabl could not parse';
  }
  // Rebuilt from the parsed URL rather than assembled from origin and path, so a scheme with no
  // ordinary origin still prints as itself instead of the string "null" and a path.
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

/**
 * Judge one observation. Returns the coverage gap when the screen was not measured, or null when
 * there is no case to answer.
 *
 * Pure, so the rule can be held in tests without a browser. The gap is `not-covered`, which is the
 * state the codebase already uses for a surface that was in scope and could not be exercised. That
 * state is what the gate reads as unverified, and a screen carrying any gap is excluded from the
 * cleanly-scanned set that run() hands the gate, which is what stops a floored barrier on this
 * screen from being claimed as paid down.
 */
export function redirectedAwayGap(screenId: string, observation: LandingObservation): CoverageGap | null {
  if (observation.landedUrl === null || !observation.passwordFieldPresent) {
    return null;
  }
  const requested = normalizeUrl(observation.requestedUrl);
  const landed = normalizeUrl(observation.landedUrl);
  // When either address will not parse, fall back to comparing the raw strings. That is stricter
  // than parsing, not looser, and the password condition still has to hold.
  const sameScreen =
    requested !== null && landed !== null
      ? requested === landed
      : observation.requestedUrl.trim() === observation.landedUrl.trim();
  if (sameScreen) {
    return null;
  }
  const landing = landingLabel(observation.landedUrl);
  return {
    ref: observation.requestedUrl,
    state: 'not-covered',
    reason:
      `usabl asked for ${observation.requestedUrl} and the browser was redirected away, ending on ` +
      `${landing}, which asks for a password. That is a sign-in page and not this screen, so usabl ` +
      `did not measure ${screenId}: it reports no findings for it and confirms no accepted barrier ` +
      'on it as resolved. The landing address is shown without its query string or fragment, ' +
      'because either can carry a session token. The usual cause is a missing or expired ' +
      `${STORAGE_STATE_ENV_VAR} session. Mint a new session, point ${STORAGE_STATE_ENV_VAR} at it, ` +
      'and run usabl again.',
  };
}

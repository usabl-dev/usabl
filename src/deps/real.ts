/// <reference lib="dom" />
/**
 * Real BrowserDriver backed by Playwright + CDP accessibility reads.
 * This unit never mints a verdict, never approximates names from the DOM, and never hides AX read failures.
 * Missing or ignored AX nodes stay null so downstream layers disclose not-covered and unverified honestly.
 */
import { AxeBuilder } from '@axe-core/playwright';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page as PwPage } from 'playwright';
import type { AxNode, BrowserDriver, Page } from '../contracts/index.js';
import { applyAxeTags, type AxeIssue, type AxeRuleSummary } from '../providers/axe/index.js';

// Default budget for one screen to navigate, go quiet, and stop rendering. An authenticated
// Ansible Automation Platform screen measured 12.4 s to network idle plus 13.3 s to a DOM that
// stopped changing, and 15 s failed every screen of it. The default clears that 25.7 s by more
// than double, because the same lab is slower under load and the number also has to hold for
// applications nobody has measured yet. Only a page that never settles spends the whole budget,
// and that is already an error path that ends as a disclosed coverage gap rather than a scan.
// An operator whose application needs longer sets readyTimeoutMs in usabl.config.json.
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const CLICK_TIMEOUT_MS = 3_000;
// How often readiness re-reads the page, and how many equal reads in a row mean it stopped changing.
// Four equal reads 500 ms apart is 1.5 seconds of a DOM that is not moving. The window has to
// outlast the pause between two render passes, and a shorter one does not: a 500 ms window measured
// against a page that mounts in two bursts settled on the first burst and reported 3 elements on a
// page that ends at 104, which is the failure this wait exists to prevent. A settled page pays the
// window once, which is small next to the rest of a screen scan.
const SETTLE_SAMPLE_INTERVAL_MS = 500;
const SETTLE_SAMPLES_REQUIRED = 4;
// How long the in-flight request count has to hold at zero before the network counts as quiet.
// This matches Playwright's own networkidle window, so a page that networkidle would have called
// idle still reads as idle here, and the live signal only differs by catching requests that start
// after that first idle.
const NETWORK_QUIET_WINDOW_MS = 500;

// Browser-side path helper used by both document-start injection and adoptPage install.
// Keep this the only implementation: a uniqueness (or any path) fix that lands in one
// copy and misses the other recreates the duplicate-id false green (#182).
// Paths use nth-child ancestry so selectors stay valid and comparable across calls.
// An id is only used as a selector when it is unique in the document; duplicate ids
// fall back to the structural path so set ops keyed on element identity cannot collide.
const PATH_FOR_IMPL = `
  const escapeCss = (value) => {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(value);
    }
    return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\\\' + ch);
  };
  const isUniqueId = (id) => document.querySelectorAll('#' + escapeCss(id)).length === 1;
  const pathFor = (element) => {
    if (!(element instanceof Element)) {
      return '';
    }
    if (element.id && isUniqueId(element.id)) {
      return '#' + escapeCss(element.id);
    }
    const segments = [];
    let current = element;
    while (current instanceof Element) {
      if (current.id && isUniqueId(current.id)) {
        segments.unshift('#' + escapeCss(current.id));
        break;
      }
      const parent = current.parentElement;
      if (!parent) {
        segments.unshift(current.tagName.toLowerCase());
        break;
      }
      let index = 1;
      let sibling = current.previousElementSibling;
      while (sibling instanceof Element) {
        index += 1;
        sibling = sibling.previousElementSibling;
      }
      segments.unshift(current.tagName.toLowerCase() + ':nth-child(' + String(index) + ')');
      current = parent;
    }
    return segments.join(' > ');
  };
`;

// Inject before app scripts run so the first live update is observable and not lost.
// Late injection would under-report announcements and create a false sense of coverage.
export const LIVE_AND_PATH_INIT_SCRIPT = `(() => {
  const LIVE = '[aria-live],[role="status"],[role="alert"],[role="log"]';
  const buffer = [];
  const toText = (value) => {
    const normalized = (value ?? '').trim();
    return normalized.length > 0 ? normalized : null;
  };
  const push = (value) => {
    const text = toText(value);
    if (text !== null) {
      buffer.push(text);
    }
  };
  window.__usablDrain = () => buffer.splice(0, buffer.length);
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      const host = target && target.closest ? target.closest(LIVE) : null;
      if (host) {
        push(host.textContent);
      }
    }
  });
  const startObserver = () => {
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver);
  } else {
    startObserver();
  }

  ${PATH_FOR_IMPL}
  window.__usablPathFor = pathFor;
})();`;

// Evaluated after adoptPage attaches to a caller-owned page that already navigated.
// Same PATH_FOR_IMPL as the init script; guarded so re-adopting the same page is a no-op.
export const INSTALL_PATH_HELPER_SCRIPT = `(() => {
  if (typeof window.__usablPathFor === 'function') {
    return;
  }
  ${PATH_FOR_IMPL}
  window.__usablPathFor = pathFor;
})();`;

interface AxeResult {
  violations: AxeIssue[];
  incomplete: AxeIssue[];
  // axe classifies every rule it loaded, not only the ones that produced findings. Keeping the
  // other two buckets is what lets a later reader tell a rule that ran and passed from a rule
  // that never matched anything on this screen.
  passes: AxeRuleSummary[];
  inapplicable: AxeRuleSummary[];
}

function mapAxeCheck(rawCheck: unknown): { data?: unknown } {
  const data = getProp(rawCheck, 'data');
  return data === undefined ? {} : { data };
}

function mapAxeNode(rawNode: unknown): AxeIssue['nodes'][number] {
  const rawTarget = getProp(rawNode, 'target');
  const target = Array.isArray(rawTarget) ? rawTarget.map((entry) => String(entry)) : [];
  const html = readString(getProp(rawNode, 'html'));
  const failureSummary = readString(getProp(rawNode, 'failureSummary'));
  const rawAny = getProp(rawNode, 'any');
  const checks = Array.isArray(rawAny) ? rawAny.map((check) => mapAxeCheck(check)) : [];

  return {
    target,
    ...(html === null ? {} : { html }),
    ...(failureSummary === null ? {} : { failureSummary }),
    ...(checks.length === 0 ? {} : { any: checks }),
  };
}

function mapAxeIssues(rawIssues: unknown): AxeIssue[] {
  if (!Array.isArray(rawIssues)) {
    return [];
  }

  const issues: AxeIssue[] = [];
  for (const rawIssue of rawIssues) {
    const id = readString(getProp(rawIssue, 'id'));
    const description = readString(getProp(rawIssue, 'description'));
    if (id === null || description === null) {
      continue;
    }

    const rawImpact = readString(getProp(rawIssue, 'impact'));
    const impact =
      rawImpact === 'critical' || rawImpact === 'serious' || rawImpact === 'moderate' || rawImpact === 'minor'
        ? rawImpact
        : undefined;

    const rawNodes = getProp(rawIssue, 'nodes');
    const nodes = Array.isArray(rawNodes) ? rawNodes.map((node) => mapAxeNode(node)) : [];

    issues.push({
      id,
      description,
      nodes,
      ...(impact === undefined ? {} : { impact }),
    });
  }

  return issues;
}

/**
 * Maps an axe rule bucket to the light record applicability needs: which rule, and how many
 * elements it matched. Nodes are counted, never mapped, because a passing rule can carry
 * hundreds of them per screen and none of them are evidence of anything.
 *
 * Exported so the mapping can be proven without a browser. Same defensive contract as
 * mapAxeIssues: raw axe output is untyped and input that is not an array yields nothing. Only
 * the rule id is required, because it is the whole identity of the record. Nothing else about
 * the entry is read, so nothing else can decide whether the entry is kept.
 */
export function mapAxeRuleSummaries(rawRules: unknown): AxeRuleSummary[] {
  if (!Array.isArray(rawRules)) {
    return [];
  }

  const summaries: AxeRuleSummary[] = [];
  for (const rawRule of rawRules) {
    const id = readString(getProp(rawRule, 'id'));
    if (id === null) {
      continue;
    }

    // inapplicable entries always arrive with an empty node list, but the length is read rather
    // than assumed so this stays true of whatever bucket it is handed.
    const rawNodes = getProp(rawRule, 'nodes');
    const nodeCount = Array.isArray(rawNodes) ? rawNodes.length : 0;

    summaries.push({ id, nodeCount });
  }

  return summaries;
}

function getProp(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  return Reflect.get(value, key);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function backendNodeIdForSelector(cdp: CDPSession, selector: string): Promise<number | null> {
  const documentTree: unknown = await cdp.send('DOM.getDocument', { depth: -1 });
  const rootNodeId = readNumber(getProp(getProp(documentTree, 'root'), 'nodeId'));
  if (rootNodeId === null) {
    return null;
  }

  const queried: unknown = await cdp.send('DOM.querySelector', { nodeId: rootNodeId, selector });
  const nodeId = readNumber(getProp(queried, 'nodeId'));
  if (nodeId === null || nodeId === 0) {
    return null;
  }

  const described: unknown = await cdp.send('DOM.describeNode', { nodeId });
  return readNumber(getProp(getProp(described, 'node'), 'backendNodeId'));
}

async function backendNodeIdForActiveElement(cdp: CDPSession): Promise<number | null> {
  const evaluated: unknown = await cdp.send('Runtime.evaluate', {
    expression: 'document.activeElement',
    objectGroup: 'usabl-active-node',
    includeCommandLineAPI: false,
  });

  const result = getProp(evaluated, 'result');
  const objectId = readString(getProp(result, 'objectId'));
  if (objectId === null) {
    return null;
  }

  try {
    const described: unknown = await cdp.send('DOM.describeNode', { objectId });
    return readNumber(getProp(getProp(described, 'node'), 'backendNodeId'));
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId }).catch(() => undefined);
  }
}

async function axFromBackendId(cdp: CDPSession, backendNodeId: number): Promise<AxNode | null> {
  // Name and role come from the browser accessibility tree, not DOM text fallbacks.
  // `aria-label || innerText` can diverge from assistive-tech output and would be dishonest.
  const partialTree: unknown = await cdp.send('Accessibility.getPartialAXTree', {
    backendNodeId,
    fetchRelatives: false,
  });
  const nodes = getProp(partialTree, 'nodes');
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return null;
  }

  const firstNode = nodes[0];
  if (getProp(firstNode, 'ignored') === true) {
    return null;
  }

  const states: Record<string, unknown> = {};
  const properties = getProp(firstNode, 'properties');
  if (Array.isArray(properties)) {
    for (const property of properties) {
      const name = readString(getProp(property, 'name'));
      if (name === null) {
        continue;
      }
      states[name] = getProp(getProp(property, 'value'), 'value');
    }
  }

  return {
    name: readString(getProp(getProp(firstNode, 'name'), 'value')),
    role: readString(getProp(getProp(firstNode, 'role'), 'value')),
    states,
  };
}

async function stablePathForActiveElement(pw: PwPage): Promise<string> {
  return pw.evaluate(() => {
    const pathFor = Reflect.get(window, '__usablPathFor');
    if (typeof pathFor !== 'function') {
      return '';
    }
    const active = document.activeElement instanceof Element ? document.activeElement : null;
    return pathFor(active);
  });
}

async function stablePathsForSelector(pw: PwPage, selector: string): Promise<string[]> {
  return pw.evaluate((query) => {
    const pathFor = Reflect.get(window, '__usablPathFor');
    if (typeof pathFor !== 'function') {
      return [];
    }
    return Array.from(document.querySelectorAll(query)).map((element) => pathFor(element));
  }, selector);
}

// The readiness surface of a Playwright page. Narrow on purpose so the wait can be driven by a
// scripted page in tests without a browser.
//
// networkQuietFor reports a live fact: whether the count of in-flight requests has been zero for at
// least windowMs. It is deliberately not waitForLoadState('networkidle'). That lifecycle event
// resolves once per navigation and then returns at once on every later call, so it cannot see a
// request that starts after it first settles, which is the exact miss this fix exists to close.
// Verified against real Chromium: a fetch fired 800ms after load, mounting the rest of the page,
// was invisible to networkidle and caught only by a live in-flight counter.
interface ReadinessPage {
  networkQuietFor(windowMs: number): boolean;
  evaluate(fn: () => number): Promise<number>;
}

/**
 * The readiness budget for a run: the operator's number when the config names one, the engine
 * default otherwise.
 */
export function readyTimeoutMsFor(config: { readyTimeoutMs?: number }): number {
  return config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
}

// The live network signal for readiness.
//
// Playwright's waitForLoadState('networkidle') is a one-shot lifecycle event: it resolves once per
// navigation and then returns at once, so it cannot see a request that starts after the page first
// went idle. That is the exact miss #146 is about. This tracker instead counts requests that are
// actually in flight, from the page request events, and reports whether that count has held at zero
// for a quiet window. It re-evaluates every time it is asked, so a late request is seen.
//
// A request that errors or is aborted fires requestfailed rather than requestfinished, so both
// decrement the count. Without that a failed request would pin the count above zero forever and a
// page with one broken request would never read as idle.
interface NetworkActivity {
  networkQuietFor(windowMs: number): boolean;
}

// The subset of a Playwright page this tracker listens to. Narrow so a test can drive it.
interface RequestEvents {
  on(event: 'request' | 'requestfinished' | 'requestfailed', handler: () => void): void;
}

function makeNetworkActivityTracker(page: RequestEvents, now: () => number = Date.now): NetworkActivity {
  let inFlight = 0;
  // The last instant the count was zero. A page starts idle, so it begins now.
  let idleSince = now();

  const settled = (): void => {
    inFlight = Math.max(0, inFlight - 1);
    if (inFlight === 0) {
      idleSince = now();
    }
  };

  page.on('request', () => {
    inFlight += 1;
  });
  page.on('requestfinished', settled);
  page.on('requestfailed', settled);

  return {
    networkQuietFor(windowMs: number): boolean {
      if (inFlight > 0) {
        return false;
      }
      return now() - idleSince >= windowMs;
    },
  };
}

// "Timeout 15000ms exceeded" does not say whether the network never went quiet or the DOM never
// stopped moving, and those have different fixes: a stuck request against an app or a lab that
// renders slower than the budget allows.
function readinessTimeout(phase: string, timeoutMs: number, detail: string): string {
  return `page ${phase} within ${timeoutMs}ms${detail}; raise readyTimeoutMs in usabl.config.json if this application needs longer`;
}

/**
 * Waits until the DOM has stopped changing and the network has been quiet at the same moment,
 * inside one budget.
 *
 * A client-rendered application mounts after its responses land because render is CPU work, so a
 * page that has only loaded is empty: every tab stop resolves to body and the run would report a
 * clean screen it never saw. Both facts have to hold together, because either one alone lies. A
 * quiet network with a moving DOM is a page still rendering. A still DOM with a request in flight is
 * a page waiting for data that will mount more.
 *
 * Both signals are read live on the same interval. The DOM signal is the total element count, which
 * moves whenever a framework mounts or swaps a subtree, costs one live-collection read in page
 * context, and needs no cooperation from the application. Stability is the test, not volume, so a
 * page that settles at zero elements is ready, because an empty state is a real page. The network
 * signal is whether the in-flight request count has been zero for a full quiet window. Reading it
 * live is the whole point: a request that starts after the page first went idle, the case that used
 * to slip through waitForLoadState, resets the window so the loop keeps waiting.
 *
 * The signals gate each other, which is why neither is run to completion before the other. A
 * request that starts during a DOM pause is caught because the next pass sees the network busy
 * again, and the mounts it triggers are caught because they move the count.
 *
 * The budget is shared. Running out throws, and the message names the phase still unsatisfied,
 * because the fixes differ: a stuck request wants a larger request budget, a slow render wants a
 * larger render budget. The caller discloses that as a coverage gap, which is honest, where
 * returning quietly would publish a measurement of a page that had not arrived.
 *
 * Known limit, stated so a reviewer can attack it (tracked as issue #184): a pause driven purely by
 * client-side work with no request behind it is not covered. The network is genuinely quiet during
 * it, so a client-side pause longer than the DOM window can still read as settled. The threshold is
 * roughly that window, about 1.7 seconds of a frozen count that is also network-idle. Raising
 * readyTimeoutMs does not help, because the loop already believes it is done and has returned rather
 * than run out of budget. Closing this would need the application to signal its own render
 * completion, which this design avoids on purpose so it can measure any application without
 * cooperation.
 *
 * Exported for tests. Product code reaches this through Page.gotoReady().
 */
export async function waitForRendered(pw: ReadinessPage, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  let previous: number | null = null;
  let repeats = 0;
  for (;;) {
    const elements = await pw.evaluate(() => document.getElementsByTagName('*').length);
    repeats = elements === previous ? repeats + 1 : 1;
    previous = elements;

    const domStable = repeats >= SETTLE_SAMPLES_REQUIRED;
    // Read live every pass, so a request that started since the last read resets the window.
    const networkQuiet = pw.networkQuietFor(NETWORK_QUIET_WINDOW_MS);
    if (domStable && networkQuiet) {
      return;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      // Name the phase still unsatisfied. A settled DOM waiting only on the network points the
      // operator at a request budget; otherwise the DOM never stopped and its last count is the
      // useful detail.
      if (domStable && !networkQuiet) {
        throw new Error(readinessTimeout('network activity did not go quiet', timeoutMs, ''));
      }
      throw new Error(
        readinessTimeout('DOM did not stop changing', timeoutMs, `, last element count ${elements}`),
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(SETTLE_SAMPLE_INTERVAL_MS, remaining)));
  }
}

function attachAxeBridge(page: Page, pw: PwPage): void {
  Object.assign(page, {
    runAxe: async (options?: { tags?: readonly string[] }): Promise<AxeResult> => {
      // Tags apply only when the docs profile passes them. No tags means axe keeps its default
      // ruleset, so the app path builds and analyzes exactly as before.
      const builder = applyAxeTags(new AxeBuilder({ page: pw }), options);
      const result = await builder.analyze();
      return {
        violations: mapAxeIssues(result.violations),
        incomplete: mapAxeIssues(result.incomplete),
        passes: mapAxeRuleSummaries(result.passes),
        inapplicable: mapAxeRuleSummaries(result.inapplicable),
      };
    },
  });
}

function wrapPage(
  pw: PwPage,
  context: BrowserContext,
  cdp: CDPSession,
  readyTimeoutMs: number,
  network: NetworkActivity,
): Page {
  // The readiness seam: the DOM read from the page, the network signal from the live tracker.
  const readiness: ReadinessPage = {
    evaluate: (fn) => pw.evaluate(fn),
    networkQuietFor: (windowMs) => network.networkQuietFor(windowMs),
  };
  const page: Page = {
    async gotoReady(): Promise<void> {
      await waitForRendered(readiness, readyTimeoutMs);
    },
    async focusBody(): Promise<void> {
      await pw.evaluate(() => {
        if (!(document.body instanceof HTMLElement)) {
          return;
        }
        if (!document.body.hasAttribute('tabindex')) {
          document.body.setAttribute('tabindex', '-1');
        }
        document.body.focus();
      });
    },
    async tab(): Promise<void> {
      await pw.keyboard.press('Tab');
    },
    async press(key: string): Promise<void> {
      await pw.keyboard.press(key);
    },
    async click(selector: string): Promise<void> {
      await pw.click(selector, { timeout: CLICK_TIMEOUT_MS });
    },
    async activeElementIs(selector: string): Promise<boolean> {
      return pw.evaluate((query) => document.querySelector(query) === document.activeElement, selector);
    },
    async activeElementWithin(selector: string): Promise<boolean> {
      return pw.evaluate((query) => {
        const root = document.querySelector(query);
        return root instanceof Element && root.contains(document.activeElement);
      }, selector);
    },
    async armAnnouncementCapture(): Promise<void> {
      // The init script installs observers at document start, so arming is already complete.
      return Promise.resolve();
    },
    async drainAnnouncements(): Promise<string[]> {
      return pw.evaluate(() => {
        const drain = Reflect.get(window, '__usablDrain');
        if (typeof drain !== 'function') {
          return [];
        }
        const drained = drain();
        if (!Array.isArray(drained)) {
          return [];
        }
        return drained.filter((entry) => typeof entry === 'string');
      });
    },
    async activeNode(): Promise<AxNode | null> {
      const backendNodeId = await backendNodeIdForActiveElement(cdp);
      if (backendNodeId === null) {
        return null;
      }
      return axFromBackendId(cdp, backendNodeId);
    },
    async activePath(): Promise<string> {
      return stablePathForActiveElement(pw);
    },
    async axAt(selector: string): Promise<AxNode | null> {
      const backendNodeId = await backendNodeIdForSelector(cdp, selector);
      if (backendNodeId === null) {
        return null;
      }
      return axFromBackendId(cdp, backendNodeId);
    },
    async getAttribute(selector: string, name: string): Promise<string | null> {
      return pw.locator(selector).getAttribute(name);
    },
    async queryAll(selector: string): Promise<Array<{ selector: string }>> {
      const paths = await stablePathsForSelector(pw, selector);
      return paths.map((path) => ({ selector: path }));
    },
    async close(): Promise<void> {
      await context.close();
    },
    async setViewport(width: number, height: number): Promise<void> {
      await pw.setViewportSize({ width, height });
    },
    async setZoom(percent: number): Promise<void> {
      await pw.evaluate((zoomPercent) => {
        if (document.documentElement instanceof HTMLElement) {
          document.documentElement.style.zoom = `${zoomPercent}%`;
        }
      }, percent);
    },
    async setReducedMotion(enabled: boolean): Promise<void> {
      await pw.emulateMedia({ reducedMotion: enabled ? 'reduce' : 'no-preference' });
    },
    async getComputedStyle(selector: string, property: string): Promise<string> {
      return pw.evaluate(
        ({ query, cssProperty }) => {
          const element = document.querySelector(query);
          if (!(element instanceof Element)) {
            return '';
          }
          return getComputedStyle(element).getPropertyValue(cssProperty);
        },
        { query: selector, cssProperty: property },
      );
    },
    async screenshot(selector?: string): Promise<Buffer> {
      if (selector === undefined) {
        return pw.screenshot();
      }
      return pw.locator(selector).screenshot();
    },
  };

  attachAxeBridge(page, pw);
  return page;
}

/**
 * Adopts a Playwright page a caller already created and navigated, so usabl can run providers on it
 * (for example from a Playwright test suite). It attaches a CDP session for AX reads and installs the
 * path helper, then returns a usabl Page whose close() is a no-op: the caller owns the page and its
 * context, so adoption must never close them. Navigation and readiness are the caller's job.
 *
 * The in-flight tracker starts at adoption, so it counts only requests fired after this call. The
 * one caller today, checkPage in playwright-helper.ts, never calls gotoReady, so this is inert. A
 * future caller that adopts a page mid-load and then calls gotoReady expecting the pre-adoption
 * requests to count would read idle at once and could return on a half-rendered page. Such a caller
 * must adopt before it navigates, or wait for readiness itself.
 */
export async function adoptPage(pw: PwPage): Promise<Page> {
  const context = pw.context();
  const cdp = await context.newCDPSession(pw);
  await cdp.send('Accessibility.enable');
  await pw.evaluate(INSTALL_PATH_HELPER_SCRIPT);
  // The caller already navigated, so this tracker starts counting from adoption forward. A caller
  // that then uses gotoReady gets readiness measured against requests fired after adoption.
  const network = makeNetworkActivityTracker(pw);
  // Adoption has no operator config to read, so a caller that does use gotoReady gets the default.
  const page = wrapPage(pw, context, cdp, readyTimeoutMsFor({}), network);
  return { ...page, close: async (): Promise<void> => {} };
}

/**
 * What one run needs from the browser: the session to open contexts with and the readiness budget.
 * Both belong to a run, not to the browser process, so a browser that lives across runs takes them
 * per run rather than once at launch.
 */
export interface RealBrowserOptions {
  storageStatePath?: string;
  readyTimeoutMs?: number;
}

/**
 * The part of a launched Playwright browser this module uses. Narrow so a test can stand in a fake
 * and drive the launch, disconnect, and relaunch logic without a real Chromium.
 */
export type LaunchedBrowser = Pick<Browser, 'newContext' | 'isConnected' | 'close'>;

/**
 * One browser process shared across runs.
 *
 * driver(options) returns a BrowserDriver view for one run. Every open on that view makes a fresh
 * context from the run's own options, so an authenticated storage state and a readiness budget that
 * change between runs are honored on each open, not frozen at the first launch. The view's close is
 * a no-op: the process belongs to whoever made the shared browser, and only its close ends it.
 *
 * A browser process can die between runs, from an out-of-memory kill, a crash, or an operator
 * closing it. A dead process kept as the reference would fail every later open. So open checks that
 * the process is still connected and relaunches when it is not, and an open that fails with the
 * process gone clears the reference so the next open launches again.
 */
export interface SharedBrowser {
  driver(options?: RealBrowserOptions): BrowserDriver;
  close(): Promise<void>;
}

export function makeSharedBrowser(
  ports: { launch?: () => Promise<LaunchedBrowser>; maxContextFailures?: number } = {},
): SharedBrowser {
  const launch = ports.launch ?? (async (): Promise<LaunchedBrowser> => chromium.launch({ headless: true }));
  // How many newContext failures in a row, with the process still reporting connected, before the
  // process is treated as unusable and replaced. A process can hang or wedge in a way that keeps its
  // connection up while every context request fails, and a reference kept forever would fail every
  // later scan in the dev session.
  const maxContextFailures = ports.maxContextFailures ?? 3;

  let browser: LaunchedBrowser | null = null;
  // One launch at a time. Two opens that both find no process share this promise rather than each
  // launching a process, which would leave one of them running with nothing holding it.
  let launching: Promise<LaunchedBrowser> | null = null;
  // Once closed, stays closed. An open after close rejects rather than launching a new process that
  // nothing would ever close.
  let closed = false;
  let contextFailures = 0;

  const closedError = (): Error =>
    new Error('usabl shared browser is closed; the dev server has shut down and no scan can open a page');

  // Drop a process reference, but only the one the caller saw. A concurrent open may already have
  // replaced it, and that replacement must not be dropped by mistake.
  const discard = async (which: LaunchedBrowser): Promise<void> => {
    if (browser !== which) {
      return;
    }
    browser = null;
    contextFailures = 0;
    // The process may already be gone. close() only releases what is left on this side.
    await which.close().catch(() => undefined);
  };

  const acquire = async (): Promise<LaunchedBrowser> => {
    if (closed) {
      throw closedError();
    }
    if (browser !== null && !browser.isConnected()) {
      await discard(browser);
    }
    if (browser !== null) {
      return browser;
    }
    if (launching === null) {
      launching = launch()
        .then((launched) => {
          browser = launched;
          contextFailures = 0;
          return launched;
        })
        .finally(() => {
          launching = null;
        });
    }
    const launched = await launching;
    if (closed) {
      // close() ran while the launch was in flight. It awaited the same launch and closed the
      // process, so there is nothing to hand out.
      throw closedError();
    }
    return launched;
  };

  const openPage = async (url: string, options: RealBrowserOptions): Promise<Page> => {
    const launched = await acquire();
    const readyTimeoutMs = readyTimeoutMsFor(options);

    let context: Awaited<ReturnType<LaunchedBrowser['newContext']>>;
    try {
      context = await launched.newContext(
        options.storageStatePath === undefined ? {} : { storageState: options.storageStatePath },
      );
    } catch (error) {
      contextFailures += 1;
      // A process that has died, or one that stays connected but cannot make a context any more,
      // is forgotten so the next open launches a fresh one instead of failing forever.
      if (!launched.isConnected() || contextFailures >= maxContextFailures) {
        await discard(launched);
      }
      throw error;
    }
    contextFailures = 0;

    // From here a context exists. Any failure below must close it, or an authenticated page opened
    // from the run's storage state stays alive with nothing holding it.
    try {
      const page = await context.newPage();
      await page.addInitScript(LIVE_AND_PATH_INIT_SCRIPT);
      // Attach the in-flight tracker before navigating, so the navigation's own requests are
      // counted and readiness cannot read idle off a page whose first responses have not landed.
      const network = makeNetworkActivityTracker(page);
      const cdp = await context.newCDPSession(page);
      await cdp.send('Accessibility.enable');
      // open() owns navigation and gotoReady() only waits for readiness. Navigation takes the same
      // budget, so one config number covers the whole cost of reaching a screen.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: readyTimeoutMs });
      return wrapPage(page, context, cdp, readyTimeoutMs, network);
    } catch (error) {
      await context.close().catch(() => undefined);
      // A failure with the process gone means the process died under us. Forget it so the next
      // open relaunches instead of failing against a dead reference. A failure with the process
      // still connected is the page's own problem and the process stays.
      if (!launched.isConnected()) {
        await discard(launched);
      }
      throw error;
    }
  };

  return {
    driver(options = {}) {
      return {
        open: (url: string) => openPage(url, options),
        // The process belongs to the shared browser, not to one run.
        close: async () => {},
      };
    },
    async close(): Promise<void> {
      closed = true;
      if (launching !== null) {
        // A launch is in flight. Wait for it so the process it produces is the one closed here,
        // rather than left running because close() looked before it existed.
        await launching.catch(() => undefined);
      }
      const open = browser;
      browser = null;
      if (open !== null) {
        await open.close();
      }
    },
  };
}

/**
 * One browser for one caller, launched lazily and closed by the same caller. This is the CLI's
 * one-shot shape. It is the shared browser with a single run's options and a close that ends the
 * process, so the two paths cannot drift in how they open a page.
 */
export function makeRealBrowserDriver(
  options: RealBrowserOptions = {},
  ports: { launch?: () => Promise<LaunchedBrowser> } = {},
): BrowserDriver {
  const shared = makeSharedBrowser(ports);
  const view = shared.driver(options);
  return {
    open: (url: string) => view.open(url),
    close: () => shared.close(),
  };
}

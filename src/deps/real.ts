/// <reference lib="dom" />
/**
 * Real BrowserDriver backed by Playwright + CDP accessibility reads.
 * This unit never mints a verdict, never approximates names from the DOM, and never hides AX read failures.
 * Missing or ignored AX nodes stay null so downstream layers disclose not-covered and unverified honestly.
 */
import { AxeBuilder } from '@axe-core/playwright';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page as PwPage } from 'playwright';
import type { AxNode, BrowserDriver, Page } from '../contracts/index.js';
import { applyAxeTags, type AxeIssue } from '../providers/axe/index.js';

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

// Inject before app scripts run so the first live update is observable and not lost.
// Late injection would under-report announcements and create a false sense of coverage.
const LIVE_AND_PATH_INIT_SCRIPT = `(() => {
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

  const escapeCss = (value) => {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(value);
    }
    return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\\\' + ch);
  };
  // Paths use nth-child ancestry so selectors stay valid and comparable across calls.
  const pathFor = (element) => {
    if (!(element instanceof Element)) {
      return '';
    }
    if (element.id) {
      return '#' + escapeCss(element.id);
    }
    const segments = [];
    let current = element;
    while (current instanceof Element) {
      if (current.id) {
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
  window.__usablPathFor = pathFor;
})();`;

interface AxeResult {
  violations: AxeIssue[];
  incomplete: AxeIssue[];
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
interface ReadinessPage {
  waitForLoadState(state: 'networkidle', options: { timeout: number }): Promise<void>;
  evaluate(fn: () => number): Promise<number>;
}

/**
 * The readiness budget for a run: the operator's number when the config names one, the engine
 * default otherwise.
 */
export function readyTimeoutMsFor(config: { readyTimeoutMs?: number }): number {
  return config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
}

// Playwright marks its own timeouts with this name. Anything else out of a page call is a real
// failure, such as a closed context, and relabelling it as a timeout would send the operator to
// the wrong fix.
function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

// "Timeout 15000ms exceeded" does not say whether the network never went quiet or the DOM never
// stopped moving, and those have different fixes: a stuck request against an app or a lab that
// renders slower than the budget allows.
function readinessTimeout(phase: string, timeoutMs: number, detail: string): string {
  return `page ${phase} within ${timeoutMs}ms${detail}; raise readyTimeoutMs in usabl.config.json if this application needs longer`;
}

/**
 * Waits for the network to go quiet and then for the DOM to stop changing, inside one budget.
 *
 * Network idle is a network fact. A client-rendered application mounts after the last response
 * settles because render is CPU work, so waiting on the network alone hands the scan an empty page:
 * every tab stop resolves to body and the run reports a clean screen it never saw.
 *
 * The stability signal is the total element count. It moves whenever a framework mounts or swaps a
 * subtree, it costs one live-collection read in page context, and no application has to cooperate.
 * Focusable count was the other candidate and it is weaker here: a screen with no focusable elements
 * reads a constant zero from the first sample, so it would be called ready while it was still
 * rendering. Stability is the test, not volume, so a page that settles at zero elements is ready
 * because an empty state is a real page.
 *
 * Both phases share timeoutMs, so one operator number covers the whole cost of reaching a screen.
 * Running out throws, and the message names the phase that ran out because the fixes differ. The
 * caller discloses that as a coverage gap, which is honest, where returning quietly would publish
 * a measurement of a page that had not arrived.
 *
 * Exported for tests. Product code reaches this through Page.gotoReady().
 */
export async function waitForRendered(pw: ReadinessPage, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  try {
    await pw.waitForLoadState('networkidle', { timeout: timeoutMs });
  } catch (err) {
    if (!isTimeout(err)) {
      throw err;
    }
    throw new Error(readinessTimeout('network activity did not go quiet', timeoutMs, ''));
  }

  let previous: number | null = null;
  let repeats = 0;
  for (;;) {
    const elements = await pw.evaluate(() => document.getElementsByTagName('*').length);
    repeats = elements === previous ? repeats + 1 : 1;
    previous = elements;
    if (repeats >= SETTLE_SAMPLES_REQUIRED) {
      return;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
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
      };
    },
  });
}

function wrapPage(pw: PwPage, context: BrowserContext, cdp: CDPSession, readyTimeoutMs: number): Page {
  const page: Page = {
    async gotoReady(): Promise<void> {
      await waitForRendered(pw, readyTimeoutMs);
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

// Installs the stable-path helper on a page that already navigated before usabl attached.
// makeRealBrowserDriver injects LIVE_AND_PATH_INIT_SCRIPT at document start, but a page a caller
// hands us has already loaded, so the path helper must be installed after the fact. It is guarded
// so re-adopting the same page is a no-op. The announcement observer is intentionally left out:
// a retroactive observer cannot capture live updates that already fired, and disclosing that
// honestly beats arming a lane that would under-report.
function installPathHelper(): void {
  const scope = window as unknown as { __usablPathFor?: (element: Element | null) => string };
  if (typeof scope.__usablPathFor === 'function') {
    return;
  }
  const escapeCss = (value: string): string => {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(value);
    }
    return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch);
  };
  const pathFor = (element: Element | null): string => {
    if (!(element instanceof Element)) {
      return '';
    }
    if (element.id) {
      return '#' + escapeCss(element.id);
    }
    const segments: string[] = [];
    let current: Element | null = element;
    while (current instanceof Element) {
      if (current.id) {
        segments.unshift('#' + escapeCss(current.id));
        break;
      }
      const parent: Element | null = current.parentElement;
      if (parent === null) {
        segments.unshift(current.tagName.toLowerCase());
        break;
      }
      let index = 1;
      let sibling: Element | null = current.previousElementSibling;
      while (sibling instanceof Element) {
        index += 1;
        sibling = sibling.previousElementSibling;
      }
      segments.unshift(current.tagName.toLowerCase() + ':nth-child(' + String(index) + ')');
      current = parent;
    }
    return segments.join(' > ');
  };
  scope.__usablPathFor = pathFor;
}

/**
 * Adopts a Playwright page a caller already created and navigated, so usabl can run providers on it
 * (for example from a Playwright test suite). It attaches a CDP session for AX reads and installs the
 * path helper, then returns a usabl Page whose close() is a no-op: the caller owns the page and its
 * context, so adoption must never close them. Navigation and readiness are the caller's job.
 */
export async function adoptPage(pw: PwPage): Promise<Page> {
  const context = pw.context();
  const cdp = await context.newCDPSession(pw);
  await cdp.send('Accessibility.enable');
  await pw.evaluate(installPathHelper);
  // Adoption has no operator config to read, so a caller that does use gotoReady gets the default.
  const page = wrapPage(pw, context, cdp, readyTimeoutMsFor({}));
  return { ...page, close: async (): Promise<void> => {} };
}

export function makeRealBrowserDriver(
  options: { storageStatePath?: string; readyTimeoutMs?: number } = {},
): BrowserDriver {
  let browser: Browser | null = null;
  const readyTimeoutMs = readyTimeoutMsFor(options);

  return {
    async open(url: string): Promise<Page> {
      browser ??= await chromium.launch({ headless: true });
      const context = await browser.newContext(
        options.storageStatePath === undefined ? {} : { storageState: options.storageStatePath },
      );
      const page = await context.newPage();
      await page.addInitScript(LIVE_AND_PATH_INIT_SCRIPT);
      const cdp = await context.newCDPSession(page);
      await cdp.send('Accessibility.enable');
      // open() owns navigation and gotoReady() only waits for readiness. Navigation takes the same
      // budget, so one config number covers the whole cost of reaching a screen.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: readyTimeoutMs });
      return wrapPage(page, context, cdp, readyTimeoutMs);
    },
    async close(): Promise<void> {
      if (browser !== null) {
        await browser.close();
      }
      browser = null;
    },
  };
}

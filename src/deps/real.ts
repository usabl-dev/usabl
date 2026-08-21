/// <reference lib="dom" />
/**
 * Real BrowserDriver backed by Playwright + CDP accessibility reads.
 * This unit never mints a verdict, never approximates names from the DOM, and never hides AX read failures.
 * Missing or ignored AX nodes stay null so downstream layers disclose not-covered and unverified honestly.
 */
import { AxeBuilder } from '@axe-core/playwright';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page as PwPage } from 'playwright';
import type { AxNode, BrowserDriver, Page } from '../contracts/index.js';
import type { AxeIssue } from '../providers/axe/index.js';

const READY_TIMEOUT_MS = 15_000;
const CLICK_TIMEOUT_MS = 3_000;

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

function attachAxeBridge(page: Page, pw: PwPage): void {
  Object.assign(page, {
    runAxe: async (): Promise<AxeResult> => {
      const result = await new AxeBuilder({ page: pw }).analyze();
      return {
        violations: mapAxeIssues(result.violations),
        incomplete: mapAxeIssues(result.incomplete),
      };
    },
  });
}

function wrapPage(pw: PwPage, context: BrowserContext, cdp: CDPSession): Page {
  const page: Page = {
    async gotoReady(): Promise<void> {
      await pw.waitForLoadState('networkidle', { timeout: READY_TIMEOUT_MS });
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

export function makeRealBrowserDriver(options: { storageStatePath?: string } = {}): BrowserDriver {
  let browser: Browser | null = null;

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
      // open() owns navigation and gotoReady() only waits for readiness.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: READY_TIMEOUT_MS });
      return wrapPage(page, context, cdp);
    },
    async close(): Promise<void> {
      if (browser !== null) {
        await browser.close();
      }
      browser = null;
    },
  };
}

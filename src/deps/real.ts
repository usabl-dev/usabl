/// <reference lib="dom" />
/**
 * Real BrowserDriver backed by Playwright + CDP accessibility reads.
 * This unit never mints a verdict, never approximates names from the DOM, and never hides AX read failures.
 * Missing or ignored AX nodes stay null so downstream layers disclose not-covered and unverified honestly.
 */
import { AxeBuilder } from '@axe-core/playwright';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page as PwPage } from 'playwright';
import type { AncestorAttributesRead, ApiResponse, AxNode, BrowserDriver, Page, ReadinessOutcome, ReadinessProbe, RowContextRead } from '../contracts/index.js';
import { applyAxeTags, type AxeIssue, type AxeRuleSummary } from '../providers/axe/index.js';
import { createLiveResolver } from '../providers/rulepack/live-value.js';
import { BrowserSandboxRequiredError, isBrowserSandboxRefusal, isSandboxLaunchFailure, type BrowserSandboxPolicy } from './sandbox.js';

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

// Browser-side path helper. Keep this the only implementation: a uniqueness (or any path) fix
// that lands in one copy and misses another recreates the duplicate-id false green.
// Paths use nth-child ancestry so selectors stay valid and comparable across calls.
// An id is used as a selector only when that selector matches exactly one element and that
// element is the one in hand. Counting matches is not enough, because two different ids can
// escape to one selector: a NUL escapes to U+FFFD, so "#" plus an escaped NUL id is the selector
// for a literal U+FFFD id. A selector the engine refuses falls back to the structural path too.
// Every other case falls back to the structural path, so set ops keyed on element identity
// cannot collide.
const PATH_FOR_IMPL = `
  const escapeCss = (value) => {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(value);
    }
    return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\\\' + ch);
  };
  const idNamesOnly = (element) => {
    let matches;
    try {
      matches = document.querySelectorAll('#' + escapeCss(element.id));
    } catch (_error) {
      return false;
    }
    return matches.length === 1 && matches[0] === element;
  };
  const pathFor = (element) => {
    if (!(element instanceof Element)) {
      return '';
    }
    if (element.id && idNamesOnly(element)) {
      return '#' + escapeCss(element.id);
    }
    const segments = [];
    let current = element;
    while (current instanceof Element) {
      if (current.id && idNamesOnly(current)) {
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

// Browser-side live-region capture used by both document-start injection and adoptPage install.
// Keep this the only implementation: the CLI and checkPage
// must hear the same announcements, so a fix to what counts as a live region has to land in both
// at once. It records the text of a live region each time something inside it changes, and
// window.__usablDrain hands back what it recorded since the last drain. It runs in the live world
// below, so window here is that world's global, never the page's.
//
// What counts as live comes from the resolver pf-toast-live-region uses, carried in as its own
// source. A CSS selector for live regions cannot do this: it matches aria-live="off" and any odd
// token, and it cannot see an off wrapper between a polite region and the text that changed. The
// capture used one, so it recorded text no screen reader would speak, and a flow requirement that
// expected that text passed. The walk follows the flat tree the way the rule's walk does, so a
// slotted element climbs through its slot. A change whose live region sits in a different tree
// from it is not recorded; see the observer below.
const LIVE_CAPTURE_IMPL = `
  const liveResolver = (${createLiveResolver.toString()})();
  const flatParent = (element) => {
    if (element.assignedSlot) {
      return element.assignedSlot;
    }
    const parent = element.parentNode;
    if (parent instanceof Element) {
      return parent;
    }
    if (parent instanceof ShadowRoot) {
      return parent.host;
    }
    return null;
  };
  // The element whose region the change belongs to: the nearest one that sets a live value, when
  // that value is polite or assertive. Null when the change is not live.
  const liveHost = (start) => {
    const elements = [];
    const chain = [];
    for (let current = start; current instanceof Element; current = flatParent(current)) {
      elements.push(current);
      chain.push({ ariaLive: current.getAttribute('aria-live'), role: current.getAttribute('role') });
    }
    if (liveResolver.effectiveLiveValue(chain) === 'off') {
      return null;
    }
    return elements[liveResolver.nearestLiveSetter(chain)] ?? null;
  };
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
    // Text the parser is still writing is the page being built, not an announcement, and the
    // capture has never counted it. The check reads the document's own state, so page script
    // cannot change it.
    if (document.readyState === 'loading') {
      return;
    }
    for (const mutation of mutations) {
      const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      const host = target ? liveHost(target) : null;
      // A host in another tree is a live region inside a shadow root that the changed element is
      // slotted into. Its own text leaves out the slotted text that changed and holds text the
      // change did not make speakable, such as slot fallback text and shadow-only text. A flow
      // requirement matches the text exactly, so recording it could pass on words no screen
      // reader spoke for this change. The change is dropped instead: hearing less can only fail a
      // requirement, never pass one.
      if (host && host.getRootNode() === target.getRootNode()) {
        push(host.textContent);
      }
    }
  });
  // Observed from the document itself, at once, with no event to wait for. A page can stop an
  // event from reaching other listeners, as with a DOMContentLoaded listener that calls
  // stopImmediatePropagation, and an observer that waited for one would never start.
  observer.observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
  });
`;

// The world the live-region capture runs in. Page script shares the DOM with it but not its
// globals or prototypes. A page could otherwise define or replace the drain and hand usabl
// announcements no screen reader spoke, or redefine textContent so the capture records text the
// region never held. A flow requirement that expects an announcement would then pass on the
// page's word.
export const LIVE_WORLD = 'usabl-live';

// The capture, run in the live world. The browser keeps one world per name and frame, so the guard
// keeps one observer and one buffer per document however many times the script runs there: once
// at document start on a page usabl opens, and once more when a caller adopts that page. Page
// script cannot reach the guard, so it cannot stop the capture from installing.
const LIVE_CAPTURE_SCRIPT = `(() => {
  if (typeof window.__usablDrain === 'function') {
    return;
  }
  ${LIVE_CAPTURE_IMPL}
})();`;

// Reads and clears what the capture recorded. A document without the capture throws rather than
// reporting silence, because silence would read as a page that announced nothing.
const DRAIN_FUNCTION = `function () {
  const drain = window.__usablDrain;
  if (typeof drain !== 'function') {
    throw new Error('the announcement capture is not running in this document');
  }
  const drained = drain();
  return Array.isArray(drained) ? drained.filter((entry) => typeof entry === 'string') : [];
}`;

/**
 * Starts the live-region capture in the live world: in every document the page loads from now on,
 * at document start, and in the document it holds now. A page usabl opens has no document yet, so
 * only the first applies.
 */
async function installLiveCapture(cdp: CDPSession, current: boolean): Promise<void> {
  // The browser runs a new-document script only for a session that enabled the page domain.
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: LIVE_CAPTURE_SCRIPT, worldName: LIVE_WORLD });
  if (current) {
    await callInWorld(cdp, LIVE_WORLD, 'start the announcement capture', `function () { ${LIVE_CAPTURE_SCRIPT} }`);
  }
}

// The world element paths are computed in. Page script shares the DOM with it but not its globals
// or prototypes, so a page cannot hand back its own paths, and it cannot change the
// querySelectorAll, CSS.escape, or sibling reads a path is built from. Nothing is installed there:
// the path function is sent with every query, so there is no global to find or replace.
const PATH_WORLD = 'usabl-paths';

/**
 * The paths of every element a selector matches, as a function declaration to call in the path
 * world. Exported so the path rules can be tested on their own.
 */
export const PATHS_FOR_SELECTOR_FUNCTION = `function (query) {
  ${PATH_FOR_IMPL}
  return Array.from(document.querySelectorAll(query), (element) => pathFor(element));
}`;

// The path of the focused element, or the empty string when there is none.
const ACTIVE_PATH_FUNCTION = `function () {
  ${PATH_FOR_IMPL}
  return pathFor(document.activeElement instanceof Element ? document.activeElement : null);
}`;

// The world the focus and style reads run in, for the same reason as the path world. A page that
// redefines querySelector, the activeElement or body getters, contains, focus, or getComputedStyle
// in its own world could otherwise make a focus check report what the page wants, and pass a
// keyboard or focus check it fails. Nothing is installed there: each read sends its function.
const READ_WORLD = 'usabl-reads';

// Moves focus to the body, making it focusable first when it is not.
const FOCUS_BODY_FUNCTION = `function () {
  if (!(document.body instanceof HTMLElement)) {
    return;
  }
  if (!document.body.hasAttribute('tabindex')) {
    document.body.setAttribute('tabindex', '-1');
  }
  document.body.focus();
}`;

// Whether the first element a selector matches is the focused element.
const ACTIVE_ELEMENT_IS_FUNCTION = `function (query) {
  return document.querySelector(query) === document.activeElement;
}`;

// Whether the focused element is the first element a selector matches or sits inside it.
const ACTIVE_ELEMENT_WITHIN_FUNCTION = `function (query) {
  const root = document.querySelector(query);
  return root instanceof Element && root.contains(document.activeElement);
}`;

// One computed style value of the first element a selector matches, or the empty string when
// nothing matches.
const COMPUTED_STYLE_FUNCTION = `function (query, cssProperty) {
  const element = document.querySelector(query);
  if (!(element instanceof Element)) {
    return '';
  }
  return getComputedStyle(element).getPropertyValue(cssProperty);
}`;


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
  // Read in the read world, so a page that redefines the activeElement getter cannot point the
  // accessibility read at an element that does not hold focus.
  const contextId = await isolatedWorldContextId(cdp, READ_WORLD, 'read the focused element');
  const evaluated: unknown = await cdp.send('Runtime.evaluate', {
    expression: 'document.activeElement',
    contextId,
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

/** The most elements the ancestor walk reads for one element before it stops and says so. */
export const ANCESTOR_DEPTH_LIMIT = 512;

// The walk runs in an isolated world: page script shares the DOM with it but not its globals or
// prototypes. A page that redefines parentNode, assignedSlot, or getAttribute cannot change what
// the walk reads.
const ANCESTOR_WORLD = 'usabl-ancestors';
const ANCESTOR_GROUP = 'usabl-ancestors';

// The flat-tree parent of an element that is not slotted: its parent element, or the host when it
// sits at the top of a shadow tree. Null at the top of the document or of a detached subtree.
const FLAT_PARENT_FUNCTION = `function () {
  const parent = this.parentNode;
  if (parent instanceof Element) return parent;
  if (parent instanceof ShadowRoot) return parent.host;
  return null;
}`;

// The execution context of a named isolated world in the main frame's current document. The browser
// keeps one world per name and frame, so asking again returns the same context until the frame
// navigates, and the first ask after a navigation makes one for the new document.
async function isolatedWorldContextId(cdp: CDPSession, worldName: string, purpose: string): Promise<number> {
  const tree: unknown = await cdp.send('Page.getFrameTree');
  const frameId = readString(getProp(getProp(getProp(tree, 'frameTree'), 'frame'), 'id'));
  if (frameId === null) {
    throw new Error(`the page has no main frame to ${purpose} in`);
  }
  const world: unknown = await cdp.send('Page.createIsolatedWorld', { frameId, worldName });
  const contextId = readNumber(getProp(world, 'executionContextId'));
  if (contextId === null) {
    throw new Error(`the browser did not create a world to ${purpose} in`);
  }
  return contextId;
}

async function ancestorWorldContextId(cdp: CDPSession): Promise<number> {
  return isolatedWorldContextId(cdp, ANCESTOR_WORLD, 'read ancestors');
}

/**
 * Calls a function declaration in a named isolated world and returns its value. Arguments are
 * passed as JSON, never spliced in as code. A function that throws becomes a rejected promise,
 * the same as a failed page evaluation.
 */
async function callInWorld(
  cdp: CDPSession,
  worldName: string,
  purpose: string,
  functionDeclaration: string,
  args: readonly unknown[] = [],
): Promise<unknown> {
  const contextId = await isolatedWorldContextId(cdp, worldName, purpose);
  const evaluated: unknown = await cdp.send('Runtime.evaluate', {
    expression: `(${functionDeclaration})(${args.map((arg) => JSON.stringify(arg)).join(', ')})`,
    contextId,
    returnByValue: true,
  });
  const exception = getProp(evaluated, 'exceptionDetails');
  if (exception !== undefined) {
    // The description carries a stack of page-world frames after its first line, which says
    // nothing to a reader of the gap, so only the first line is kept.
    const description = readString(getProp(getProp(exception, 'exception'), 'description'))?.split('\n')[0];
    throw new Error(`the browser could not ${purpose}: ${description ?? readString(getProp(exception, 'text')) ?? 'unknown error'}`);
  }
  return getProp(getProp(evaluated, 'result'), 'value');
}

async function stablePathForActiveElement(cdp: CDPSession): Promise<string> {
  const path = await callInWorld(cdp, PATH_WORLD, 'read the focused element path', ACTIVE_PATH_FUNCTION);
  return typeof path === 'string' ? path : '';
}

function pickAttributes(flat: unknown, names: readonly string[]): Record<string, string | null> {
  const record: Record<string, string | null> = {};
  for (const name of names) {
    record[name] = null;
  }
  if (!Array.isArray(flat)) {
    return record;
  }
  // CDP lists attributes as name, value, name, value.
  for (let index = 0; index + 1 < flat.length; index += 2) {
    const name: unknown = flat[index];
    const value: unknown = flat[index + 1];
    if (typeof name === 'string' && typeof value === 'string' && names.includes(name)) {
      record[name] = value;
    }
  }
  return record;
}

/**
 * Reads the named attributes of the element a selector matches and of every element above it,
 * nearest first, along the flat tree that the accessibility tree is built from. A slotted element
 * climbs to its slot, and the top of a shadow tree climbs to its host.
 *
 * Page script cannot do this walk. For a slot inside a closed shadow root, assignedSlot reads null,
 * so a walk in the page skips the slot and everything around it in the shadow tree. CDP reports the
 * assigned slot whatever the mode, and reads attributes from the DOM itself, so this walk sees what
 * the browser sees. The walk stops after `limit` elements and reports that, so no page can keep it
 * running. An element that is gone, or that left the document during the walk, is not found.
 */
export async function readAncestorAttributes(
  cdp: CDPSession,
  selector: string,
  names: readonly string[],
  limit: number = ANCESTOR_DEPTH_LIMIT,
): Promise<AncestorAttributesRead> {
  const contextId = await ancestorWorldContextId(cdp);
  try {
    const found: unknown = await cdp.send('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      contextId,
      objectGroup: ANCESTOR_GROUP,
    });
    const startId = readString(getProp(getProp(found, 'result'), 'objectId'));
    if (startId === null) {
      return { kind: 'not-found' };
    }

    const chain: Array<Record<string, string | null>> = [];
    let currentId: string | null = startId;
    while (currentId !== null) {
      if (chain.length >= limit) {
        return { kind: 'too-deep', limit };
      }
      const described: unknown = await cdp.send('DOM.describeNode', { objectId: currentId, depth: 0 });
      const node = getProp(described, 'node');
      chain.push(pickAttributes(getProp(node, 'attributes'), names));

      const slotBackendId = readNumber(getProp(getProp(node, 'assignedSlot'), 'backendNodeId'));
      if (slotBackendId !== null) {
        const resolved: unknown = await cdp.send('DOM.resolveNode', {
          backendNodeId: slotBackendId,
          executionContextId: contextId,
          objectGroup: ANCESTOR_GROUP,
        });
        currentId = readString(getProp(getProp(resolved, 'object'), 'objectId'));
        if (currentId === null) {
          throw new Error('the browser named a slot for the element and then could not resolve it');
        }
        continue;
      }
      const parent: unknown = await cdp.send('Runtime.callFunctionOn', {
        objectId: currentId,
        functionDeclaration: FLAT_PARENT_FUNCTION,
        objectGroup: ANCESTOR_GROUP,
      });
      currentId = readString(getProp(getProp(parent, 'result'), 'objectId'));
    }

    // A walk that ended in a detached subtree did not reach the document, so the chain is not the
    // element's real ancestry. The element was removed while it was read.
    const connected: unknown = await cdp.send('Runtime.callFunctionOn', {
      objectId: startId,
      functionDeclaration: 'function () { return this.isConnected; }',
      returnByValue: true,
    });
    if (getProp(getProp(connected, 'result'), 'value') !== true) {
      return { kind: 'not-found' };
    }
    return { kind: 'chain', chain };
  } finally {
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: ANCESTOR_GROUP }).catch(() => undefined);
  }
}

// The longest row key, or table identity, usabl reads, in UTF-16 code units. A key is hashed in
// full and never cut, because two long keys that share a prefix would hash alike once cut. A row
// whose key is longer than this is not keyed and is disclosed instead, which also bounds what one
// read carries out of the page.
const ROW_KEY_LIMIT = 65_536;

// The most text one read carries out for the hash check: the other rows' keys and the other
// tables' identities together. A table past it is not keyed, so one read stays bounded.
const ROW_CONTEXT_TEXT_LIMIT = 4 * 1024 * 1024;

// How deep tables may nest inside each other's rows before usabl stops reading identities.
const TABLE_NESTING_LIMIT = 32;

/**
 * The table row an element sits in, read in the page in usabl's own world (see ROW_WORLD). See
 * RowContextRead.
 *
 * The selector must name exactly one element. One the page cannot parse, one that matches nothing
 * (the element went away after the scanner saw it), and one that matches more than one element are
 * all 'unreadable'. Only an element that was found, and is outside every body row of a keyed table,
 * is 'none'.
 *
 * A table is a `table` or an element with role table, grid, or treegrid. Its rows are the `tr` and
 * `role="row"` elements whose nearest table is that table, so a row of a nested table is never
 * counted as a row of the table around it. Header and footer rows, those inside `thead` or `tfoot`
 * or holding a column header, are not body rows.
 *
 * The table's key source is the first of these that any of its body rows has: `data-row-key`,
 * `data-key`, `data-id`, `data-ouia-component-id`, `id` (an id a framework mints per mount does not
 * count), then a row header (a `th` that is not a column header, or `role="rowheader"`). A table
 * none of whose rows has any of them is not keyed, and its elements read as 'none'. In a keyed
 * table, a row without that source, or one whose value another row of the table holds exactly, is
 * ambiguous. Values are compared exactly as they are hashed: the full string, with case and spaces.
 * A row's position is never used: rows move when a list is sorted or grows.
 *
 * The table's identity is its own key attribute, else its accessible name (aria-labelledby, then
 * aria-label, then caption, with white space collapsed), after the identity of the table and row it
 * is nested in, if any. Its position is never used. A table's identity is valid only when no other
 * table on the screen has the same one, and, for a nested table, when the row and the table around
 * it are valid too. Anything under a row or table that cannot be told apart, or under a row of a
 * table that keys no rows, is ambiguous. It is never keyed with an empty part.
 */
interface RowReadArgs {
  query: string;
  limit: number;
  textLimit: number;
  nestingLimit: number;
}

// The row read, as a function sent to the row world with each call. It must use nothing from
// outside its own body: it runs in the browser from its source text.
const READ_ROW_CONTEXT = ({ query, limit, textLimit, nestingLimit }: RowReadArgs) => {
  const TABLE = 'table, [role="table"], [role="grid"], [role="treegrid"]';
  const ROW = 'tr, [role="row"]';
  const GENERATED = /^OUIA-Generated-|pf-random-id-|:r[0-9a-z]+:|«r[0-9a-z]+»|_r_[0-9a-z]+_/i;
  const ROW_ATTRIBUTES = ['data-row-key', 'data-key', 'data-id', 'data-ouia-component-id', 'id'];
  const TABLE_ATTRIBUTES = ['id', 'data-ouia-component-id', 'data-table-key'];
  type Ambiguity = 'row-key-missing' | 'row-key-duplicate' | 'row-key-too-long' | 'table-ambiguous' | 'enclosing-row-unkeyed';

  let matches: Element[];
  try {
    matches = Array.from(document.querySelectorAll(query));
  } catch {
    return { kind: 'unreadable' as const, reason: 'selector-invalid' as const };
  }
  if (matches.length === 0) {
    return { kind: 'unreadable' as const, reason: 'element-missing' as const };
  }
  if (matches.length > 1) {
    return { kind: 'unreadable' as const, reason: 'element-multiple' as const };
  }
  const element = matches[0] as Element;

  const tableOf = (row: Element): Element | null => row.closest(TABLE);
  const isBodyRow = (row: Element, table: Element): boolean => {
    const section = row.closest('thead, tfoot');
    if (section !== null && section.closest(TABLE) === table) return false;
    return !Array.from(row.children).some((cell) =>
      cell.matches('th[scope="col"], th[scope="colgroup"], [role="columnheader"]'),
    );
  };
  const bodyRows = (table: Element): Element[] =>
    Array.from(table.querySelectorAll(ROW)).filter((row) => tableOf(row) === table && isBodyRow(row, table));
  const usable = (value: string | null): string | null =>
    value === null || value.trim() === '' || GENERATED.test(value) ? null : value;
  const rowHeader = (row: Element): string | null => {
    const header = Array.from(row.children).find((cell) =>
      cell.matches('th:not([scope="col"]):not([scope="colgroup"]), [role="rowheader"]'),
    );
    if (header === undefined) return null;
    const text = header.textContent ?? '';
    return text.trim() === '' ? null : text;
  };
  const SOURCES: Array<[string, (row: Element) => string | null]> = [
    ...ROW_ATTRIBUTES.map((name): [string, (row: Element) => string | null] => [
      `attr:${name}`,
      (row) => usable(row.getAttribute(name)),
    ]),
    ['header', rowHeader],
  ];

  // A row's key: keyed, ambiguous, or null when its table keys no rows (or it is not a body row).
  type RowKey = { source: string; key: string } | { ambiguous: Ambiguity } | null;
  type TableRows = { rows: Map<Element, RowKey>; keys: string[] };
  const rowKeyCache = new Map<Element, TableRows>();
  const tableRows = (table: Element): TableRows => {
    const cached = rowKeyCache.get(table);
    if (cached !== undefined) return cached;
    const rowsOut = new Map<Element, RowKey>();
    const keys: string[] = [];
    const rows = bodyRows(table);
    const source = SOURCES.find(([, read]) => rows.some((other) => read(other) !== null));
    const counts = new Map<string, number>();
    if (source !== undefined) {
      for (const other of rows) {
        const value = source[1](other);
        if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    for (const other of rows) {
      if (source === undefined) {
        rowsOut.set(other, null);
        continue;
      }
      const value = source[1](other);
      if (value === null) {
        rowsOut.set(other, { ambiguous: 'row-key-missing' });
      } else if (value.length > limit) {
        rowsOut.set(other, { ambiguous: 'row-key-too-long' });
      } else if (counts.get(value) !== 1) {
        rowsOut.set(other, { ambiguous: 'row-key-duplicate' });
      } else {
        rowsOut.set(other, { source: source[0], key: value });
        keys.push(value);
      }
    }
    const out = { rows: rowsOut, keys };
    rowKeyCache.set(table, out);
    return out;
  };
  const rowKey = (table: Element, row: Element): RowKey => tableRows(table).rows.get(row) ?? null;

  // Collapsed so the same words always name the same table, however the markup wraps them.
  const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();
  const ownName = (table: Element): [string, string] => {
    for (const name of TABLE_ATTRIBUTES) {
      const value = usable(table.getAttribute(name));
      if (value !== null) return [`attr:${name}`, value];
    }
    // The accessible-name order: aria-labelledby wins over aria-label, which wins over a caption.
    const labelledBy = table.getAttribute('aria-labelledby');
    if (labelledBy !== null) {
      const text = collapse(
        labelledBy
          .split(/\s+/)
          .filter((id) => id !== '')
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' '),
      );
      if (text !== '') return ['labelledby', text];
    }
    const label = collapse(table.getAttribute('aria-label') ?? '');
    if (label !== '') return ['label', label];
    const caption = Array.from(table.children).find((child) => child.tagName.toLowerCase() === 'caption');
    const captionText = collapse(caption?.textContent ?? '');
    if (captionText !== '') return ['caption', captionText];
    return ['unnamed', ''];
  };

  // A table's identity text, and why it is not valid, or null when it is. Invalidity is passed
  // down: a table nested under a row or a table that cannot be told apart cannot be either.
  type Identity = { value: string; problem: Ambiguity | null };
  const enclosing = (table: Element): { row: Element; table: Element } | null => {
    const outerRow = table.parentElement?.closest(ROW) ?? null;
    const outerTable = outerRow === null ? null : tableOf(outerRow);
    return outerRow === null || outerTable === null ? null : { row: outerRow, table: outerTable };
  };
  const valueCache = new Map<Element, string>();
  const valueOf = (table: Element, depth: number): string => {
    const cached = valueCache.get(table);
    if (cached !== undefined) return cached;
    const parts: Array<[string, string]> = [];
    const outer = depth < nestingLimit ? enclosing(table) : null;
    if (outer !== null) {
      parts.push(['table', valueOf(outer.table, depth + 1)]);
      const key = rowKey(outer.table, outer.row);
      // A placeholder only: an identity built with it is never valid, see identityOf.
      parts.push(['row', key !== null && 'key' in key ? JSON.stringify([key.source, key.key]) : '']);
    }
    parts.push(ownName(table));
    const value = JSON.stringify(parts);
    valueCache.set(table, value);
    return value;
  };
  const allTables = Array.from(document.querySelectorAll(TABLE));
  const sameValue = new Map<string, number>();
  for (const table of allTables) {
    const value = valueOf(table, 0);
    sameValue.set(value, (sameValue.get(value) ?? 0) + 1);
  }
  const identityCache = new Map<Element, Identity>();
  const identityOf = (table: Element, depth: number): Identity => {
    const cached = identityCache.get(table);
    if (cached !== undefined) return cached;
    const value = valueOf(table, 0);
    let problem: Ambiguity | null = null;
    if (value.length > limit) {
      problem = 'row-key-too-long';
    } else if (sameValue.get(value) !== 1) {
      problem = 'table-ambiguous';
    } else {
      const outer = enclosing(table);
      if (outer !== null) {
        if (depth >= nestingLimit) {
          problem = 'row-key-too-long';
        } else {
          problem = identityOf(outer.table, depth + 1).problem;
          if (problem === null) {
            const key = rowKey(outer.table, outer.row);
            if (key === null) problem = 'enclosing-row-unkeyed';
            else if ('ambiguous' in key) problem = key.ambiguous;
          }
        }
      }
    }
    const identity = { value, problem };
    identityCache.set(table, identity);
    return identity;
  };

  const row = element.closest(ROW);
  const table = row === null ? null : tableOf(row);
  if (row === null || table === null || !isBodyRow(row, table)) {
    return { kind: 'none' as const };
  }
  const key = rowKey(table, row);
  if (key === null) {
    return { kind: 'none' as const };
  }
  if ('ambiguous' in key) {
    return { kind: 'ambiguous' as const, reason: key.ambiguous };
  }
  const tableIdentity = identityOf(table, 0);
  if (tableIdentity.problem !== null) {
    return { kind: 'ambiguous' as const, reason: tableIdentity.problem };
  }
  const otherKeys = tableRows(table).keys.filter((other) => other !== key.key);
  const otherTables = allTables
    .filter((other) => other !== table)
    .map((other) => valueOf(other, 0))
    .filter((value) => value.length <= limit);
  const carried = [...otherKeys, ...otherTables].reduce((sum, text) => sum + text.length, 0);
  if (carried > textLimit) {
    return { kind: 'ambiguous' as const, reason: 'row-key-too-long' as const };
  }

  const steps: string[] = [];
  let current: Element | null = element;
  while (current !== null && current !== row) {
    const parent: Element | null = current.parentElement;
    let index = 1;
    let sibling = current.previousElementSibling;
    while (sibling !== null) {
      index += 1;
      sibling = sibling.previousElementSibling;
    }
    steps.unshift(`${current.tagName.toLowerCase()}:nth-child(${String(index)})`);
    current = parent;
  }

  const tag = element.tagName.toLowerCase();
  const explicitRole = element.getAttribute('role')?.trim() ?? '';
  const inputType = (element.getAttribute('type') ?? 'text').toLowerCase();
  const implicitRole =
    tag === 'button' ? 'button'
    : tag === 'a' && element.hasAttribute('href') ? 'link'
    : tag === 'select' ? 'combobox'
    : tag === 'textarea' ? 'textbox'
    : tag === 'img' ? 'img'
    : tag === 'input'
      ? ['button', 'submit', 'reset', 'image'].includes(inputType) ? 'button'
        : inputType === 'checkbox' || inputType === 'radio' ? inputType
        : 'textbox'
    : tag;

  return {
    kind: 'keyed' as const,
    table: tableIdentity.value,
    source: key.source,
    key: key.key,
    role: explicitRole.length > 0 ? explicitRole : implicitRole,
    path: steps.join(' > '),
    otherKeys,
    otherTables,
  };
};

// The world the row read runs in. It shares the DOM with the page but not its globals or
// prototypes, so page script cannot change the getAttribute, closest, parentElement, or
// querySelectorAll calls a row key is read through, and cannot move a key from one row to another
// or put an element outside a table into a row. Nothing is installed there: the read is sent with
// every call.
const ROW_WORLD = 'usabl-rows';

async function rowContextForSelector(cdp: CDPSession, selector: string): Promise<RowContextRead> {
  const args: RowReadArgs = { query: selector, limit: ROW_KEY_LIMIT, textLimit: ROW_CONTEXT_TEXT_LIMIT, nestingLimit: TABLE_NESTING_LIMIT };
  return (await callInWorld(cdp, ROW_WORLD, 'read the table row', READ_ROW_CONTEXT.toString(), [args])) as RowContextRead;
}

async function stablePathsForSelector(cdp: CDPSession, selector: string): Promise<string[]> {
  const paths = await callInWorld(cdp, PATH_WORLD, 'read element paths', PATHS_FOR_SELECTOR_FUNCTION, [selector]);
  if (!Array.isArray(paths)) {
    throw new Error('the browser returned no list of element paths');
  }
  return paths.map((path) => (typeof path === 'string' ? path : ''));
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
// unauthorizedApiUrls reports the other thing worth knowing about the same traffic: which of the
// page's own data requests came back 401. It rides this tracker rather than a second listener path
// because both facts are read off the same request lifecycle, and a second set of handlers attached
// somewhere else would be a second thing to keep in step with navigation and adoption. It is
// cumulative for the life of the page, so a caller decides which window it means by choosing when
// to read.
export interface NetworkActivity {
  networkQuietFor(windowMs: number): boolean;
  unauthorizedApiUrls(): string[];
  apiResponses(): ApiResponse[];
  // Records how many requests had been sent when the walk began. See Page.markWalkStart.
  markWalkStart(): void;
}

// The subset of a Playwright request this tracker reads. Playwright hands the same object to the
// request event and to response.request(), which is what lets a response be dated by when its
// request was sent.
export interface RequestHandle {
  resourceType(): string;
  // The request this one was redirected from, if any. A redirect is a new request object.
  redirectedFrom?(): RequestHandle | null;
}

// The subset of a Playwright response this tracker reads. Narrow so a test can drive it.
export interface ResponseEvent {
  status(): number;
  url(): string;
  // Header names in lower case, as Playwright gives them. Optional so a driver without headers
  // still works; such a response has no content type.
  headers?(): Record<string, string>;
  request(): RequestHandle;
}

// The subset of a Playwright page this tracker listens to. Narrow so a test can drive it.
export interface RequestEvents {
  on(event: 'request', handler: (request: RequestHandle) => void): void;
  on(event: 'requestfinished' | 'requestfailed', handler: () => void): void;
  on(event: 'response', handler: (response: ResponseEvent) => void): void;
}

// How far back a redirect chain is followed to find the request that started it. A browser stops
// a fetch after 20 redirects, so a longer chain is not a real one.
const REDIRECT_CHAIN_LIMIT = 20;

// The resource types Playwright gives a request the page's own script issued. A document, a
// stylesheet, an image, or a font that answers 401 is a missing asset, not a refused session, so
// only these two count.
const PAGE_DATA_RESOURCE_TYPES = new Set(['fetch', 'xhr']);

// 401 only. 403 means the request was authenticated and the identity is not allowed to have the
// thing, which is a real application state a signed-in scan can legitimately meet, so it must not
// fire. 401 is the one status HTTP defines as "not authenticated".
const UNAUTHENTICATED_STATUS = 401;

// Exported for tests. Product code reaches it through Page.gotoReady() and
// Page.unauthorizedApiRequests().
export function makeNetworkActivityTracker(
  page: RequestEvents,
  now: () => number = Date.now,
): NetworkActivity {
  let inFlight = 0;
  // The last instant the count was zero. A page starts idle, so it begins now.
  let idleSince = now();
  // Every refused data request seen since this tracker was attached, in arrival order. The tracker
  // is attached before navigation and never stops recording, so a read late in a scan includes
  // traffic a provider click caused as well as traffic the load caused. That is deliberate: a
  // request a provider triggered is still the application answering this session, and the check
  // runner reads this twice for exactly that reason. What it cannot hold is a response that
  // arrives after the last read, which is the one boundary nothing here can close.
  const unauthorized: string[] = [];
  // Every data response, refused or not, in the same arrival order and from the same handler, so
  // a refusal can be read against what the application answered for that address afterwards, and
  // a declared readiness response can be looked up. Cumulative for the life of the page, like the
  // refusal record.
  //
  // Each is kept with the position its request was sent in, so a read can tell traffic the page
  // sent on load from traffic sent after the walk began. The answer itself can arrive at any time.
  const responses: Array<{ url: string; status: number; contentType: string | null; sentIndex: number | null }> = [];
  // The position each request was sent in, by request object. Weak, so a closed page's requests
  // are not kept alive.
  const sentOrder = new WeakMap<object, number>();
  let sentCount = 0;
  // How many requests had been sent when the walk began, or null before that.
  let walkMark: number | null = null;

  // The position of the request that started a redirect chain, or null when it was never seen.
  const sentIndexOf = (request: RequestHandle): number | null => {
    let first: RequestHandle = request;
    for (let hop = 0; hop < REDIRECT_CHAIN_LIMIT; hop += 1) {
      const previous = typeof first.redirectedFrom === 'function' ? first.redirectedFrom() : null;
      if (previous === null || previous === undefined) {
        break;
      }
      first = previous;
    }
    return sentOrder.get(first) ?? null;
  };

  const contentTypeOf = (response: ResponseEvent): string | null => {
    try {
      const value = typeof response.headers === 'function' ? response.headers()['content-type'] : undefined;
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  };

  const settled = (): void => {
    inFlight = Math.max(0, inFlight - 1);
    if (inFlight === 0) {
      idleSince = now();
    }
  };

  page.on('request', (request) => {
    inFlight += 1;
    if (typeof request === 'object' && request !== null) {
      sentOrder.set(request, sentCount);
    }
    sentCount += 1;
  });
  page.on('requestfinished', settled);
  page.on('requestfailed', settled);
  page.on('response', (response) => {
    // A listener that throws would take down the page event emitter, and a status read on a
    // response from a frame that has already gone can throw. Nothing here is worth that.
    try {
      const request = response.request();
      if (!PAGE_DATA_RESOURCE_TYPES.has(request.resourceType())) {
        return;
      }
      const status = response.status();
      const url = response.url();
      responses.push({ url, status, contentType: contentTypeOf(response), sentIndex: sentIndexOf(request) });
      if (status === UNAUTHENTICATED_STATUS) {
        unauthorized.push(url);
      }
    } catch {
      return;
    }
  });

  return {
    networkQuietFor(windowMs: number): boolean {
      if (inFlight > 0) {
        return false;
      }
      return now() - idleSince >= windowMs;
    },
    unauthorizedApiUrls(): string[] {
      return [...unauthorized];
    },
    apiResponses(): ApiResponse[] {
      return responses.map((response) => ({
        url: response.url,
        status: response.status,
        contentType: response.contentType,
        sentBeforeWalk: walkMark === null || (response.sentIndex !== null && response.sentIndex < walkMark),
      }));
    },
    markWalkStart(): void {
      if (walkMark === null) {
        walkMark = sentCount;
      }
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
 * A pause with no request behind it. A page can mount a small shell, do nothing at all for a while,
 * and only then fetch and mount its real content. The network is genuinely quiet during that pause
 * and the DOM is genuinely still, so both signals read as done. Measured against real Chromium, a
 * pause longer than about 1.7 seconds, the DOM window plus margin, is read as settled, and the scan
 * grades the shell. Raising readyTimeoutMs does not help, because the loop believes it is done and
 * returns rather than running out of budget.
 *
 * readyWhen closes that pause for a screen that declares a readiness selector. Its probe is asked
 * only at a moment when the DOM is stable and the network is quiet, and the loop keeps waiting
 * until it answers true, until readyWhen.timeoutMs has passed since the first such moment, or until
 * the budget runs out, whichever comes first. A true answer only ends the wait when the page reads
 * the same after the probe as before it: the same element count and a network still quiet. A page
 * that mounted its content while the probe ran was not settled when the probe looked, so the wait
 * goes on, inside the same cap and budget. The cap is counted from the first settled moment,
 * never restarts, and is checked on every pass whether or not the page is settled, and no sleep
 * runs past it, so a page that keeps changing cannot stretch it. A probe that throws reads as false.
 *
 * The result says how the wait ended, and the caller acts on it rather than reading the signal
 * again. A second read can find the selector on an element that appeared after the cap ran out, on
 * a page that was still changing, and walking that page would grade something that had not
 * settled. timed-out covers the cap running out, settled or not, and the budget running out on a
 * settled page whose probe never held. The caller ends the screen as a coverage gap that names the
 * selector and the cap, which says more than a timeout would. The budget running out on a page that
 * never settled still throws, before the cap or with no probe, as it always has.
 *
 * Without readyWhen the pause is still not covered. Closing it without a signal would need the
 * application to report its own render completion, which this design avoids on purpose so it can
 * measure any application without cooperation.
 *
 * Exported for tests. Product code reaches this through Page.gotoReady().
 */
export async function waitForRendered(
  pw: ReadinessPage,
  timeoutMs: number,
  readyWhen?: ReadinessProbe,
): Promise<ReadinessOutcome> {
  const deadline = Date.now() + timeoutMs;
  // When the signal wait ends, set at the first settled moment.
  let signalDeadline: number | null = null;

  let previous: number | null = null;
  let repeats = 0;
  for (;;) {
    let elements = await pw.evaluate(() => document.getElementsByTagName('*').length);
    repeats = elements === previous ? repeats + 1 : 1;
    previous = elements;

    let domStable = repeats >= SETTLE_SAMPLES_REQUIRED;
    // Read live every pass, so a request that started since the last read resets the window.
    let networkQuiet = pw.networkQuietFor(NETWORK_QUIET_WINDOW_MS);
    let settled = domStable && networkQuiet;
    if (settled) {
      if (readyWhen === undefined) {
        return { signal: 'not-declared' };
      }
      signalDeadline ??= Date.now() + readyWhen.timeoutMs;
      if (await signalHolds(readyWhen.holds)) {
        // The probe takes time, and the page can mount its content while it runs. The sample
        // before the probe then describes a page that is gone, so the answer only counts when the
        // page reads the same after it: the same element count, with the network still quiet.
        // Otherwise the wait goes on. A changed count starts a new run of equal reads, and a busy
        // network has to go quiet again.
        const after = await pw.evaluate(() => document.getElementsByTagName('*').length);
        const quietAfter = pw.networkQuietFor(NETWORK_QUIET_WINDOW_MS);
        if (after === elements && quietAfter) {
          return { signal: 'held' };
        }
        if (after !== elements) {
          repeats = 1;
          previous = after;
          elements = after;
          domStable = false;
        }
        networkQuiet = quietAfter;
        settled = false;
      }
    }
    // Checked on every pass, settled or not, so DOM changes after the first settled moment cannot
    // carry the wait past the cap.
    if (signalDeadline !== null && Date.now() >= signalDeadline) {
      return { signal: 'timed-out' };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      if (settled) {
        // Settled, and the declared signal never held. readyWhen is defined here, because a
        // settled pass with no probe has already returned.
        return { signal: 'timed-out' };
      }
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
    // Bounded by both deadlines, so the cap is never overslept.
    const untilCap = signalDeadline === null ? remaining : Math.max(0, signalDeadline - Date.now());
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(SETTLE_SAMPLE_INTERVAL_MS, remaining, untilCap)));
  }
}

// A readiness probe that throws has not shown the signal, so it reads as false and the wait goes on.
async function signalHolds(holds: () => Promise<boolean>): Promise<boolean> {
  try {
    return (await holds()) === true;
  } catch {
    return false;
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
    async gotoReady(readyWhen?: ReadinessProbe): Promise<ReadinessOutcome> {
      return waitForRendered(readiness, readyTimeoutMs, readyWhen);
    },
    async currentUrl(): Promise<string> {
      // Playwright tracks the committed navigation, so this is the address after any redirect
      // chain the server or the application ran, not the one open() was handed.
      return pw.url();
    },
    async unauthorizedApiRequests(): Promise<string[]> {
      return network.unauthorizedApiUrls();
    },
    async apiResponses(): Promise<ApiResponse[]> {
      return network.apiResponses();
    },
    async markWalkStart(): Promise<void> {
      network.markWalkStart();
    },
    async countEverywhere(selector: string): Promise<number> {
      // A Playwright locator pierces open shadow roots on its own, and every frame is asked, so a
      // login form mounted in a web component or an iframe is counted where querySelectorAll on
      // the top document would report nothing.
      let total = 0;
      for (const frame of pw.frames()) {
        try {
          total += await frame.locator(selector).count();
        } catch {
          // A frame that detached mid-scan, or a selector the engine rejects, contributes nothing.
          // Counting is a probe, never a reason to fail a whole screen.
          continue;
        }
      }
      return total;
    },
    async focusBody(): Promise<void> {
      await callInWorld(cdp, READ_WORLD, 'focus the body', FOCUS_BODY_FUNCTION);
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
      return (await callInWorld(cdp, READ_WORLD, 'read focus', ACTIVE_ELEMENT_IS_FUNCTION, [selector])) === true;
    },
    async activeElementWithin(selector: string): Promise<boolean> {
      return (await callInWorld(cdp, READ_WORLD, 'read focus', ACTIVE_ELEMENT_WITHIN_FUNCTION, [selector])) === true;
    },
    async armAnnouncementCapture(): Promise<void> {
      // The observer is already running: it starts at document start on a page usabl opens, and
      // adoptPage starts it on a page a caller hands in. Arming has nothing to do.
      return Promise.resolve();
    },
    async drainAnnouncements(): Promise<string[]> {
      const drained = await callInWorld(cdp, LIVE_WORLD, 'read announcements', DRAIN_FUNCTION);
      return Array.isArray(drained) ? drained.filter((entry): entry is string => typeof entry === 'string') : [];
    },
    async activeNode(): Promise<AxNode | null> {
      const backendNodeId = await backendNodeIdForActiveElement(cdp);
      if (backendNodeId === null) {
        return null;
      }
      return axFromBackendId(cdp, backendNodeId);
    },
    async activePath(): Promise<string> {
      return stablePathForActiveElement(cdp);
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
    async ancestorAttributes(selector: string, names: readonly string[]): Promise<AncestorAttributesRead> {
      return readAncestorAttributes(cdp, selector, names);
    },
    async queryAll(selector: string): Promise<Array<{ selector: string }>> {
      const paths = await stablePathsForSelector(cdp, selector);
      return paths.map((path) => ({ selector: path }));
    },
    async rowContext(selector: string): Promise<RowContextRead> {
      return rowContextForSelector(cdp, selector);
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
      const value = await callInWorld(cdp, READ_WORLD, 'read a computed style', COMPUTED_STYLE_FUNCTION, [selector, property]);
      return typeof value === 'string' ? value : '';
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
 * (for example from a Playwright test suite). It attaches a CDP session for AX reads and element
 * paths and installs the live-region capture, then returns a usabl Page whose close() is a no-op: the
 * caller owns the page and its context, so adoption must never close them. Navigation and readiness
 * are the caller's job. The browser is the caller's too: usabl did not launch it and does not change
 * how it runs, so whether it has Chromium's sandbox is the caller's choice, and the page carries no
 * sandbox note.
 *
 * The in-flight tracker starts at adoption, so it counts only requests fired after this call. A
 * caller that adopts a page mid-load and then calls gotoReady would read the network as idle at once
 * and lean on the DOM half of readiness alone. checkPage calls gotoReady only for a screen that
 * declares a readiness signal, and the signal is what tells it the screen rendered. The response
 * record starts at adoption too, so a response the page received before it was adopted is not in it.
 */
export async function adoptPage(pw: PwPage, options: { readyTimeoutMs?: number } = {}): Promise<Page> {
  const context = pw.context();
  const cdp = await context.newCDPSession(pw);
  await cdp.send('Accessibility.enable');
  // Without this, armAnnouncementCapture and drainAnnouncements hear nothing on an adopted page, and
  // a flow requirement that expects an announcement fails here while the CLI passes it. It hears
  // only changes made after adoption, which is when a caller's checks start, and it also starts in
  // any document the page navigates to afterwards.
  await installLiveCapture(cdp, true);
  // The caller already navigated, so this tracker starts counting from adoption forward. A caller
  // that then uses gotoReady gets readiness measured against requests fired after adoption.
  const network = makeNetworkActivityTracker(pw);
  // A caller that read the operator config passes its readiness budget; any other gets the default.
  const page = wrapPage(pw, context, cdp, readyTimeoutMsFor(options), network);
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
  // What this run allows when Chromium cannot start its sandbox. Absent means auto.
  browserSandbox?: BrowserSandboxPolicy;
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

/**
 * Replace any browser error that quotes the storage state path with a fixed sentence.
 *
 * The path never reaches a message on any path usabl controls, but the browser is not usabl. If
 * the session file is deleted or loses read permission between the pre-check and the moment a
 * context is created, Playwright raises its own ENOENT or EACCES naming the file in full. The
 * check runner turns a failed open into a coverage gap carrying that message, and that gap is
 * rendered by the CLI, the overlay, and the pull request comment. A private path would then be
 * published to a repository.
 *
 * Matching is on the exact path string this run was given, so nothing else is rewritten and an
 * unrelated browser failure keeps its own diagnosis. The replacement says what happened and what
 * to do, which is everything the operator needs and nothing they do not already know.
 *
 * Exported for tests, which drive it directly rather than trying to make a real browser race a
 * file deletion.
 */
export function redactStorageStatePath(error: unknown, storageStatePath: string | undefined): unknown {
  if (storageStatePath === undefined || storageStatePath.length === 0) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes(storageStatePath)) {
    return error;
  }
  return new Error(
    'the browser could not open a context with the configured session; the file named by ' +
      'USABL_STORAGE_STATE was unreadable at scan time (the path is not printed here). Re-export ' +
      'the session file, or unset USABL_STORAGE_STATE to scan signed out on purpose.',
  );
}

// One launched process, the newContext failures in a row it has had, and whether it runs with
// Chromium's sandbox. Whether it does is decided once, when the process starts, so every page it
// opens shares the answer.
interface ProcessHandle {
  process: LaunchedBrowser;
  contextFailures: number;
  sandboxed: boolean;
}

/** What one scan browser launch asks Chromium for. */
export interface ScanBrowserLaunch {
  chromiumSandbox: boolean;
}

/**
 * The options usabl hands chromium.launch. Playwright adds --no-sandbox unless chromiumSandbox is
 * true, so the sandbox has to be asked for by name.
 */
export function chromiumLaunchOptions(launch: ScanBrowserLaunch): { headless: true; chromiumSandbox: boolean } {
  return { headless: true, chromiumSandbox: launch.chromiumSandbox };
}

/**
 * Starts a scan browser. The shared browser, which the CLI and the overlay open pages through, and
 * the doctor's sandbox probe both start Chromium here, so they ask for the same thing.
 */
export async function launchScanBrowser(launch: ScanBrowserLaunch): Promise<Browser> {
  return chromium.launch(chromiumLaunchOptions(launch));
}

export function makeSharedBrowser(
  ports: { launch?: (launch: ScanBrowserLaunch) => Promise<LaunchedBrowser>; maxContextFailures?: number } = {},
): SharedBrowser {
  const launch = ports.launch ?? launchScanBrowser;
  // How many newContext failures in a row, with the process still reporting connected, before the
  // process is treated as unusable and replaced. A process can hang or wedge in a way that keeps its
  // connection up while every context request fails, and a reference kept forever would fail every
  // later scan in the dev session.
  const maxContextFailures = ports.maxContextFailures ?? 3;

  // The process in use, with its own count of newContext failures in a row. The count lives on the
  // handle, not beside it, so it always describes one process. An open that was waiting on a
  // process when that process was replaced still settles later, and its failure or success must
  // land on the process it asked, not on the one that replaced it. A relaunch starts at zero
  // because it is a new handle.
  let current: ProcessHandle | null = null;
  // One launch at a time. Two opens that both find no process share this promise rather than each
  // launching a process, which would leave one of them running with nothing holding it.
  let launching: Promise<ProcessHandle> | null = null;
  // Once closed, stays closed. An open after close rejects rather than launching a new process that
  // nothing would ever close.
  let closed = false;
  // One close for every caller. Two close requests can arrive together, such as the dev server's
  // close event and the bundle backstop, and the second must not resolve before the process is
  // closed.
  let closing: Promise<void> | null = null;

  const closedError = (): Error =>
    new Error('usabl shared browser is closed; the dev server has shut down and no scan can open a page');

  // Drop a process, but only the one the caller saw. A concurrent open may already have replaced
  // it, and that replacement must not be dropped by mistake.
  const discard = async (which: ProcessHandle): Promise<void> => {
    if (current !== which) {
      return;
    }
    current = null;
    // The process may already be gone. close() only releases what is left on this side.
    await which.process.close().catch(() => undefined);
  };

  // Starts a process with Chromium's sandbox. Only a launch that failed because the system cannot
  // provide the sandbox is tried again without it, and only when the run allows that. Any other
  // failure, such as a missing Chromium or a crash, is reported as it is.
  const launchHandle = async (policy: BrowserSandboxPolicy): Promise<ProcessHandle> => {
    try {
      return { process: await launch({ chromiumSandbox: true }), contextFailures: 0, sandboxed: true };
    } catch (error) {
      if (!isSandboxLaunchFailure(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
      if (policy === 'require') {
        throw new BrowserSandboxRequiredError();
      }
      return { process: await launch({ chromiumSandbox: false }), contextFailures: 0, sandboxed: false };
    }
  };

  // A process without the sandbox serves only runs that allow one. A run that requires the
  // sandbox is refused rather than handed a page from it.
  const usableBy = (handle: ProcessHandle, policy: BrowserSandboxPolicy): ProcessHandle => {
    if (!handle.sandboxed && policy === 'require') {
      throw new BrowserSandboxRequiredError();
    }
    return handle;
  };

  const acquire = async (policy: BrowserSandboxPolicy): Promise<ProcessHandle> => {
    for (;;) {
      if (closed) {
        throw closedError();
      }
      if (current !== null && !current.process.isConnected()) {
        await discard(current);
      }
      if (current !== null) {
        return usableBy(current, policy);
      }
      launching ??= launchHandle(policy)
        .then((handle) => {
          current = handle;
          return handle;
        })
        .finally(() => {
          launching = null;
        });
      let launched: ProcessHandle;
      try {
        launched = await launching;
      } catch (error) {
        // The launch this open shared was started by a run that requires the sandbox, and it was
        // refused. That refusal is not this run's when it allows the fallback, so it starts its own.
        if (isBrowserSandboxRefusal(error) && policy === 'auto') {
          continue;
        }
        throw error;
      }
      if (closed) {
        // close() ran while the launch was in flight. It awaited the same launch and closed the
        // process, so there is nothing to hand out.
        throw closedError();
      }
      return usableBy(launched, policy);
    }
  };

  const openPage = async (url: string, options: RealBrowserOptions): Promise<Page> => {
    const handle = await acquire(options.browserSandbox ?? 'auto');
    const launched = handle.process;
    const readyTimeoutMs = readyTimeoutMsFor(options);

    let context: Awaited<ReturnType<LaunchedBrowser['newContext']>>;
    try {
      context = await launched.newContext(
        options.storageStatePath === undefined ? {} : { storageState: options.storageStatePath },
      );
    } catch (error) {
      handle.contextFailures += 1;
      // A process that has died, or one that stays connected but cannot make a context any more,
      // is forgotten so the next open launches a fresh one instead of failing forever.
      if (!launched.isConnected() || handle.contextFailures >= maxContextFailures) {
        await discard(handle);
      }
      throw redactStorageStatePath(error, options.storageStatePath);
    }
    handle.contextFailures = 0;

    // From here a context exists. Any failure below must close it, or an authenticated page opened
    // from the run's storage state stays alive with nothing holding it.
    try {
      const page = await context.newPage();
      // Attach the in-flight tracker before navigating, so the navigation's own requests are
      // counted and readiness cannot read idle off a page whose first responses have not landed.
      const network = makeNetworkActivityTracker(page);
      const cdp = await context.newCDPSession(page);
      await cdp.send('Accessibility.enable');
      // Before navigating, so the first live update the screen makes is heard. Late injection would
      // under-report announcements and create a false sense of coverage.
      await installLiveCapture(cdp, false);
      // open() owns navigation and gotoReady() only waits for readiness. Navigation takes the same
      // budget, so one config number covers the whole cost of reaching a screen.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: readyTimeoutMs });
      const wrapped = wrapPage(page, context, cdp, readyTimeoutMs, network);
      // A page from a process without the sandbox says so, and the check runner carries that onto
      // the screen in the Result.
      return handle.sandboxed ? wrapped : { ...wrapped, browserSandbox: 'off' };
    } catch (error) {
      await context.close().catch(() => undefined);
      // A failure with the process gone means the process died under us. Forget it so the next
      // open relaunches instead of failing against a dead reference. A failure with the process
      // still connected is the page's own problem and the process stays.
      if (!launched.isConnected()) {
        await discard(handle);
      }
      // Belt and braces. Nothing below newContext reads the storage state file, so no error here
      // should carry the path, but this is the last point before the message becomes a coverage
      // gap in a pull request comment and the cost of being wrong is a leaked private path.
      throw redactStorageStatePath(error, options.storageStatePath);
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
    close(): Promise<void> {
      closed = true;
      closing ??= (async (): Promise<void> => {
        if (launching !== null) {
          // A launch is in flight. Wait for it so the process it produces is the one closed here,
          // rather than left running because close() looked before it existed.
          await launching.catch(() => undefined);
        }
        const open = current;
        current = null;
        if (open !== null) {
          await open.process.close();
        }
      })();
      return closing;
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
  ports: { launch?: (launch: ScanBrowserLaunch) => Promise<LaunchedBrowser> } = {},
): BrowserDriver {
  const shared = makeSharedBrowser(ports);
  const view = shared.driver(options);
  return {
    open: (url: string) => view.open(url),
    close: () => shared.close(),
  };
}

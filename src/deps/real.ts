/// <reference lib="dom" />
/**
 * Real BrowserDriver backed by Playwright + CDP accessibility reads.
 * This unit never mints a verdict, never approximates names from the DOM, and never hides AX read failures.
 * Missing or ignored AX nodes stay null so downstream layers disclose not-covered and unverified honestly.
 */
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page as PwPage } from 'playwright';
import type { ActionSettle, AncestorAttributesRead, AnnouncementDrain, AnnouncementUndecidable, ApiResponse, AxNode, BrowserDriver, ElementTarget, FocusUnreadable, HostMarkup, Page, ReadinessOutcome, ReadinessProbe, RowContextRead } from '../contracts/index.js';
import { applyAxeTags, type AxeUncheckedFrame } from '../providers/axe/index.js';
import { normalizeAxeResults, type AxeRunResultBuckets } from '../providers/axe/raw.js';
import { carryPlaywrightPage, registerPlaywrightPage } from '../providers/engines/shared.js';
import { createLiveResolver } from '../providers/rulepack/live-value.js';
import { runAxeInIsolatedWorld } from './axe-world.js';
import { BrowserSandboxRequiredError, isBrowserSandboxRefusal, isSandboxLaunchFailure, type BrowserSandboxPolicy } from './sandbox.js';
import {
  blockedOriginLabel,
  decideRedirectResponse,
  decideRequest,
  decideServerAddress,
  decideWebSocket,
  type BrowserIsolation,
} from '../judge/request-filter.js';

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
// How many equal element counts in a row, 500 ms apart, a voice contract step needs before the page
// counts as having reacted. Five reads span 2 seconds, one read more than readiness uses. A page
// that changes only the text of a live region, with no element added and no request sent, is
// invisible to the count and the network, and only the live record below sees it. Two seconds is
// the window that record has to catch an update that lands well after the action: an announcement
// 1.6 seconds after a click falls inside it, and the live-record check then holds the wait open.
const ACTION_SETTLE_SAMPLES_REQUIRED = 5;
// The most a voice contract waits for the page to react to one step before it reads focus and
// drains the live record. The readiness budget above is sized for a whole page load on a slow
// application, which would let one step stall a scan for a minute. One action needs far less, but
// a delete that removes its row when a slow request answers changes the page well after the click,
// and every change restarts the 2 second window, so a short cap would leave that window undecided
// on every run. Only a page that never settles pays the whole cap, and its window then becomes a
// gap that says so, never a miss and never a pass. A page that settles returns as soon as it does.
export const ACTION_SETTLE_CAP_MS = 6_000;

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
  // The scope is the tree the element sits in: a document, or a shadow root. Ids are looked up in it,
  // because an id names an element only inside its own tree. Node types are compared by number,
  // because an element in a frame has that frame's own constructors.
  const ELEMENT_NODE = 1;
  const FRAGMENT_NODE = 11;
  const idNamesOnly = (element, scope) => {
    let matches;
    try {
      matches = scope.querySelectorAll('#' + escapeCss(element.id));
    } catch (_error) {
      return false;
    }
    return matches.length === 1 && matches[0] === element;
  };
  const pathIn = (element, scope) => {
    if (element.id && idNamesOnly(element, scope)) {
      return '#' + escapeCss(element.id);
    }
    const segments = [];
    let current = element;
    while (current !== null && current.nodeType === ELEMENT_NODE) {
      if (current.id && idNamesOnly(current, scope)) {
        segments.unshift('#' + escapeCss(current.id));
        break;
      }
      let index = 1;
      let sibling = current.previousElementSibling;
      while (sibling !== null) {
        index += 1;
        sibling = sibling.previousElementSibling;
      }
      const parent = current.parentElement;
      if (!parent) {
        // The top of a document is its one root element, named by its tag. The top of a shadow
        // root can hold several elements, so the position stays in the path.
        const tag = current.tagName.toLowerCase();
        segments.unshift(scope.nodeType === FRAGMENT_NODE ? tag + ':nth-child(' + String(index) + ')' : tag);
        break;
      }
      segments.unshift(current.tagName.toLowerCase() + ':nth-child(' + String(index) + ')');
      current = parent;
    }
    return segments.join(' > ');
  };
  const pathFor = (element) => {
    if (!(element instanceof Element)) {
      return '';
    }
    return pathIn(element, document);
  };
`;

// Browser-side helper that follows focus from the document into open shadow roots and same-origin
// frames, to the element that really has focus. document.activeElement stops at the host of a
// shadow root and at a frame, so every control inside one has the host's or the frame's path. A walk
// then reads the second control as a return to the first, ends as if the focus order were done, and
// never reaches the controls after it. The path joins the path of each tree in turn, so every
// control has its own. An element outside every shadow root and frame keeps its path from pathFor.
// A frame whose document cannot be read, such as one from another origin, is reported, never
// guessed. A closed shadow root cannot be seen from here at all, nor can a frame owner other than
// an iframe or a frame; see readFocus. Keep this the only implementation: the row read uses it
// too, so row keys and walk paths always name the same element.
const DEEP_FOCUS_IMPL = `
  ${PATH_FOR_IMPL}
  const FOCUS_DEPTH_LIMIT = 1024;
  const SHADOW_STEP = ' >> ';
  const FRAME_STEP = ' >> internal:control=enter-frame >> ';
  const deepFocus = () => {
    const first = document.activeElement;
    if (!(first instanceof Element)) {
      return { element: null, path: '', unreadable: null };
    }
    let element = first;
    let path = pathFor(first);
    for (let depth = 0; ; depth += 1) {
      if (depth >= FOCUS_DEPTH_LIMIT) {
        return { element, path, unreadable: 'focus-too-deep' };
      }
      const root = element.shadowRoot;
      const inShadow = root ? root.activeElement : null;
      if (inShadow) {
        path += SHADOW_STEP + pathIn(inShadow, root);
        element = inShadow;
        continue;
      }
      const tag = element.tagName.toLowerCase();
      if (tag !== 'iframe' && tag !== 'frame') {
        break;
      }
      let inner = null;
      try {
        inner = element.contentDocument;
      } catch (_error) {
        inner = null;
      }
      if (!inner) {
        return { element, path, unreadable: 'frame-unreadable' };
      }
      const active = inner.activeElement;
      // A focused frame whose own document has nothing focused is itself the focused element.
      if (!active || active === inner.body || active === inner.documentElement) {
        break;
      }
      path += FRAME_STEP + pathIn(active, inner);
      element = active;
    }
    return { element, path, unreadable: null };
  };
`;

/**
 * Browser-side helper: what one element says about hiding its subtree from assistive technology,
 * in the shape liveResolver.hiddenInChain reads. A dialog element without the open attribute is
 * closed: the browser renders none of its content and leaves it out of the accessibility tree. A
 * page that writes a live region inside a dialog and closes the dialog in the same task has closed
 * it by the time the observer reads the change, so no screen reader speaks the text. Exported so
 * the rule can be tested on its own.
 */
export const HIDDEN_FACTS_IMPL = `
  const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
  const hiddenFacts = (element) => ({
    ariaHidden: element.getAttribute('aria-hidden'),
    inert: element.hasAttribute('inert'),
    hidden: element.hasAttribute('hidden'),
    closedDialog: element.namespaceURI === HTML_NAMESPACE && element.localName === 'dialog' && !element.hasAttribute('open'),
  });
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
// from it is not recorded; see the observer below. Nor is a change inside content hidden from
// assistive technology, by aria-hidden, inert, hidden, or a closed dialog anywhere on that walk.
// The same resolver holds that rule.
// The resolver, the flat-tree parent, and the open-modal test, shared by the capture, the closed
// shadow root check at drain, and the keyboard walk's modal read, so all three read a modal the
// same way.
const MODAL_RULE_IMPL = `
  const liveResolver = (${createLiveResolver.toString()})();
  ${HIDDEN_FACTS_IMPL}
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
  // Whether an element is a modal dialog open now. A dialog opened with showModal() is one, by the
  // browser's own :modal state. So is an element whose first recognized role is dialog or
  // alertdialog with aria-modal true, while it is connected and shown: rendered, not hidden by
  // visibility, and not under aria-hidden, inert, or hidden on the flat tree. Safari with VoiceOver
  // hides everything outside such a dialog while it is shown, and Chromium does on Mac and Android
  // while focus is inside it, so content outside it may not be spoken at all. parentOf climbs the
  // hidden chain: the flat-tree parent here, and one that also climbs out of same-origin frames for
  // the keyboard walk.
  const isOpenModalOn = (element, parentOf) => {
    if (element.localName === 'dialog' && element.matches(':modal')) {
      return true;
    }
    if (!element.isConnected || !liveResolver.ariaModalDialog({ role: element.getAttribute('role'), ariaModal: element.getAttribute('aria-modal') })) {
      return false;
    }
    if (!element.checkVisibility({ visibilityProperty: true })) {
      return false;
    }
    const chain = [];
    for (let current = element; current; current = parentOf(current)) {
      chain.push(hiddenFacts(current));
    }
    return !liveResolver.hiddenInChain(chain);
  };
  const isOpenModal = (element) => isOpenModalOn(element, flatParent);
`;

const LIVE_CAPTURE_IMPL = `
  ${MODAL_RULE_IMPL}
  // The element whose region the change belongs to: the nearest one that sets a live value, when
  // that value is polite or assertive. Null when the change is not live, and null when anything on
  // the walk hides its subtree from assistive technology: the changed element, a wrapper between it
  // and the region, the region itself, or anything above the region, such as a closed dialog. A
  // screen reader says nothing for that change, so recording it would let a flow requirement pass
  // on words no one heard.
  //
  // A change outside an open modal dialog is not recorded either. While a dialog opened with
  // showModal() is open, Chromium leaves everything outside the top one out of the accessibility
  // tree. openModals gives the open modal dialogs, read when the change is observed.
  const liveHost = (start, openModals) => {
    const elements = [];
    const chain = [];
    for (let current = start; current instanceof Element; current = flatParent(current)) {
      elements.push(current);
      chain.push({
        ariaLive: current.getAttribute('aria-live'),
        role: current.getAttribute('role'),
        ...hiddenFacts(current),
      });
    }
    if (liveResolver.hiddenInChain(chain) || liveResolver.effectiveLiveValue(chain) === 'off') {
      return null;
    }
    if (outsideModals(elements, openModals())) {
      return null;
    }
    return elements[liveResolver.nearestLiveSetter(chain)] ?? null;
  };
  // Whether a flat-tree chain, the element first, sits outside any of the open modal dialogs.
  const outsideModals = (elements, modals) =>
    modals.size > 0 && liveResolver.blockedByModal(elements.map((element) => ({ modal: modals.has(element) })), modals.size);
  const flatChain = (start) => {
    const elements = [];
    for (let current = start; current instanceof Element; current = flatParent(current)) {
      elements.push(current);
    }
    return elements;
  };
  // Every modal dialog open now (see isOpenModal), in the document and in every open shadow root,
  // because a modal dialog in a web component blocks the whole document too. A modal dialog inside
  // a closed shadow root cannot be found from here; see closedShadowModalOpen.
  const findOpenModals = () => {
    const found = new Set();
    const scopes = [document];
    for (let scope = scopes.pop(); scope !== undefined; scope = scopes.pop()) {
      for (const dialog of scope.querySelectorAll('dialog:modal, [aria-modal]')) {
        if (isOpenModal(dialog)) {
          found.add(dialog);
        }
      }
      for (const element of scope.querySelectorAll('*')) {
        if (element.shadowRoot) {
          scopes.push(element.shadowRoot);
        }
      }
    }
    return found;
  };
  const buffer = [];
  const toText = (value) => {
    const normalized = (value ?? '').trim();
    return normalized.length > 0 ? normalized : null;
  };
  // Each entry keeps the element whose change it records, so the drain can check it again.
  // When the record last received an entry, by this world's clock. The settle wait after a voice
  // contract step reads it without draining, so a live region whose text changes late, with no
  // element added and no request sent, still holds the wait open.
  let lastRecordedAt = null;
  const push = (value, start) => {
    const text = toText(value);
    if (text !== null) {
      buffer.push({ text, start });
      lastRecordedAt = performance.now();
    }
  };
  window.__usablLiveQuietFor = (windowMs) => lastRecordedAt === null || performance.now() - lastRecordedAt >= windowMs;
  // Modal state and hidden state are read when a change is observed, and again here. A page can
  // write a region and open a modal in a later task, or close the dialog that holds the region one
  // task or one promise later, before the browser updates the accessibility tree, so a screen
  // reader likely hears nothing. The state at drain decides, so the answer does not depend on which
  // ran first. A change on an element that has left the document cannot be checked against a modal
  // open now, so the drain says so instead of guessing.
  window.__usablDrain = () => {
    const entries = buffer.splice(0, buffer.length);
    const texts = [];
    let undecidable = null;
    if (entries.length === 0) {
      return { texts, undecidable };
    }
    const modals = findOpenModals();
    for (const entry of entries) {
      if (liveResolver.hiddenInChain(flatChain(entry.start).map(hiddenFacts))) {
        continue;
      }
      if (modals.size === 0) {
        texts.push(entry.text);
      } else if (!entry.start.isConnected) {
        undecidable = 'changed-element-removed';
      } else if (!outsideModals(flatChain(entry.start), modals)) {
        texts.push(entry.text);
      }
    }
    return { texts, undecidable };
  };
  const observer = new MutationObserver((mutations) => {
    // Text the parser is still writing is the page being built, not an announcement, and the
    // capture has never counted it. The check reads the document's own state, so page script
    // cannot change it.
    if (document.readyState === 'loading') {
      return;
    }
    // Read once for the whole batch, and only when a change would be recorded.
    let modals = null;
    const openModals = () => {
      if (modals === null) {
        modals = findOpenModals();
      }
      return modals;
    };
    for (const mutation of mutations) {
      const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      const host = target ? liveHost(target, openModals) : null;
      // A host in another tree is a live region inside a shadow root that the changed element is
      // slotted into. Its own text leaves out the slotted text that changed and holds text the
      // change did not make speakable, such as slot fallback text and shadow-only text. A flow
      // requirement matches the text exactly, so recording it could pass on words no screen
      // reader spoke for this change. The change is dropped instead: hearing less can only fail a
      // requirement, never pass one.
      if (host && host.getRootNode() === target.getRootNode()) {
        push(host.textContent, target);
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
  const texts = drained !== null && typeof drained === 'object' && Array.isArray(drained.texts) ? drained.texts : [];
  return {
    texts: texts.filter((entry) => typeof entry === 'string'),
    undecidable: drained !== null && typeof drained === 'object' ? drained.undecidable : null,
  };
}`;

// Whether the capture has recorded nothing for the given window, read without draining it. A
// document without the capture throws, the same as the drain, rather than reading as quiet.
const LIVE_QUIET_FUNCTION = `function (windowMs) {
  const quietFor = window.__usablLiveQuietFor;
  if (typeof quietFor !== 'function') {
    throw new Error('the announcement capture is not running in this document');
  }
  return quietFor(windowMs) === true;
}`;

async function liveRecordQuiet(cdp: CDPSession): Promise<boolean> {
  return (await callInWorld(cdp, LIVE_WORLD, 'read announcements', LIVE_QUIET_FUNCTION, [NETWORK_QUIET_WINDOW_MS])) === true;
}

const UNDECIDABLE_REASONS: ReadonlySet<string> = new Set<AnnouncementUndecidable>(['closed-shadow-modal', 'changed-element-removed']);

async function drainCapture(cdp: CDPSession): Promise<AnnouncementDrain> {
  const drained = await callInWorld(cdp, LIVE_WORLD, 'read announcements', DRAIN_FUNCTION);
  const texts = getProp(drained, 'texts');
  const undecidable = getProp(drained, 'undecidable');
  if (undecidable !== null && (typeof undecidable !== 'string' || !UNDECIDABLE_REASONS.has(undecidable))) {
    throw new Error('the browser could not read announcements: the capture returned an unknown reason');
  }
  return {
    texts: Array.isArray(texts) ? texts.filter((entry): entry is string => typeof entry === 'string') : [],
    undecidable: undecidable as AnnouncementUndecidable | null,
  };
}

// Whether the element it is called on is a modal dialog open now, by the capture's own rule.
const OPEN_MODAL_FUNCTION = `function () {
  ${MODAL_RULE_IMPL}
  return isOpenModal(this);
}`;

// Whether a node from the browser's DOM read carries an attribute. CDP lists attributes as name,
// value, name, value.
function hasAttribute(node: unknown, name: string): boolean {
  const attributes = getProp(node, 'attributes');
  if (!Array.isArray(attributes)) return false;
  for (let index = 0; index < attributes.length; index += 2) {
    if (attributes[index] === name) return true;
  }
  return false;
}

// Whether a modal dialog inside a closed shadow root is open now. The capture cannot see into a
// closed shadow root, so it cannot tell which regions such a modal hides from assistive
// technology. Only the browser's own DOM read over CDP reaches it. Each dialog element and each
// element with aria-modal there is asked whether it is an open modal (see isOpenModal) in the live
// world, so page script cannot answer for it. Anything but a clear "no" counts as open. A frame's
// document is not searched: a modal there blocks only its frame, and frames are not drained.
async function closedShadowModalOpen(cdp: CDPSession): Promise<boolean> {
  const documentTree: unknown = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const candidates: unknown[] = [];
  const stack: Array<{ node: unknown; closed: boolean }> = [{ node: getProp(documentTree, 'root'), closed: false }];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const { node, closed } = next;
    if (closed && (readString(getProp(node, 'localName')) === 'dialog' || hasAttribute(node, 'aria-modal'))) {
      candidates.push(getProp(node, 'backendNodeId'));
    }
    const children = getProp(node, 'children');
    if (Array.isArray(children)) {
      for (const child of children) stack.push({ node: child, closed });
    }
    const shadowRoots = getProp(node, 'shadowRoots');
    if (Array.isArray(shadowRoots)) {
      for (const root of shadowRoots) stack.push({ node: root, closed: closed || getProp(root, 'shadowRootType') === 'closed' });
    }
  }
  if (candidates.length === 0) {
    return false;
  }
  const contextId = await isolatedWorldContextId(cdp, LIVE_WORLD, 'check modal dialogs');
  for (const candidate of candidates) {
    const backendNodeId = readNumber(candidate);
    if (backendNodeId === null) {
      return true;
    }
    const resolved: unknown = await cdp.send('DOM.resolveNode', { backendNodeId, executionContextId: contextId, objectGroup: 'usabl-modal' });
    const objectId = readString(getProp(getProp(resolved, 'object'), 'objectId'));
    if (objectId === null) {
      return true;
    }
    try {
      const answered: unknown = await cdp.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: OPEN_MODAL_FUNCTION,
        returnByValue: true,
      });
      if (getProp(getProp(answered, 'result'), 'value') !== false) {
        return true;
      }
    } finally {
      await cdp.send('Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
  }
  return false;
}

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

// The path of the focused element, followed into open shadow roots and same-origin frames, or the
// empty string when there is none.
const ACTIVE_PATH_FUNCTION = `function () {
  ${DEEP_FOCUS_IMPL}
  return deepFocus().path;
}`;

// The focused element, followed the same way, or the reason it cannot be read as a string. Null
// when nothing has focus.
const DEEP_FOCUS_EXPRESSION = `(function () {
  ${DEEP_FOCUS_IMPL}
  const focus = deepFocus();
  return focus.unreadable !== null ? focus.unreadable : focus.element;
})()`;

// The paths of the open modal dialogs that hold the focused element, nearest first, each in the
// form activePath gives. The keyboard walk reads a focus cycle inside such a dialog as expected,
// not as a keyboard trap, so the read must not see a dialog that is not one. A
// dialog element counts only in the browser's own :modal state, which only showModal() gives it.
// An element whose first recognized role is dialog or alertdialog with aria-modal true counts
// while it is connected, rendered, not hidden by visibility, and not under aria-hidden, inert,
// hidden, or a closed dialog. The test is the capture's own isOpenModalOn, so the walk and the
// capture read a modal the same way. The climb follows the flat tree, so a dialog in a shadow root
// holds the light content slotted into it, and it climbs out of a same-origin frame to the frame
// element. Node types are compared by number, because an element in a frame has that frame's own
// constructors.
const ACTIVE_MODAL_DIALOGS_FUNCTION = `function () {
  ${DEEP_FOCUS_IMPL}
  ${MODAL_RULE_IMPL}
  const frameOf = (node) => {
    try {
      const view = node.ownerDocument ? node.ownerDocument.defaultView : null;
      return view ? view.frameElement : null;
    } catch (_error) {
      return null;
    }
  };
  const up = (node) => {
    if (node.assignedSlot) {
      return node.assignedSlot;
    }
    const parent = node.parentNode;
    if (parent && parent.nodeType === ELEMENT_NODE) {
      return parent;
    }
    if (parent && parent.nodeType === FRAGMENT_NODE && parent.host) {
      return parent.host;
    }
    return frameOf(node);
  };
  const deepPath = (element) => {
    const root = element.getRootNode();
    if (root.nodeType === FRAGMENT_NODE && root.host) {
      return deepPath(root.host) + SHADOW_STEP + pathIn(element, root);
    }
    const frame = frameOf(element);
    return frame ? deepPath(frame) + FRAME_STEP + pathIn(element, root) : pathIn(element, root);
  };
  const focus = deepFocus();
  const paths = [];
  for (let current = focus.element; current; current = up(current)) {
    if (isOpenModalOn(current, up)) {
      paths.push(deepPath(current));
    }
  }
  return paths;
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

// The first element an inner selector matches in the open shadow root of the first element a host
// selector matches, or null. Returned as an object, not a value, so its node can be described.
const SHADOW_ELEMENT_FUNCTION = `function (hostQuery, innerQuery) {
  const host = document.querySelector(hostQuery);
  const root = host instanceof Element ? host.shadowRoot : null;
  return root === null ? null : root.querySelector(innerQuery);
}`;

// The markup facts of the first element a selector matches, or null. Node types are compared by
// number, and every read goes through this world's own prototypes, so page script cannot change
// what an attribute, a slot assignment, or a text read returns.
const HOST_MARKUP_FUNCTION = `function (query) {
  const element = document.querySelector(query);
  if (!(element instanceof Element)) {
    return null;
  }
  const attributes = {};
  for (const attribute of Array.from(element.attributes)) {
    attributes[attribute.name] = attribute.value;
  }
  let text = '';
  for (const node of Array.from(element.childNodes)) {
    // slot="" is the default slot, the same as no slot attribute.
    const toDefaultSlot = node.nodeType === 3 || (node.nodeType === 1 && (node.getAttribute('slot') || '') === '');
    if (toDefaultSlot) {
      text += ' ' + (node.textContent || '');
    }
  }
  return { defined: element.matches(':defined'), attributes, defaultSlotText: text.replace(/\\s+/g, ' ').trim() };
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
// Sets the zoom of the root element, as a percentage. Run in an isolated world, so a page that
// redefines style writes or what counts as an element cannot stop the zoom from landing.
const SET_ZOOM_FUNCTION = `function (zoomPercent) {
  if (document.documentElement instanceof HTMLElement) {
    document.documentElement.style.zoom = zoomPercent + '%';
  }
}`;

const COMPUTED_STYLE_FUNCTION = `function (query, cssProperty) {
  const element = document.querySelector(query);
  if (!(element instanceof Element)) {
    return '';
  }
  return getComputedStyle(element).getPropertyValue(cssProperty);
}`;


// The axe results the driver hands the axe provider. The mapping lives with the provider, so an
// engine that returns axe-shaped results is read by the same code. Kept here under the names
// callers of the driver already import.
export type AxeResult = AxeRunResultBuckets;
export { mapAxeRuleSummaries, normalizeAxeResults as mapAxeResults } from '../providers/axe/raw.js';

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

// What a focus read found: the element that has focus, nothing focused, or a reason the element
// cannot be read.
type FocusRead =
  | { kind: 'element'; backendNodeId: number }
  | { kind: 'none' }
  | { kind: 'unreadable'; reason: FocusUnreadable };

const FOCUS_UNREADABLE: ReadonlySet<string> = new Set<FocusUnreadable>(['closed-shadow-root', 'frame-unreadable', 'focus-too-deep']);

// Whether any closed shadow root of an element holds focus. Page script, and every world, sees a
// closed root as no root at all, so only the browser's own DOM read can reach it. A root is asked
// for its focused element in the read world, so page script cannot answer for it. Anything but a
// clear "no" counts as holding focus: a wrong "no" would let the walk read a control inside the root
// as its host.
async function closedRootHoldsFocus(cdp: CDPSession, shadowRoots: unknown, contextId: number): Promise<boolean> {
  if (!Array.isArray(shadowRoots)) {
    return false;
  }
  for (const root of shadowRoots) {
    // A browser's own shadow root, such as the one inside a date input, is not page content.
    if (getProp(root, 'shadowRootType') !== 'closed') {
      continue;
    }
    const backendNodeId = readNumber(getProp(root, 'backendNodeId'));
    if (backendNodeId === null) {
      return true;
    }
    const resolved: unknown = await cdp.send('DOM.resolveNode', { backendNodeId, executionContextId: contextId, objectGroup: 'usabl-focus' });
    const objectId = readString(getProp(getProp(resolved, 'object'), 'objectId'));
    if (objectId === null) {
      return true;
    }
    try {
      const answered: unknown = await cdp.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function () { return this.activeElement === null; }',
        returnByValue: true,
      });
      if (getProp(getProp(answered, 'result'), 'value') !== true) {
        return true;
      }
    } finally {
      await cdp.send('Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
  }
  return false;
}

// The frame elements the focus read enters. When one of them is the element it returns, the read
// already looked inside its document and found nothing focused there.
const ENTERED_FRAME_TAGS: ReadonlySet<string> = new Set(['iframe', 'frame']);

// Whether the focused element, as the browser's own DOM read describes it, holds a frame the focus
// read did not enter. An object or embed element that shows a document is a frame owner like an
// iframe, and document.activeElement reads it for every control inside, so the walk would read the
// second control as a completed cycle. Any frame owner counts, whatever its tag: the browser gives
// it a frame id or a content document. The root element of a document also carries a frame id,
// and it owns no frame. A fencedframe counts by its tag, since its inner page may not show here.
function ownsFrameNotEntered(node: unknown): boolean {
  const tag = readString(getProp(node, 'localName'))?.toLowerCase() ?? '';
  if (tag === 'fencedframe') {
    return true;
  }
  if (ENTERED_FRAME_TAGS.has(tag) || tag === 'html') {
    return false;
  }
  return getProp(node, 'frameId') !== undefined || getProp(node, 'contentDocument') !== undefined;
}

/**
 * Reads the element that has focus, followed into open shadow roots and same-origin frames, and
 * checks that it is not the host of a closed shadow root that holds focus. Read in the read world,
 * so a page that redefines the activeElement or shadowRoot getters cannot point the read at an
 * element that does not hold focus.
 */
async function readFocus(cdp: CDPSession): Promise<FocusRead> {
  const contextId = await isolatedWorldContextId(cdp, READ_WORLD, 'read the focused element');
  const evaluated: unknown = await cdp.send('Runtime.evaluate', {
    expression: DEEP_FOCUS_EXPRESSION,
    contextId,
    objectGroup: 'usabl-active-node',
    includeCommandLineAPI: false,
  });
  const exception = getProp(evaluated, 'exceptionDetails');
  if (exception !== undefined) {
    const description = readString(getProp(getProp(exception, 'exception'), 'description'))?.split('\n')[0];
    throw new Error(`the browser could not read the focused element: ${description ?? readString(getProp(exception, 'text')) ?? 'unknown error'}`);
  }

  const result = getProp(evaluated, 'result');
  const reason = readString(getProp(result, 'value'));
  if (reason !== null) {
    if (!FOCUS_UNREADABLE.has(reason)) {
      throw new Error('the browser could not read the focused element: the read returned an unknown reason');
    }
    return { kind: 'unreadable', reason: reason as FocusUnreadable };
  }
  const objectId = readString(getProp(result, 'objectId'));
  if (objectId === null) {
    return { kind: 'none' };
  }

  try {
    const described: unknown = await cdp.send('DOM.describeNode', { objectId, depth: 1, pierce: true });
    const node = getProp(described, 'node');
    if (ownsFrameNotEntered(node)) {
      return { kind: 'unreadable', reason: 'frame-unreadable' };
    }
    if (await closedRootHoldsFocus(cdp, getProp(node, 'shadowRoots'), contextId)) {
      return { kind: 'unreadable', reason: 'closed-shadow-root' };
    }
    const backendNodeId = readNumber(getProp(node, 'backendNodeId'));
    return backendNodeId === null ? { kind: 'none' } : { kind: 'element', backendNodeId };
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId }).catch(() => undefined);
  }
}

const SHADOW_NODE_GROUP = 'usabl-shadow-node';

/**
 * The backend node of the first element innerSelector matches inside the open shadow root of the
 * host hostSelector names, found in the read world so page script cannot answer for it. Null when
 * there is no such element. Exported for its tests.
 */
export async function backendNodeIdInShadowRoot(cdp: CDPSession, hostSelector: string, innerSelector: string): Promise<number | null> {
  const contextId = await isolatedWorldContextId(cdp, READ_WORLD, 'read an element in a shadow root');
  // Every object this read makes, the found element or a thrown value, lands in this group, and the
  // group is released however the read ends.
  try {
    const evaluated: unknown = await cdp.send('Runtime.evaluate', {
      expression: `(${SHADOW_ELEMENT_FUNCTION})(${JSON.stringify(hostSelector)}, ${JSON.stringify(innerSelector)})`,
      contextId,
      objectGroup: SHADOW_NODE_GROUP,
      includeCommandLineAPI: false,
    });
    const exception = getProp(evaluated, 'exceptionDetails');
    if (exception !== undefined) {
      const description = readString(getProp(getProp(exception, 'exception'), 'description'))?.split('\n')[0];
      throw new Error(`the browser could not read an element in a shadow root: ${description ?? readString(getProp(exception, 'text')) ?? 'unknown error'}`);
    }
    const objectId = readString(getProp(getProp(evaluated, 'result'), 'objectId'));
    if (objectId === null) {
      return null;
    }
    const described: unknown = await cdp.send('DOM.describeNode', { objectId });
    return readNumber(getProp(getProp(described, 'node'), 'backendNodeId'));
  } finally {
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: SHADOW_NODE_GROUP }).catch(() => undefined);
  }
}

// Reads a HostMarkup the read world returned, keeping only well-formed fields.
function readHostMarkup(value: unknown): HostMarkup | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const attributes: Record<string, string> = {};
  const raw = getProp(value, 'attributes');
  if (raw !== null && typeof raw === 'object') {
    for (const [name, attribute] of Object.entries(raw)) {
      if (typeof attribute === 'string') {
        attributes[name] = attribute;
      }
    }
  }
  return {
    defined: getProp(value, 'defined') === true,
    attributes,
    defaultSlotText: readString(getProp(value, 'defaultSlotText')) ?? '',
  };
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
 * The target must name exactly one element (see ElementTarget), or the read is of the element that
 * has focus. A selector the page cannot parse, one that matches nothing (the element went away
 * after the scanner saw it), one that matches more than one element, and a frame usabl cannot look
 * inside are all 'unreadable'. Only an element that was found, and is outside every body row of a
 * keyed table, is 'none'.
 *
 * Every step below walks the tree the element is drawn in, not only its own document: up from an
 * element in a shadow root to its host, and up from a same-origin frame's document to the frame
 * element. Searches go the other way, into every open shadow root and every same-origin frame. A
 * button in a web component in a keyed row, or in a frame in a keyed row, sits in that row.
 * Without this, axe's one-selector-per-boundary target named nothing, or several elements, and the
 * screen read as not covered on every run.
 *
 * A table is a `table` or an element with role table, grid, or treegrid. A `table` whose first role
 * token is presentation or none is a layout table and not a table, unless one of its own rows
 * carries a key source: a layout table that wraps a data table made every row of the data table
 * read as nested in an unkeyed row. Its rows are not rows, so the walk goes on to the next row
 * above. A table's rows are the `tr` and `role="row"` elements whose nearest table is that table,
 * so a row of a nested table is never counted as a row of the table around it. Header and footer
 * rows, those inside `thead` or `tfoot` or holding a column header, are not body rows.
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
  // One entry per document, outermost first, as in ElementTarget. Null reads the focused element.
  target: string[][] | null;
  limit: number;
  textLimit: number;
  nestingLimit: number;
}

// What the shared focus read (DEEP_FOCUS_IMPL) hands the row read.
type DeepFocus = () => { element: Element | null; unreadable: string | null };

// The row read, as a function sent to the row world with each call. It must use nothing from
// outside its own body and its arguments: it runs in the browser from its source text. The focus
// read is passed in from DEEP_FOCUS_IMPL, so row keys and walk paths name the same element.
const READ_ROW_CONTEXT = ({ target, limit, textLimit, nestingLimit }: RowReadArgs, deepFocus: DeepFocus) => {
  const CANDIDATE_TABLE = 'table, [role="table"], [role="grid"], [role="treegrid"]';
  const ROW = 'tr, [role="row"]';
  // Node types are compared by number. An element in a frame has that frame's own constructors, so
  // instanceof against this document's Element or ShadowRoot is false for it.
  const ELEMENT_NODE = 1;
  const DOCUMENT_NODE = 9;
  const FRAGMENT_NODE = 11;
  const GENERATED = /^OUIA-Generated-|pf-random-id-|:r[0-9a-z]+:|«r[0-9a-z]+»|_r_[0-9a-z]+_/i;
  const ROW_ATTRIBUTES = ['data-row-key', 'data-key', 'data-id', 'data-ouia-component-id', 'id'];
  const TABLE_ATTRIBUTES = ['id', 'data-ouia-component-id', 'data-table-key'];
  type Ambiguity = 'row-key-missing' | 'row-key-duplicate' | 'row-key-too-long' | 'table-ambiguous' | 'enclosing-row-unkeyed';

  type Unreadable = 'selector-invalid' | 'element-missing' | 'element-multiple' | 'frame-unreadable';
  const unreadable = (reason: Unreadable) => ({ kind: 'unreadable' as const, reason });

  // The document inside a frame element, or null when the element is not a frame or the document
  // is from another origin.
  const frameDocument = (element: Element): Document | null => {
    const tag = element.tagName.toLowerCase();
    if (tag !== 'iframe' && tag !== 'frame') return null;
    try {
      return (element as HTMLIFrameElement).contentDocument;
    } catch {
      return null;
    }
  };

  // The parent on the drawn tree: the parent element, else the host of a shadow root, else the
  // frame element that holds a document.
  const parentOf = (element: Element): Element | null => {
    if (element.parentElement !== null) return element.parentElement;
    const parent = element.parentNode;
    if (parent === null) return null;
    if (parent.nodeType === FRAGMENT_NODE) {
      const host = (parent as ShadowRoot).host;
      return host !== undefined && host !== null && host.nodeType === ELEMENT_NODE ? host : null;
    }
    if (parent.nodeType === DOCUMENT_NODE) {
      try {
        return (parent as Document).defaultView?.frameElement ?? null;
      } catch {
        return null;
      }
    }
    return null;
  };
  const nearest = (start: Element | null, test: (element: Element) => boolean): Element | null => {
    for (let current = start; current !== null; current = parentOf(current)) {
      if (test(current)) return current;
    }
    return null;
  };
  // Every element under a root that matches a selector, through every open shadow root and every
  // same-origin frame under it. The root itself is not included.
  const queryDrawn = (root: Element | Document, selector: string): Element[] => {
    const out: Element[] = [];
    const scopes: Array<Element | Document | ShadowRoot> = [root];
    for (let next = scopes.pop(); next !== undefined; next = scopes.pop()) {
      out.push(...Array.from(next.querySelectorAll(selector)));
      for (const element of Array.from(next.querySelectorAll('*'))) {
        if (element.shadowRoot !== null) scopes.push(element.shadowRoot);
        const inner = frameDocument(element);
        if (inner !== null) scopes.push(inner);
      }
    }
    return out;
  };

  // The one element a target names, part by part across frames and shadow roots.
  type Resolved = { element: Element } | ReturnType<typeof unreadable>;
  const resolveTarget = (levels: string[][]): Resolved => {
    if (levels.length === 0) return unreadable('selector-invalid');
    let found: Element | null = null;
    for (const [level, selectors] of levels.entries()) {
      if (selectors.length === 0) return unreadable('selector-invalid');
      let scope: Document | ShadowRoot = document;
      if (level > 0) {
        const inner = found === null ? null : frameDocument(found);
        if (inner === null) return unreadable('frame-unreadable');
        scope = inner;
      }
      for (const [step, selector] of selectors.entries()) {
        if (step > 0) {
          const root: ShadowRoot | null = found === null ? null : found.shadowRoot;
          if (root === null) return unreadable('element-missing');
          scope = root;
        }
        let matches: Element[];
        try {
          matches = Array.from(scope.querySelectorAll(selector));
        } catch {
          return unreadable('selector-invalid');
        }
        if (matches.length === 0) return unreadable('element-missing');
        if (matches.length > 1) return unreadable('element-multiple');
        found = matches[0] as Element;
      }
    }
    return found === null ? unreadable('element-missing') : { element: found };
  };

  // The element that has focus, from the same read the walk takes its paths from.
  const focusedElement = (): Resolved => {
    const focus = deepFocus();
    if (focus.unreadable === 'frame-unreadable') return unreadable('frame-unreadable');
    if (focus.unreadable !== null || focus.element === null) return unreadable('element-missing');
    return { element: focus.element };
  };

  // The result is wrapped, so an element can never be read as a refusal: a track element has a
  // property named kind.
  const resolved = target === null ? focusedElement() : resolveTarget(target);
  if (!('element' in resolved)) return resolved;
  const element = resolved.element;

  // A layout table: a table element whose first role token is presentation or none. It is still a
  // table when one of its own rows carries a key source, because rows a user can tell apart are a
  // list whatever the role says, and leaving them out would key their controls the old way.
  const isCandidate = (candidate: Element): boolean => candidate.matches(CANDIDATE_TABLE);
  const firstRoleToken = (candidate: Element): string =>
    (candidate.getAttribute('role') ?? '').replace(/[A-Z]/g, (ch) => ch.toLowerCase()).trim().split(/[\t\n\f\r ]+/)[0] ?? '';
  const layoutCache = new Map<Element, boolean>();
  // Where a row's key can come from, in order: each row attribute, then a row header.
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
  // Whether a layout table's own rows, those whose nearest candidate table is it, carry a key.
  const rowsCarryKeys = (table: Element): boolean =>
    queryDrawn(table, ROW)
      .filter((row) => nearest(parentOf(row), isCandidate) === table)
      .some((row) => SOURCES.some(([, read]) => read(row) !== null));
  const isTable = (candidate: Element): boolean => {
    if (!isCandidate(candidate)) return false;
    if (candidate.tagName.toLowerCase() !== 'table') return true;
    const role = firstRoleToken(candidate);
    if (role !== 'presentation' && role !== 'none') return true;
    const cached = layoutCache.get(candidate);
    if (cached !== undefined) return cached;
    const counts = rowsCarryKeys(candidate);
    layoutCache.set(candidate, counts);
    return counts;
  };
  // A row of a layout table is not a row. Whether it is is read from its nearest candidate table.
  const isRow = (candidate: Element): boolean => {
    if (!candidate.matches(ROW)) return false;
    const owner = nearest(parentOf(candidate), isCandidate);
    return owner === null || isTable(owner);
  };

  const tableOf = (row: Element): Element | null => nearest(row, isTable);
  const isBodyRow = (row: Element, table: Element): boolean => {
    const section = nearest(row, (candidate) => candidate.matches('thead, tfoot'));
    if (section !== null && tableOf(section) === table) return false;
    return !Array.from(row.children).some((cell) =>
      cell.matches('th[scope="col"], th[scope="colgroup"], [role="columnheader"]'),
    );
  };
  const bodyRows = (table: Element): Element[] =>
    queryDrawn(table, ROW).filter((row) => isRow(row) && tableOf(row) === table && isBodyRow(row, table));

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
      // Ids are looked up in the tree the table is in: its document, or its shadow root.
      const scope = table.getRootNode() as Document | ShadowRoot;
      const text = collapse(
        labelledBy
          .split(/\s+/)
          .filter((id) => id !== '')
          .map((id) => (typeof scope.getElementById === 'function' ? scope.getElementById(id)?.textContent : null) ?? '')
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
    const outerRow = nearest(parentOf(table), isRow);
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
  const allTables = queryDrawn(document, CANDIDATE_TABLE).filter(isTable);
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

  const row = nearest(element, isRow);
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

  // The path from the row down to the element. A step out of a shadow root or a frame document is
  // marked, so a path across a boundary never reads the same as one that stays in one tree.
  const steps: string[] = [];
  let current: Element | null = element;
  while (current !== null && current !== row) {
    let index = 1;
    let sibling = current.previousElementSibling;
    while (sibling !== null) {
      index += 1;
      sibling = sibling.previousElementSibling;
    }
    steps.unshift(`${current.tagName.toLowerCase()}:nth-child(${String(index)})`);
    if (current.parentElement === null) {
      const parent = current.parentNode;
      if (parent !== null && parent.nodeType === FRAGMENT_NODE) steps.unshift('#shadow-root');
      if (parent !== null && parent.nodeType === DOCUMENT_NODE) steps.unshift('#document');
    }
    current = parentOf(current);
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

// The row read with the shared focus read beside it.
const READ_ROW_FUNCTION = `function (args) {
  ${DEEP_FOCUS_IMPL}
  return (${READ_ROW_CONTEXT.toString()})(args, deepFocus);
}`;

async function rowContextFor(cdp: CDPSession, target: ElementTarget | null): Promise<RowContextRead> {
  const levels = target === null ? null : typeof target === 'string' ? [[target]] : target.map((level) => [...level]);
  const args: RowReadArgs = { target: levels, limit: ROW_KEY_LIMIT, textLimit: ROW_CONTEXT_TEXT_LIMIT, nestingLimit: TABLE_NESTING_LIMIT };
  return (await callInWorld(cdp, ROW_WORLD, 'read the table row', READ_ROW_FUNCTION, [args])) as RowContextRead;
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
  // What kept the network from going quiet, when it was something other than the page's own
  // requests, for the message when the budget runs out. Optional so a scripted page needs none.
  networkBusyDetail?(): string | null;
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
// went idle. So a screen that fetched the rest of its content after it first went idle was scanned
// before that content arrived. This tracker instead counts requests that are
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
  // Removes the tracker's listeners from the page. An adopted page stays open after usabl is done
  // with it, so its listeners have to come off rather than pile up on every check.
  stop(): void;
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
  // Optional so a test driver without it still works. Playwright's page has it.
  off?(event: 'request', handler: (request: RequestHandle) => void): void;
  off?(event: 'requestfinished' | 'requestfailed', handler: () => void): void;
  off?(event: 'response', handler: (response: ResponseEvent) => void): void;
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

  const onRequest = (request: RequestHandle): void => {
    inFlight += 1;
    if (typeof request === 'object' && request !== null) {
      sentOrder.set(request, sentCount);
    }
    sentCount += 1;
  };
  const onResponse = (response: ResponseEvent): void => {
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
  };
  page.on('request', onRequest);
  page.on('requestfinished', settled);
  page.on('requestfailed', settled);
  page.on('response', onResponse);

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
    stop(): void {
      page.off?.('request', onRequest);
      page.off?.('requestfinished', settled);
      page.off?.('requestfailed', settled);
      page.off?.('response', onResponse);
    },
  };
}

// The subset of a Playwright request the worker tracker reads.
export interface WorkerRequestHandle {
  // The service worker that issued the request, or null for a page's own request.
  serviceWorker(): unknown;
}

// The subset of a Playwright browser context the worker tracker listens to. Narrow so a test can
// drive it.
export interface WorkerRequestEvents {
  on(event: 'request' | 'requestfinished' | 'requestfailed', handler: (request: WorkerRequestHandle) => void): void;
  off?(event: 'request' | 'requestfinished' | 'requestfailed', handler: (request: WorkerRequestHandle) => void): void;
}

// One service worker version as the browser reports it over CDP.
export interface ServiceWorkerVersionState {
  versionId: string;
  status: string;
  runningStatus: string;
}

export interface WorkerActivity {
  // Whether no service worker request is in flight and no worker is being installed or activated,
  // and that has held for at least windowMs.
  quietFor(windowMs: number): boolean;
  // What is still running, or null when nothing is.
  busyDetail(): string | null;
  // Feeds a ServiceWorker.workerVersionUpdated event.
  versionsUpdated(versions: ServiceWorkerVersionState[]): void;
  stop(): void;
}

// The live service-worker signal for readiness.
//
// A service worker's requests are reported on the browser context, never on the page, so the
// page's tracker cannot see them. Content that waits for navigator.serviceWorker.ready mounts only
// after the worker's install and activate steps finish, and those can wait on a fetch, or on
// nothing the network shows at all. Without this, readiness read a quiet page while the worker
// was still installing, and the scan graded the shell before the content arrived.
//
// So two things keep the network busy here: a request a service worker issued that has not
// finished or failed, and a worker version the browser reports as installing, installed (waiting),
// or activating, or as new while its script is starting or running. A version that is new and
// stopped is one whose script was never fetched, or failed to fetch, and the browser reports
// nothing more about it, so it does not count; its script fetch is a worker request and counts on
// its own. A worker that never finishes keeps readiness waiting until the budget runs out, and the
// caller turns that into a coverage gap that names the worker.
const BUSY_VERSION_STATUSES = new Set(['installing', 'installed', 'activating']);
const RUNNING_STATUSES = new Set(['starting', 'running']);

function versionBusy(version: ServiceWorkerVersionState): boolean {
  return BUSY_VERSION_STATUSES.has(version.status) || (version.status === 'new' && RUNNING_STATUSES.has(version.runningStatus));
}

// Exported for tests. Product code reaches it through Page.gotoReady().
export function makeWorkerActivityTracker(context: WorkerRequestEvents, now: () => number = Date.now): WorkerActivity {
  const inFlight = new Set<WorkerRequestHandle>();
  const versions = new Map<string, ServiceWorkerVersionState>();
  let idleSince = now();

  const busyVersions = (): number => [...versions.values()].filter(versionBusy).length;
  const busy = (): boolean => inFlight.size > 0 || busyVersions() > 0;
  // Called after every change. Idle starts at the moment the last busy thing stopped.
  const changed = (wasBusy: boolean): void => {
    if (wasBusy && !busy()) {
      idleSince = now();
    }
  };
  const isWorkerRequest = (request: WorkerRequestHandle): boolean => {
    try {
      return request.serviceWorker() !== null;
    } catch {
      return false;
    }
  };
  const onRequest = (request: WorkerRequestHandle): void => {
    if (isWorkerRequest(request)) {
      inFlight.add(request);
    }
  };
  const onDone = (request: WorkerRequestHandle): void => {
    const wasBusy = busy();
    inFlight.delete(request);
    changed(wasBusy);
  };
  context.on('request', onRequest);
  context.on('requestfinished', onDone);
  context.on('requestfailed', onDone);

  return {
    quietFor(windowMs: number): boolean {
      return !busy() && now() - idleSince >= windowMs;
    },
    busyDetail(): string | null {
      const parts: string[] = [];
      if (inFlight.size > 0) {
        parts.push(`${inFlight.size} service worker request${inFlight.size === 1 ? '' : 's'} still in flight`);
      }
      const installing = busyVersions();
      if (installing > 0) {
        parts.push(`${installing} service worker${installing === 1 ? '' : 's'} still installing or activating`);
      }
      return parts.length === 0 ? null : parts.join(', ');
    },
    versionsUpdated(updated: ServiceWorkerVersionState[]): void {
      const wasBusy = busy();
      for (const version of updated) {
        versions.set(version.versionId, version);
      }
      changed(wasBusy);
    },
    stop(): void {
      context.off?.('request', onRequest);
      context.off?.('requestfinished', onDone);
      context.off?.('requestfailed', onDone);
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
        const busy = pw.networkBusyDetail?.() ?? null;
        throw new Error(readinessTimeout('network activity did not go quiet', timeoutMs, busy === null ? '' : ` (${busy})`));
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

/**
 * Waits for a page to react to one action, by the readiness signals waitForRendered reads, the
 * element count holding and the network quiet for the same window, plus a third: the live-region
 * record has received nothing for that window either. It has its own cap, and running out is an answer, not an error: it returns settled false and how
 * long it waited, and the caller treats that step's window as undecided. A page-side failure from
 * evaluate, such as a context destroyed by a navigation, goes through unchanged, the way it does in
 * waitForRendered, so the caller reports it rather than reading a page that is gone.
 *
 * Exported for tests. Product code reaches this through Page.settleAfterAction().
 */
export async function waitForActionSettled(
  pw: ReadinessPage,
  capMs: number,
  liveQuiet: () => Promise<boolean>,
): Promise<ActionSettle> {
  const start = Date.now();
  const deadline = start + capMs;
  let previous: number | null = null;
  let repeats = 0;
  for (;;) {
    const elements = await pw.evaluate(() => document.getElementsByTagName('*').length);
    repeats = elements === previous ? repeats + 1 : 1;
    previous = elements;
    // The live record is read last and only when the other two hold, so a quiet answer describes the
    // moment the wait ends.
    if (
      repeats >= ACTION_SETTLE_SAMPLES_REQUIRED &&
      pw.networkQuietFor(NETWORK_QUIET_WINDOW_MS) &&
      (await liveQuiet())
    ) {
      return { settled: true, waitedMs: Date.now() - start };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { settled: false, waitedMs: Date.now() - start };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(SETTLE_SAMPLE_INTERVAL_MS, remaining)));
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

// axe run options built the way applyAxeTags decides them, so the rule for tags stays in one place.
class AxeRunOptions {
  constructor(readonly value: Record<string, unknown> = {}) {}
  withTags(tags: string[]): AxeRunOptions {
    return new AxeRunOptions({ runOnly: { type: 'tag', values: tags } });
  }
}

function attachAxeBridge(page: Page, pw: PwPage, cdp: CDPSession): void {
  Object.assign(page, {
    runAxe: async (options?: { tags?: readonly string[] }): Promise<AxeResult & { uncheckedFrames: AxeUncheckedFrame[] }> => {
      // Tags apply only when the docs profile passes them. No tags means axe keeps its default
      // ruleset, so the app path runs axe exactly as before.
      const runOptions = applyAxeTags(new AxeRunOptions(), options).value;
      // axe runs in an isolated world in every frame, so page script cannot change what it reads
      // or reports. A frame it could not check comes back named, and the provider discloses it.
      const run = await runAxeInIsolatedWorld(pw, cdp, runOptions);
      return { ...normalizeAxeResults(run.results), uncheckedFrames: run.uncheckedFrames };
    },
  });
}

function wrapPage(
  pw: PwPage,
  context: BrowserContext,
  cdp: CDPSession,
  readyTimeoutMs: number,
  network: NetworkActivity,
  workers: WorkerActivity | null = null,
): Page {
  // The readiness seam: the DOM read from the page, the network signal from the live trackers.
  // The page's own requests and its service workers' both have to be quiet.
  const readiness: ReadinessPage = {
    evaluate: (fn) => pw.evaluate(fn),
    networkQuietFor: (windowMs) => network.networkQuietFor(windowMs) && (workers === null || workers.quietFor(windowMs)),
    networkBusyDetail: () => workers?.busyDetail() ?? null,
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
    async settleAfterAction(): Promise<ActionSettle> {
      return waitForActionSettled(readiness, ACTION_SETTLE_CAP_MS, () => liveRecordQuiet(cdp));
    },
    async armAnnouncementCapture(): Promise<void> {
      // The observer is already running: it starts at document start on a page usabl opens, and
      // adoptPage starts it on a page a caller hands in. Arming has nothing to do.
      return Promise.resolve();
    },
    async drainAnnouncements(): Promise<string[]> {
      return (await drainCapture(cdp)).texts;
    },
    async drainAnnouncementRecord(): Promise<AnnouncementDrain> {
      const drained = await drainCapture(cdp);
      if (drained.undecidable === null && (await closedShadowModalOpen(cdp))) {
        return { ...drained, undecidable: 'closed-shadow-modal' };
      }
      return drained;
    },
    async activeNode(): Promise<AxNode | null> {
      const focus = await readFocus(cdp);
      if (focus.kind !== 'element') {
        return null;
      }
      return axFromBackendId(cdp, focus.backendNodeId);
    },
    async activePath(): Promise<string> {
      return stablePathForActiveElement(cdp);
    },
    async activeElementKey(): Promise<string | null> {
      // The browser's own id for the node, read over CDP. It does not change while the node is in
      // the document, so a control keeps its key when the controls before it go away.
      const focus = await readFocus(cdp);
      return focus.kind === 'element' ? `node-${focus.backendNodeId}` : null;
    },
    async activeFocusUnreadable(): Promise<FocusUnreadable | null> {
      const focus = await readFocus(cdp);
      return focus.kind === 'unreadable' ? focus.reason : null;
    },
    async activeModalDialogs(): Promise<string[]> {
      const paths = await callInWorld(cdp, READ_WORLD, 'read the modal dialogs that hold focus', ACTIVE_MODAL_DIALOGS_FUNCTION);
      if (!Array.isArray(paths) || !paths.every((path): path is string => typeof path === 'string')) {
        throw new Error('the browser could not read the modal dialogs that hold focus: the read returned something other than a list of paths');
      }
      return paths;
    },
    async axAt(selector: string): Promise<AxNode | null> {
      const backendNodeId = await backendNodeIdForSelector(cdp, selector);
      if (backendNodeId === null) {
        return null;
      }
      return axFromBackendId(cdp, backendNodeId);
    },
    async axInShadowRoot(hostSelector: string, innerSelector: string): Promise<AxNode | null> {
      const backendNodeId = await backendNodeIdInShadowRoot(cdp, hostSelector, innerSelector);
      if (backendNodeId === null) {
        return null;
      }
      return axFromBackendId(cdp, backendNodeId);
    },
    async hostMarkup(selector: string): Promise<HostMarkup | null> {
      return readHostMarkup(await callInWorld(cdp, READ_WORLD, 'read element markup', HOST_MARKUP_FUNCTION, [selector]));
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
    async rowContext(target: ElementTarget): Promise<RowContextRead> {
      return rowContextFor(cdp, target);
    },
    async focusedRowContext(): Promise<RowContextRead> {
      return rowContextFor(cdp, null);
    },
    async close(): Promise<void> {
      await context.close();
    },
    async setViewport(width: number, height: number): Promise<void> {
      await pw.setViewportSize({ width, height });
    },
    async setZoom(percent: number): Promise<void> {
      await callInWorld(cdp, READ_WORLD, 'set the zoom', SET_ZOOM_FUNCTION, [percent]);
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

  attachAxeBridge(page, pw, cdp);
  // The optional commercial engines drive the Playwright page themselves. It is registered, not
  // attached, so it stays off the page object; see registerPlaywrightPage. Every copy of the page
  // made below goes through carryPlaywrightPage, so the copy keeps it.
  registerPlaywrightPage(page, pw);
  return page;
}

/**
 * Adopts a Playwright page a caller already created and navigated, so usabl can run providers on it
 * (for example from a Playwright test suite). It attaches a CDP session for AX reads and element
 * paths and installs the live-region capture, then returns a usabl Page whose close() releases only
 * what adoption added, the CDP session and the network listeners: the caller owns the page and its
 * context, so adoption must never close them. Navigation and readiness are the caller's job. The
 * browser is the caller's too: usabl did not launch it and does not change how it runs, so whether
 * it has Chromium's sandbox is the caller's choice, and the page carries no sandbox note.
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
  // close() never closes the caller's page or context. It ends usabl's own hold on the page: the
  // network listeners come off, and the CDP session is detached, which also drops the live-region
  // capture script and the accessibility domain that session set up. A session the page already
  // lost, because the caller closed it, has nothing left to detach.
  return carryPlaywrightPage(page, {
    ...page,
    close: async (): Promise<void> => {
      network.stop();
      try {
        await cdp.detach();
      } catch {
        // Already detached, or the page is gone. Either way nothing is held.
      }
    },
  });
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
  // The judge's request filter. When set, every context blocks service workers and routes every
  // request through the filter before any page exists. The judge also sets browserSandbox to
  // require, so page script runs inside Chromium's sandbox or the scan is refused.
  isolation?: BrowserIsolation;
}

/**
 * The part of a launched Playwright browser this module uses. Narrow so a test can stand in a fake
 * and drive the launch, disconnect, and relaunch logic without a real Chromium.
 */
export type LaunchedBrowser = Pick<Browser, 'newContext' | 'isConnected' | 'close'> &
  // Optional so a fake needs it only when it serves the judge, which watches worker targets with it.
  Partial<Pick<Browser, 'newBrowserCDPSession'>>;

/**
 * Watches, for the judge, the worker traffic its request filter cannot reach, from outside page
 * script.
 *
 * Playwright detaches a shared worker, so its requests are never routed or reported, and it
 * listens for WebSockets only where there is a page, so a service worker's socket passes no filter.
 * Neither can be filtered yet, so each makes the screen a coverage gap:
 * - a shared worker is seen through target discovery on a browser session, filtered to this
 *   context, the moment it is created;
 * - a service worker is attached from the page's own session, which the browser pauses at start
 *   until it is released, so its Network domain is on before its script runs and every socket it
 *   opens is reported. A service worker that discovery saw but this session never watched could
 *   have opened a socket unseen, so it is a gap too.
 * Every target the page session attaches to, a frame or a dedicated worker included, is released
 * at once, so the page runs as it would. The page session uses the non-flat protocol, because
 * Playwright does not route messages for a child session it did not create itself.
 */
async function watchUnfilteredWorkers(
  browser: LaunchedBrowser,
  page: CDPSession,
  caught: (url: string, why: string) => void,
): Promise<{ checkWatched: () => void; detach: () => Promise<void> }> {
  if (browser.newBrowserCDPSession === undefined) {
    throw new Error('the isolated browser cannot watch worker targets, so it cannot confirm their traffic is filtered');
  }
  const contextId = (await page.send('Target.getTargetInfo')).targetInfo.browserContextId;
  const browserSession = await browser.newBrowserCDPSession();
  const discovered = new Map<string, string>();
  const watched = new Set<string>();
  // The page session's child sessions on service workers, and the Network.enable request sent to
  // each, by message id.
  const workerSessions = new Map<string, { targetId: string; url: string }>();
  const enabling = new Map<number, { targetId: string; url: string }>();
  let messageId = 0;
  const sendTo = (sessionId: string, method: string): { id: number; sent: Promise<unknown> } => {
    messageId += 1;
    const id = messageId;
    return { id, sent: page.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params: {} }) }) };
  };
  try {
    browserSession.on('Target.targetCreated', ({ targetInfo }) => {
      if (targetInfo.browserContextId !== contextId) {
        return;
      }
      if (targetInfo.type === 'shared_worker') {
        caught(targetInfo.url, 'a shared worker started, and its requests cannot be filtered');
      } else if (targetInfo.type === 'service_worker') {
        discovered.set(targetInfo.targetId, targetInfo.url);
      }
    });
    await browserSession.send('Target.setDiscoverTargets', {
      discover: true,
      filter: [{ type: 'service_worker' }, { type: 'shared_worker' }],
    });
    page.on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
      if (targetInfo.type === 'service_worker') {
        const worker = { targetId: targetInfo.targetId, url: targetInfo.url };
        workerSessions.set(sessionId, worker);
        const enable = sendTo(sessionId, 'Network.enable');
        enabling.set(enable.id, worker);
        enable.sent.catch(() => caught(worker.url, 'a service worker that could not be watched for sockets'));
      }
      // Sent after Network.enable on the same session, so the target handles that first.
      sendTo(sessionId, 'Runtime.runIfWaitingForDebugger').sent.catch(() => undefined);
    });
    page.on('Target.receivedMessageFromTarget', ({ sessionId, message }) => {
      const worker = workerSessions.get(sessionId);
      if (worker === undefined) {
        return;
      }
      let parsed: { id?: unknown; error?: unknown; method?: unknown; params?: { url?: unknown } };
      try {
        parsed = JSON.parse(message) as typeof parsed;
      } catch {
        caught(worker.url, 'a service worker whose messages could not be read');
        return;
      }
      if (typeof parsed.id === 'number' && enabling.has(parsed.id)) {
        enabling.delete(parsed.id);
        if (parsed.error === undefined) {
          watched.add(worker.targetId);
        } else {
          caught(worker.url, 'a service worker that could not be watched for sockets');
        }
        return;
      }
      if (parsed.method === 'Network.webSocketCreated') {
        const url = typeof parsed.params?.url === 'string' ? parsed.params.url : worker.url;
        caught(url, 'opened by a service worker, and its sockets cannot be filtered');
      }
    });
    await page.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false });
  } catch (error) {
    await browserSession.detach().catch(() => undefined);
    throw error;
  }
  return {
    checkWatched: () => {
      for (const [targetId, url] of [...discovered].sort(([a], [b]) => a.localeCompare(b))) {
        if (!watched.has(targetId)) {
          caught(url, 'a service worker that could not be watched for sockets');
        }
      }
    },
    detach: () => browserSession.detach().catch(() => undefined),
  };
}

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

    const isolation = options.isolation;
    let context: Awaited<ReturnType<LaunchedBrowser['newContext']>>;
    try {
      // Service workers stay allowed in the judge. Playwright's block option only replaces
      // navigator.serviceWorker.register in the page, which page script can go around, and it
      // turns off routing for the workers it misses; and a suppressed worker can hide content
      // with no gap. Allowed, a worker runs and its requests pass the same context route below.
      context = await launched.newContext({
        ...(options.storageStatePath === undefined ? {} : { storageState: options.storageStatePath }),
      });
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
    // Set once the page's session exists, in the judge: the worker targets the filter cannot reach.
    let workerWatch: { checkWatched: () => void; detach: () => Promise<void> } | null = null;
    try {
      // Context-wide routing is installed before any page exists, so the first navigation, its
      // frames, its workers, and any popup all pass through the filter.
      let blockedOrigins: (() => Promise<string[]>) | null = null;
      let caughtByJudge: ((url: string, why: string) => void) | null = null;
      if (isolation !== undefined) {
        const blocked = new Set<string>();
        // Address checks wait on the browser, so the list is read only after they settle.
        const pending = new Set<Promise<void>>();
        blockedOrigins = async () => {
          while (pending.size > 0) await Promise.all([...pending]);
          workerWatch?.checkWatched();
          return [...blocked].sort();
        };
        const caught = (url: string, why: string): void => {
          blocked.add(`${blockedOriginLabel(url)} (${why})`);
          isolation.onBlocked(url);
        };
        caughtByJudge = caught;
        await context.route('**/*', async (route) => {
          const requestUrl = route.request().url();
          if (decideRequest(isolation.allowedOrigins, requestUrl) === 'allow') {
            await route.continue();
            return;
          }
          blocked.add(blockedOriginLabel(requestUrl));
          isolation.onBlocked(requestUrl);
          await route.abort('blockedbyclient');
        });
        // WebSockets bypass request routing, so they get their own filter. An allowed socket is
        // connected through to its server; any other is closed before it reaches one.
        await context.routeWebSocket(/.*/, (socket) => {
          const socketUrl = socket.url();
          if (decideWebSocket(isolation.allowedOrigins, socketUrl) === 'allow') {
            socket.connectToServer();
            return;
          }
          blocked.add(blockedOriginLabel(socketUrl));
          isolation.onBlocked(socketUrl);
          void socket.close({ code: 1008, reason: 'blocked by the usabl judge' }).catch(() => undefined);
        });
        // Playwright continues a redirect hop without the route above, so a hop cannot be
        // stopped there. Every hop is still reported, by the page and by service workers, so a hop
        // outside the allowed origins is caught here and the screen becomes a coverage gap.
        context.on('request', (request) => {
          if (request.redirectedFrom() !== null && decideRequest(isolation.allowedOrigins, request.url()) === 'block') {
            caught(request.url(), 'reached by a redirect');
          }
        });
        // An allowed origin can still be answered by a server it should not reach: an allowed
        // hostname whose DNS answer is a loopback or private address, or another loopback port.
        // A redirect response is also judged on its own Location, so a hop off the allowed set is
        // caught even if the browser reports the next request late.
        context.on('response', (response) => {
          const status = response.status();
          const redirect = status >= 300 && status < 400;
          const check = Promise.all([response.serverAddr(), redirect ? response.headerValue('location') : Promise.resolve(null)])
            .then(([address, location]) => {
              if (redirect) {
                const judged = decideRedirectResponse(isolation.allowedOrigins, response.url(), location, address);
                if (judged.hop === 'block') {
                  let target = response.url();
                  try {
                    target = new URL(location ?? '', response.url()).href;
                  } catch {
                    // A Location that is not a URL is named by the redirect that sent it.
                  }
                  caught(target, 'reached by a redirect');
                }
                if (judged.address === 'unexpected') {
                  caught(response.url(), 'answered from an unexpected address');
                }
                return;
              }
              if (address !== null && decideServerAddress(isolation.allowedOrigins, response.url(), address) === 'unexpected') {
                caught(response.url(), 'answered from an unexpected address');
              }
            })
            .catch(() => caught(response.url(), 'its server address could not be read'))
            .finally(() => pending.delete(check));
          pending.add(check);
        });
        // A socket a worker opens does not pass the socket route, which patches only the page.
        // The browser still reports it, so one outside the allowed origins is caught.
        const watchSockets = (opened: PwPage): void => {
          opened.on('websocket', (socket) => {
            if (decideWebSocket(isolation.allowedOrigins, socket.url()) === 'block') {
              const label = blockedOriginLabel(socket.url());
              // A page socket the route already closed is counted once.
              if (!blocked.has(label)) {
                blocked.add(label);
                isolation.onBlocked(socket.url());
              }
            }
          });
        };
        context.on('page', watchSockets);
      }
      const page = await context.newPage();
      // Attach the in-flight tracker before navigating, so the navigation's own requests are
      // counted and readiness cannot read idle off a page whose first responses have not landed.
      const network = makeNetworkActivityTracker(page);
      // Service-worker requests are reported on the context, and install and activation over CDP,
      // so readiness waits for them too. Both are attached before navigating, like the page's.
      const workers = makeWorkerActivityTracker(context);
      const cdp = await context.newCDPSession(page);
      if (caughtByJudge !== null) {
        // Before navigating, so a worker the page starts at once is already watched.
        workerWatch = await watchUnfilteredWorkers(launched, cdp, caughtByJudge);
      }
      cdp.on('ServiceWorker.workerVersionUpdated', (event) => workers.versionsUpdated(event.versions));
      // A browser that cannot report its workers cannot show that they finished, so the open fails
      // and the screen becomes a gap rather than a scan that may have read a shell.
      await cdp.send('ServiceWorker.enable');
      await cdp.send('Accessibility.enable');
      // Before navigating, so the first live update the screen makes is heard. Late injection would
      // under-report announcements and create a false sense of coverage.
      await installLiveCapture(cdp, false);
      // open() owns navigation and gotoReady() only waits for readiness. Navigation takes the same
      // budget, so one config number covers the whole cost of reaching a screen.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: readyTimeoutMs });
      const opened = wrapPage(page, context, cdp, readyTimeoutMs, network, workers);
      const watch = workerWatch;
      const wrapped: Page =
        blockedOrigins === null
          ? opened
          : carryPlaywrightPage(opened, {
              ...opened,
              blockedRequests: () => blockedOrigins(),
              close: async () => {
                try {
                  await opened.close();
                } finally {
                  await watch?.detach();
                }
              },
            });
      // A page from a process without the sandbox says so, and the check runner carries that onto
      // the screen in the Result.
      return handle.sandboxed ? wrapped : carryPlaywrightPage(wrapped, { ...wrapped, browserSandbox: 'off' });
    } catch (error) {
      await workerWatch?.detach();
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

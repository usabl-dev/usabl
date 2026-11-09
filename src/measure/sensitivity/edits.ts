/// <reference lib="dom" />
/**
 * The edit kinds of the sensitivity catalog, and where a reported element sits relative to the
 * elements an edit changed.
 *
 * The two browser functions here are the only script a mutation runs. They are written once in the
 * engine. A catalog entry chooses a kind and gives its values, and those values reach the page only
 * as JSON arguments, never as code. They run in the page's own world, because two kinds change how
 * the page's script behaves (a cancelled key, a focus() call that does nothing), and an isolated
 * world cannot change that.
 *
 * Measurement only. Nothing on the normal run path imports this file.
 */
import type { Page } from '../../contracts/index.js';
import type { Edit } from './catalog.js';

/**
 * Where one reported element sits relative to the changed elements.
 * - target: it is a changed element, or the parent that stands in for a removed one.
 * - inside: it sits inside one.
 * - around: it holds one.
 * - elsewhere: it is somewhere else on the page.
 * - unresolved: its path names no single element on the page now, so where it sits is unknown.
 */
export type ElementPlace = 'target' | 'inside' | 'around' | 'elsewhere' | 'unresolved';

/** An edit that took effect on the page. */
export interface AppliedEdit {
  // Read on the page as it is now, after the scan. One place per path, in order.
  locate(paths: readonly string[]): Promise<ElementPlace[]>;
  // Lets go of what the edit holds on the page.
  release(): Promise<void>;
}

export type EditOutcome = { kind: 'applied'; edit: AppliedEdit } | { kind: 'failed'; reason: string };

/** Applies one edit to the elements the target paths name, on a page the scan browser opened. */
export interface MutationEditor {
  apply(page: Page, targets: readonly string[], edit: Edit): Promise<EditOutcome>;
}

/** What the page function returns: whether the edit held, and the elements to locate against. */
export interface EditResultInPage {
  ok: boolean;
  reason: string | null;
  anchors: Element[];
}

/**
 * Applies an edit in the page. Each target is a path from Page.queryAll, which is a selector in the
 * top document that names one element. A path that names no element, or more than one, fails the
 * edit. After the change it reads the change back, so an edit the page undid or refused fails too.
 * The reasons are engine words only, never page text.
 */
export function applyEditInPage(arg: { targets: string[]; edit: Edit }): EditResultInPage {
  const NAME_ATTRIBUTES = ['aria-label', 'aria-labelledby', 'title', 'placeholder'];
  const fail = (reason: string): EditResultInPage => ({ ok: false, reason, anchors: [] });

  const elements: Element[] = [];
  for (const path of arg.targets) {
    let matches: NodeListOf<Element>;
    try {
      matches = document.querySelectorAll(path);
    } catch {
      return fail('a target path is not a selector the page can read');
    }
    const only = matches.length === 1 ? matches[0] : undefined;
    if (only === undefined) {
      return fail('a target element could not be found again as one element');
    }
    elements.push(only);
  }

  const clearText = (root: Node, keep: Node | null): void => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    while (walker.nextNode() !== null) {
      texts.push(walker.currentNode as Text);
    }
    for (const text of texts) {
      if (keep === null || !keep.contains(text)) {
        text.data = '';
      }
    }
  };

  const anchors: Element[] = [];
  const edit = arg.edit;
  for (const element of elements) {
    switch (edit.kind) {
      case 'remove-attribute': {
        for (const name of edit.names) {
          element.removeAttribute(name);
        }
        if (edit.names.some((name) => element.hasAttribute(name))) {
          return fail('the page kept an attribute the edit removed');
        }
        anchors.push(element);
        break;
      }
      case 'set-attribute': {
        element.setAttribute(edit.name, edit.value);
        if (element.getAttribute(edit.name) !== edit.value) {
          return fail('the page did not keep the attribute the edit set');
        }
        anchors.push(element);
        break;
      }
      case 'replace-role': {
        element.setAttribute('role', edit.role);
        if (element.getAttribute('role') !== edit.role) {
          return fail('the page did not keep the role the edit set');
        }
        anchors.push(element);
        break;
      }
      case 'remove-text-name': {
        for (const name of NAME_ATTRIBUTES) {
          element.removeAttribute(name);
        }
        for (const inner of Array.from(element.querySelectorAll('[aria-label], [aria-labelledby], [title]'))) {
          for (const name of ['aria-label', 'aria-labelledby', 'title']) {
            inner.removeAttribute(name);
          }
        }
        for (const image of Array.from(element.querySelectorAll('img[alt], area[alt], input[type="image"][alt]'))) {
          image.setAttribute('alt', '');
        }
        clearText(element, null);
        const labels = 'labels' in element ? (element as HTMLInputElement).labels : null;
        for (const label of labels === null ? [] : Array.from(labels)) {
          // A label that wraps its field keeps the field, so only its own text goes.
          clearText(label, element);
          for (const name of NAME_ATTRIBUTES) {
            label.removeAttribute(name);
          }
        }
        if ((element.textContent ?? '').trim() !== '' || NAME_ATTRIBUTES.some((name) => element.hasAttribute(name))) {
          return fail('the page kept a text name the edit removed');
        }
        anchors.push(element);
        break;
      }
      case 'set-style': {
        if (!(element instanceof HTMLElement || element instanceof SVGElement)) {
          return fail('the target cannot carry an inline style');
        }
        for (const [property, value] of Object.entries(edit.styles)) {
          element.style.setProperty(property, value, 'important');
          if (element.style.getPropertyValue(property) === '') {
            return fail('the page did not keep a style the edit set');
          }
        }
        anchors.push(element);
        break;
      }
      case 'remove-element': {
        anchors.push(element.parentElement ?? document.documentElement);
        element.remove();
        if (element.isConnected) {
          return fail('the page kept an element the edit removed');
        }
        break;
      }
      case 'swallow-key': {
        const key = edit.key;
        const swallow = (event: Event): void => {
          if (event instanceof KeyboardEvent && event.key === key) {
            event.preventDefault();
            event.stopImmediatePropagation();
          }
        };
        for (const type of ['keydown', 'keypress', 'keyup']) {
          element.addEventListener(type, swallow, true);
        }
        anchors.push(element);
        break;
      }
      case 'ignore-focus-calls': {
        const nothing = (): void => undefined;
        for (const node of [element, ...Array.from(element.querySelectorAll('*'))]) {
          Object.defineProperty(node, 'focus', { configurable: true, writable: true, value: nothing });
        }
        anchors.push(element);
        break;
      }
      default:
        return fail('the edit kind is not one the engine knows');
    }
  }
  return { ok: true, reason: null, anchors };
}

/**
 * Where each path sits relative to the edit's elements, read in the page. A path joined across
 * open shadow roots with ' >> ' is followed into each root. A path into a frame, or one that names
 * no single element, is unresolved. Containment climbs the flat tree, so an element in a shadow
 * root counts as inside its host.
 */
export function locateInPage(result: EditResultInPage, paths: string[]): ElementPlace[] {
  const unique = (root: Document | ShadowRoot, selector: string): Element | null => {
    try {
      const matches = root.querySelectorAll(selector);
      return matches.length === 1 ? (matches[0] ?? null) : null;
    } catch {
      return null;
    }
  };
  const resolve = (path: string): Element | null => {
    const parts = path.split(' >> ');
    let root: Document | ShadowRoot = document;
    let element: Element | null = null;
    for (const part of parts) {
      if (part.startsWith('internal:')) {
        return null;
      }
      element = unique(root, part);
      if (element === null) {
        return null;
      }
      const shadow: ShadowRoot | null = element.shadowRoot;
      if (shadow !== null) {
        root = shadow;
      }
    }
    return element;
  };
  const parentOf = (node: Node): Node | null => {
    if (node.parentNode instanceof ShadowRoot) {
      return node.parentNode.host;
    }
    return node.parentNode;
  };
  const holds = (outer: Node, inner: Node): boolean => {
    for (let current: Node | null = parentOf(inner); current !== null; current = parentOf(current)) {
      if (current === outer) {
        return true;
      }
    }
    return false;
  };
  return paths.map((path): ElementPlace => {
    const element = resolve(path);
    if (element === null) {
      return 'unresolved';
    }
    if (result.anchors.includes(element)) {
      return 'target';
    }
    if (result.anchors.some((anchor) => holds(anchor, element))) {
      return 'inside';
    }
    if (result.anchors.some((anchor) => holds(element, anchor))) {
      return 'around';
    }
    return 'elsewhere';
  });
}

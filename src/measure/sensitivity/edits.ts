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
 * - around: it is the shadow host of one.
 * - elsewhere: it is somewhere else on the page.
 * - unresolved: its path names no single element on the page now, so where it sits is unknown.
 */
export type ElementPlace = 'target' | 'inside' | 'around' | 'elsewhere' | 'unresolved';

/**
 * What a second read of an edit found, on the page as the scan left it.
 * - held: the change is still there. For a key edit, the note says when the checks never pressed
 *   the key on the changed element, so a miss can say why.
 * - not held: the change is gone, or the page got around it. The reason says how.
 */
export type EditCheck = { held: true; note: string | null } | { held: false; reason: string };

/** An edit that took effect on the page. */
export interface AppliedEdit {
  // Read on the page as it is now, after the scan. One place per path, in order.
  locate(paths: readonly string[]): Promise<ElementPlace[]>;
  // Reads the change back on the page as it is now, after the scan.
  check(): Promise<EditCheck>;
  // Lets go of what the edit holds on the page.
  release(): Promise<void>;
}

export type EditOutcome = { kind: 'applied'; edit: AppliedEdit } | { kind: 'failed'; reason: string };

/** Applies one edit to the elements the target paths name, on a page the scan browser opened. */
export interface MutationEditor {
  apply(page: Page, targets: readonly string[], edit: Edit): Promise<EditOutcome>;
}

/**
 * What the page function returns: whether the edit held, the elements to locate against, and a
 * second read of the change for after the scan.
 */
export interface EditResultInPage {
  ok: boolean;
  reason: string | null;
  anchors: Element[];
  check: () => EditCheck;
}

/**
 * Applies an edit in the page. Each target is a path from Page.queryAll, which is a selector in the
 * top document that names one element. A path that names no element, or more than one, fails the
 * edit. After the change it reads the change back, so an edit the page undid or refused fails too.
 *
 * The result also holds a second read for after the scan. A markup edit reads its change back
 * again. The two script edits count what they did: a key edit counts the keys aimed at the element
 * that got past it, and a focus edit counts focus that reached the element in a way the edit does
 * not stop. The reasons are engine words. An error the page throws while the edit runs can still
 * carry page words into the reason the real editor builds, so every reason is scrubbed before any
 * output.
 */
export function applyEditInPage(arg: { targets: string[]; edit: Edit }): EditResultInPage {
  const NAME_ATTRIBUTES = ['aria-label', 'aria-labelledby', 'title', 'placeholder'];
  const fail = (reason: string): EditResultInPage => ({ ok: false, reason, anchors: [], check: () => ({ held: false, reason }) });
  // Each second read returns why the change is gone, or null when it held.
  const readBacks: Array<() => string | null> = [];
  const notes: Array<() => string | null> = [];
  const GONE = 'an element the edit changed is no longer on the page';
  // Inclusive containment across open shadow roots.
  const holdsFlat = (outer: Node, inner: Node | null): boolean => {
    for (let current: Node | null = inner; current !== null; ) {
      if (current === outer) {
        return true;
      }
      current = current.parentNode instanceof ShadowRoot ? current.parentNode.host : current.parentNode;
    }
    return false;
  };

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
        readBacks.push(() => {
          if (!element.isConnected) return GONE;
          return edit.names.some((name) => element.hasAttribute(name)) ? 'the page put back an attribute the edit removed' : null;
        });
        anchors.push(element);
        break;
      }
      case 'set-attribute': {
        element.setAttribute(edit.name, edit.value);
        if (element.getAttribute(edit.name) !== edit.value) {
          return fail('the page did not keep the attribute the edit set');
        }
        readBacks.push(() => {
          if (!element.isConnected) return GONE;
          return element.getAttribute(edit.name) !== edit.value ? 'the page changed back an attribute the edit set' : null;
        });
        anchors.push(element);
        break;
      }
      case 'replace-role': {
        element.setAttribute('role', edit.role);
        if (element.getAttribute('role') !== edit.role) {
          return fail('the page did not keep the role the edit set');
        }
        readBacks.push(() => {
          if (!element.isConnected) return GONE;
          return element.getAttribute('role') !== edit.role ? 'the page changed back the role the edit set' : null;
        });
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
        const hasTextName = (): boolean =>
          (element.textContent ?? '').trim() !== '' || NAME_ATTRIBUTES.some((name) => element.hasAttribute(name));
        if (hasTextName()) {
          return fail('the page kept a text name the edit removed');
        }
        readBacks.push(() => {
          if (!element.isConnected) return GONE;
          return hasTextName() ? 'the page put back a text name the edit removed' : null;
        });
        anchors.push(element);
        break;
      }
      case 'set-style': {
        if (!(element instanceof HTMLElement || element instanceof SVGElement)) {
          return fail('the target cannot carry an inline style');
        }
        const kept: Array<[string, string]> = [];
        for (const [property, value] of Object.entries(edit.styles)) {
          element.style.setProperty(property, value, 'important');
          const read = element.style.getPropertyValue(property);
          if (read === '') {
            return fail('the page did not keep a style the edit set');
          }
          kept.push([property, read]);
        }
        const styled = element;
        readBacks.push(() => {
          if (!styled.isConnected) return GONE;
          const changed = kept.some(
            ([property, read]) => styled.style.getPropertyValue(property) !== read || styled.style.getPropertyPriority(property) !== 'important',
          );
          return changed ? 'the page changed a style the edit set' : null;
        });
        anchors.push(element);
        break;
      }
      case 'remove-element': {
        const parent = element.parentElement ?? document.documentElement;
        const tag = element.localName;
        const alike = (): number => Array.from(parent.children).filter((child) => child.localName === tag).length;
        anchors.push(parent);
        element.remove();
        if (element.isConnected) {
          return fail('the page kept an element the edit removed');
        }
        const after = alike();
        readBacks.push(() => {
          if (element.isConnected) return 'the page put back an element the edit removed';
          if (!parent.isConnected) return 'the element that held a removed one is no longer on the page';
          // A page that renders again can put back a new element in place of the removed one.
          return alike() > after ? 'the page put back an element like the one the edit removed' : null;
        });
        break;
      }
      case 'swallow-key': {
        const key = edit.key;
        // Key events aimed at the element, seen first on the window, and the ones that reached the
        // swallow before any page listener had acted on them. Page listeners on the window and the
        // document run before a listener on the element, so a key they act on got past the edit.
        const aimed: Event[] = [];
        const swallowed = new WeakSet<Event>();
        let pressed = 0;
        const isAimed = (event: Event): boolean =>
          event instanceof KeyboardEvent && event.key === key && event.composedPath().includes(element);
        const observe = (event: Event): void => {
          if (isAimed(event)) {
            aimed.push(event);
            if (event.type === 'keydown') pressed += 1;
          }
        };
        const swallow = (event: Event): void => {
          if (event instanceof KeyboardEvent && event.key === key) {
            if (!event.defaultPrevented) swallowed.add(event);
            event.preventDefault();
            event.stopImmediatePropagation();
          }
        };
        for (const type of ['keydown', 'keypress', 'keyup']) {
          window.addEventListener(type, observe, { capture: true, passive: true });
          element.addEventListener(type, swallow, true);
        }
        readBacks.push(() =>
          aimed.some((event) => !swallowed.has(event))
            ? `a ${key} key aimed at the changed element reached the page before the edit could cancel it`
            : null,
        );
        notes.push(() => (pressed === 0 ? `the checks never pressed ${key} on the changed element` : null));
        anchors.push(element);
        break;
      }
      case 'ignore-focus-calls': {
        const nothing = (): void => undefined;
        const stubbed = [element, ...Array.from(element.querySelectorAll('*'))];
        for (const node of stubbed) {
          Object.defineProperty(node, 'focus', { configurable: true, writable: true, value: nothing });
        }
        // Focus by the keyboard and by a pointer press still works, on purpose. Any other focus
        // that lands inside the element means the page moved it without a stubbed focus() call,
        // for example on an element it rendered after the edit, or with autofocus.
        let tabbing = false;
        let pressedOn: Node | null = null;
        const clearLater = (clear: () => void): void => {
          setTimeout(clear, 0);
        };
        window.addEventListener(
          'keydown',
          (event) => {
            if (event.key === 'Tab') {
              tabbing = true;
              clearLater(() => {
                tabbing = false;
              });
            }
          },
          { capture: true, passive: true },
        );
        window.addEventListener('keyup', () => {
          tabbing = false;
        }, { capture: true, passive: true });
        window.addEventListener(
          'mousedown',
          (event) => {
            const first = event.composedPath()[0];
            pressedOn = first instanceof Node ? first : null;
            clearLater(() => {
              pressedOn = null;
            });
          },
          { capture: true, passive: true },
        );
        window.addEventListener('click', () => {
          pressedOn = null;
        }, { capture: true, passive: true });
        let reached = 0;
        element.addEventListener(
          'focusin',
          (event) => {
            const focused = event.composedPath()[0];
            if (tabbing) return;
            if (pressedOn !== null && focused instanceof Node && holdsFlat(focused, pressedOn)) return;
            reached += 1;
          },
          true,
        );
        readBacks.push(() => {
          if (stubbed.some((node) => (node as HTMLElement).focus !== nothing)) {
            return 'the page replaced a focus() call the edit turned off';
          }
          return reached > 0 ? 'focus reached the changed element in a way the edit does not stop, such as an element added later' : null;
        });
        anchors.push(element);
        break;
      }
      default:
        return fail('the edit kind is not one the engine knows');
    }
  }
  const check = (): EditCheck => {
    for (const readBack of readBacks) {
      const reason = readBack();
      if (reason !== null) {
        return { held: false, reason };
      }
    }
    const note = notes.map((read) => read()).find((text) => text !== null) ?? null;
    return { held: true, note };
  };
  return { ok: true, reason: null, anchors, check };
}

/** The second read of an edit, in the page. A plain object, so it crosses back as JSON. */
export function checkEditInPage(result: EditResultInPage): EditCheck {
  return result.check();
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
  const hostOf = (node: Node): Element | null => {
    const root = node.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
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
    // Around is narrow on purpose: only the shadow host of a changed element. A wider ancestor,
    // such as main or body, would let a new page-level finding count as on the target.
    if (result.anchors.some((anchor) => hostOf(anchor) === element)) {
      return 'around';
    }
    return 'elsewhere';
  });
}

/**
 * In-memory stand-ins for the sensitivity runner's page reads and its mutation editor, so the
 * runner and the target finder can be tested without a browser. A fake page answers queryAll from
 * a scripted selector table and axAt and hostMarkup from a list of elements. The fake editor applies
 * each edit kind to that list the way the page function does, and records what it did.
 */
import type { AxNode, HostMarkup, Page } from '../../contracts/index.js';
import { makeFakePage } from '../../deps/fakes.js';
import type { Edit } from './catalog.js';
import type { EditCheck, EditOutcome, ElementPlace, MutationEditor } from './edits.js';

export interface FakeElement {
  path: string;
  // The path of the element that holds it, for locating a reported element.
  parent?: string;
  role?: string | null;
  name?: string | null;
  text?: string;
  attributes?: Record<string, string>;
  // Set by the fake editor.
  removed?: boolean;
  swallowedKeys?: string[];
  ignoresFocusCalls?: boolean;
  styles?: Record<string, string>;
}

export interface FakeDom {
  elements: Map<string, FakeElement>;
  selectors: Record<string, string[]>;
  // Every edit the fake editor applied, in order.
  edits: Array<{ targets: string[]; edit: Edit }>;
}

export function makeFakeDom(spec: { elements: FakeElement[]; selectors: Record<string, string[]> }): FakeDom {
  return {
    elements: new Map(spec.elements.map((element) => [element.path, { ...element, attributes: { ...element.attributes } }])),
    selectors: spec.selectors,
    edits: [],
  };
}

const domsByPage = new WeakMap<Page, FakeDom>();

/** A fake page over a fake DOM. Overrides win, so a test can script any other read. */
export function makeFakeDomPage(dom: FakeDom, overrides: Partial<Page> = {}): Page {
  const live = (path: string): FakeElement | undefined => {
    const element = dom.elements.get(path);
    return element === undefined || element.removed === true ? undefined : element;
  };
  const page = makeFakePage({
    queryAll: async (selector: string) =>
      (dom.selectors[selector] ?? []).filter((path) => live(path) !== undefined).map((path) => ({ selector: path })),
    axAt: async (path: string): Promise<AxNode | null> => {
      const element = live(path);
      if (element === undefined || element.role === undefined) return null;
      return { role: element.role, name: element.name ?? null, states: {} };
    },
    hostMarkup: async (path: string): Promise<HostMarkup | null> => {
      const element = live(path);
      if (element === undefined) return null;
      return { defined: true, attributes: { ...element.attributes }, defaultSlotText: element.text ?? '' };
    },
    ...overrides,
  });
  domsByPage.set(page, dom);
  return page;
}

/** The fake DOM behind a fake page, or undefined for any other page. */
export function fakeDomOf(page: Page): FakeDom | undefined {
  return domsByPage.get(page);
}

function applyTo(element: FakeElement, edit: Edit): string | null {
  const attributes = (element.attributes ??= {});
  switch (edit.kind) {
    case 'remove-attribute':
      for (const name of edit.names) {
        delete attributes[name];
        if (name === 'aria-label') element.name = '';
      }
      return null;
    case 'set-attribute':
      attributes[edit.name] = edit.value;
      if (edit.name === 'aria-label') element.name = edit.value;
      return null;
    case 'replace-role':
      attributes.role = edit.role;
      element.role = edit.role;
      return null;
    case 'remove-text-name':
      for (const name of ['aria-label', 'aria-labelledby', 'title', 'placeholder']) delete attributes[name];
      element.text = '';
      element.name = '';
      return null;
    case 'set-style':
      element.styles = { ...element.styles, ...edit.styles };
      return null;
    case 'remove-element':
      element.removed = true;
      return null;
    case 'swallow-key':
      element.swallowedKeys = [...(element.swallowedKeys ?? []), edit.key];
      return null;
    case 'ignore-focus-calls':
      element.ignoresFocusCalls = true;
      return null;
    default:
      return 'the edit kind is not one the engine knows';
  }
}

function holds(dom: FakeDom, outer: string, inner: string): boolean {
  for (let current = dom.elements.get(inner)?.parent; current !== undefined; current = dom.elements.get(current)?.parent) {
    if (current === outer) return true;
  }
  return false;
}

/**
 * A fake editor over fake DOM pages. `refuse` makes every edit fail with that reason, the way the
 * page function fails when the page does not keep a change. `check` is what the second read after
 * the scan returns. Default: the change held, with no note.
 */
export function makeFakeMutationEditor(options: { refuse?: string; check?: EditCheck } = {}): MutationEditor {
  return {
    async apply(page: Page, targets: readonly string[], edit: Edit): Promise<EditOutcome> {
      const dom = fakeDomOf(page);
      if (dom === undefined) {
        return { kind: 'failed', reason: 'the page was not opened by the scan browser, so no edit can reach it' };
      }
      if (options.refuse !== undefined) {
        return { kind: 'failed', reason: options.refuse };
      }
      const anchors: string[] = [];
      for (const path of targets) {
        const element = dom.elements.get(path);
        if (element === undefined || element.removed === true) {
          return { kind: 'failed', reason: 'a target element could not be found again as one element' };
        }
        const refused = applyTo(element, edit);
        if (refused !== null) return { kind: 'failed', reason: refused };
        anchors.push(edit.kind === 'remove-element' ? (element.parent ?? 'html') : path);
      }
      dom.edits.push({ targets: [...targets], edit });
      return {
        kind: 'applied',
        edit: {
          async locate(paths: readonly string[]): Promise<ElementPlace[]> {
            return paths.map((path): ElementPlace => {
              if (!dom.elements.has(path) || dom.elements.get(path)?.removed === true) return 'unresolved';
              if (anchors.includes(path)) return 'target';
              if (anchors.some((anchor) => holds(dom, anchor, path))) return 'inside';
              if (anchors.some((anchor) => holds(dom, path, anchor))) return 'around';
              return 'elsewhere';
            });
          },
          async check(): Promise<EditCheck> {
            return options.check ?? { held: true, note: null };
          },
          async release() {},
        },
      };
    },
  };
}

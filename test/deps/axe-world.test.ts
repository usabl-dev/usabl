/**
 * The semantics the isolated axe run reads for a custom element from the browser's accessibility
 * tree. The tree reports a default ARIA state, such as unchecked, whether or not the element set
 * one, so only a state that differs from the role's default reaches axe. Driven with accessibility
 * nodes shaped as Accessibility.getFullAXTree returns them, so no browser starts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LAYOUT_FACTS_FUNCTION, SET_INTERNALS_FUNCTION, internalsRecord, type LayoutFacts } from '../../src/deps/axe-world.js';
import { STATE_CASES } from '../support/internals-states.js';

interface Property {
  name: string;
  type: string;
  value: unknown;
}

function axNode(role: string, properties: Property[] = [], value?: unknown): unknown {
  return {
    ignored: false,
    role: { type: 'role', value: role },
    properties: properties.map((property) => ({ name: property.name, value: { type: property.type, value: property.value } })),
    ...(value === undefined ? {} : { value: { type: typeof value === 'number' ? 'number' : 'string', value } }),
  };
}

const attrs = (entries: Record<string, string> = {}): Map<string, string> => new Map(Object.entries(entries));
const checked = (value: string): Property => ({ name: 'checked', type: 'tristate', value });
const expanded = (value: boolean): Property => ({ name: 'expanded', type: 'booleanOrUndefined', value });
const level = (value: number): Property => ({ name: 'level', type: 'integer', value });
const valuemin = (value: number): Property => ({ name: 'valuemin', type: 'number', value });
const valuemax = (value: number): Property => ({ name: 'valuemax', type: 'number', value });

// A custom element whose layout and focus give Chrome no role of its own to derive.
const PLAIN: LayoutFacts = {
  display: 'inline',
  content: 'normal',
  focusable: false,
  minimumRoleAttribute: false,
  relations: false,
  focusgroup: false,
  scrollMarker: false,
};
const recordOf = (node: unknown, attributes: Map<string, string>, facts: LayoutFacts = PLAIN): unknown =>
  internalsRecord(node, attributes, facts);
const named = (role: string): unknown => ({ ignored: false, role: { type: 'role', value: role }, properties: [] });

describe('internalsRecord: roles', () => {
  it('carries a role the tree reports for an element whose layout and focus explain none', () => {
    expect(recordOf(named('listitem'), attrs())).toEqual({ role: 'listitem' });
    expect(recordOf(named('button'), attrs(), { ...PLAIN, focusable: true })).toEqual({ role: 'button' });
    expect(recordOf(named('image'), attrs())).toEqual({ role: 'img' });
  });

  it('carries no role when usabl could not read the layout of the element', () => {
    expect(internalsRecord(named('listitem'), attrs(), undefined)).toBeNull();
  });

  it('drops every role on an element displayed as a list item, which Chrome exposes as a list item', () => {
    expect(recordOf(named('listitem'), attrs(), { ...PLAIN, display: 'list-item' })).toBeNull();
    expect(recordOf(named('listitem'), attrs(), { ...PLAIN, display: 'inline list-item' })).toBeNull();
    expect(recordOf(named('button'), attrs(), { ...PLAIN, display: 'list-item' })).toBeNull();
  });

  it('drops every role on an element with a table display, which Chrome exposes as a table part', () => {
    for (const display of ['table', 'inline-table', 'table-row', 'table-cell', 'table-row-group', 'table-header-group', 'table-footer-group', 'table-caption']) {
      expect(recordOf(named('row'), attrs(), { ...PLAIN, display })).toBeNull();
      expect(recordOf(named('cell'), attrs(), { ...PLAIN, display })).toBeNull();
    }
  });

  it('drops every role on an element whose CSS content replaces it, which Chrome exposes as an image or text', () => {
    expect(recordOf(named('image'), attrs(), { ...PLAIN, content: 'linear-gradient(rgb(255, 0, 0), rgb(0, 0, 255))' })).toBeNull();
    expect(recordOf(named('button'), attrs(), { ...PLAIN, content: 'url("x.png") / "Chart"' })).toBeNull();
  });

  it('drops every role on a focusgroup owner, whose role Chrome can infer', () => {
    expect(recordOf(named('toolbar'), attrs(), { ...PLAIN, focusgroup: true })).toBeNull();
  });

  it('drops a group role on an element Chrome gives a minimum group role', () => {
    for (const facts of [{ focusable: true }, { minimumRoleAttribute: true }, { relations: true }]) {
      expect(recordOf(named('group'), attrs(), { ...PLAIN, ...facts })).toBeNull();
    }
    expect(recordOf({ ...(named('group') as object), properties: [{ name: 'describedby', value: { type: 'nodeList', value: [] } }] }, attrs())).toBeNull();
    expect(recordOf(named('group'), attrs())).toEqual({ role: 'group' });
  });

  it('drops a tabpanel role on an element with a scroll marker, which Chrome can expose as a tab panel', () => {
    expect(recordOf(named('tabpanel'), attrs(), { ...PLAIN, scrollMarker: true })).toBeNull();
    expect(recordOf(named('tabpanel'), attrs())).toEqual({ role: 'tabpanel' });
  });

  it('keeps the states and the name when it drops a role', () => {
    const node = { ...(axNode('listitem', [checked('true')]) as object), name: { sources: [{ type: 'attribute', attribute: 'aria-label', attributeValue: { value: 'A' } }] } };
    expect(recordOf(node, attrs(), { ...PLAIN, display: 'list-item' })).toEqual({ ariaLabel: 'A', ariaChecked: 'true' });
  });
});

describe('the layout facts read in usabl\'s world', () => {
  const scope = globalThis as Record<string, unknown>;

  afterEach(() => {
    delete scope.getComputedStyle;
  });

  function element(attributes: Record<string, string>, tabIndex: number, properties: Record<string, unknown> = {}): object {
    return { tabIndex, hasAttribute: (name: string) => name in attributes, ...properties };
  }

  it('reads display, content, focus, relations, and scroll markers for each element in order', () => {
    const styles = new Map<object, { element: Record<string, string>; marker: Record<string, string> }>();
    scope.getComputedStyle = (target: object, pseudo?: string) => {
      const style = styles.get(target);
      const values = (pseudo === '::scroll-marker' ? style?.marker : style?.element) ?? {};
      return { ...values, getPropertyValue: (name: string) => values[name] ?? '' };
    };
    const plain = element({}, -1);
    const listItem = element({ draggable: 'true' }, 0, { ariaControlsElements: [{}] });
    const marked = element({ focusgroup: '' }, -1, { ariaOwnsElements: [] });
    styles.set(plain, { element: { display: 'inline', content: 'normal', 'scroll-marker-group': 'none' }, marker: { content: 'none' } });
    styles.set(listItem, { element: { display: 'list-item', content: 'normal', 'scroll-marker-group': 'none' }, marker: { content: 'none' } });
    styles.set(marked, { element: { display: 'block', content: 'normal', 'scroll-marker-group': 'after tabs' }, marker: { content: '""' } });
    const read = new Function(`return (${LAYOUT_FACTS_FUNCTION})`)() as (this: unknown[]) => unknown;
    expect(read.call([plain, listItem, marked])).toEqual([
      { display: 'inline', content: 'normal', focusable: false, minimumRoleAttribute: false, relations: false, focusgroup: false, scrollMarker: false },
      { display: 'list-item', content: 'normal', focusable: true, minimumRoleAttribute: true, relations: true, focusgroup: false, scrollMarker: false },
      { display: 'block', content: 'normal', focusable: false, minimumRoleAttribute: false, relations: false, focusgroup: true, scrollMarker: true },
    ]);
  });
});

describe('internalsRecord: ARIA states', () => {
  it('carries a checked state that differs from the default as ariaChecked', () => {
    expect(recordOf(axNode('checkbox', [checked('true')]), attrs({ role: 'checkbox', 'aria-label': 'Agree' }))).toEqual({
      ariaChecked: 'true',
    });
    expect(recordOf(axNode('switch', [checked('mixed')]), attrs({ role: 'switch' }))).toEqual({ ariaChecked: 'mixed' });
  });

  it('drops the default checked state, which the tree reports when nothing set one', () => {
    expect(recordOf(axNode('checkbox', [checked('false')]), attrs({ role: 'checkbox' }))).toBeNull();
  });

  it('carries a checked state alongside a role read from the tree', () => {
    expect(recordOf(axNode('checkbox', [checked('true')]), attrs())).toEqual({ role: 'checkbox', ariaChecked: 'true' });
  });

  it('leaves a state to its attribute when the element has one', () => {
    expect(recordOf(axNode('checkbox', [checked('true')]), attrs({ role: 'checkbox', 'aria-checked': 'true' }))).toBeNull();
    expect(recordOf(axNode('combobox', [expanded(true)]), attrs({ role: 'combobox', 'aria-expanded': 'true' }))).toBeNull();
    expect(recordOf(axNode('heading', [level(3)]), attrs({ role: 'heading', 'aria-level': '3' }))).toBeNull();
    expect(recordOf(axNode('slider', [valuemin(0), valuemax(100)], 30), attrs({ role: 'slider', 'aria-valuenow': '30' }))).toBeNull();
  });

  it('carries an expanded state of true as ariaExpanded and drops false', () => {
    expect(recordOf(axNode('combobox', [expanded(true)]), attrs({ role: 'combobox' }))).toEqual({ ariaExpanded: 'true' });
    expect(recordOf(axNode('combobox', [expanded(false)]), attrs({ role: 'combobox' }))).toBeNull();
  });

  it('carries a heading level other than 2 as ariaLevel', () => {
    expect(recordOf(axNode('heading', [level(3)]), attrs({ role: 'heading' }))).toEqual({ ariaLevel: '3' });
    expect(recordOf(axNode('heading', [level(2)]), attrs({ role: 'heading' }))).toBeNull();
  });

  it('does not carry a level the browser computes from position, such as a tree item depth', () => {
    expect(recordOf(axNode('treeitem', [level(3)]), attrs({ role: 'treeitem' }))).toBeNull();
  });

  it('carries a slider or scrollbar value other than the midpoint of its range as ariaValueNow', () => {
    expect(recordOf(axNode('slider', [valuemin(0), valuemax(100)], 30), attrs({ role: 'slider' }))).toEqual({ ariaValueNow: '30' });
    expect(recordOf(axNode('slider', [valuemin(0), valuemax(100)], 50), attrs({ role: 'slider' }))).toBeNull();
    expect(recordOf(axNode('slider', [valuemin(0), valuemax(10)], 5), attrs({ role: 'slider' }))).toBeNull();
    expect(recordOf(axNode('slider', [valuemin(0), valuemax(10)], 8), attrs({ role: 'slider' }))).toEqual({ ariaValueNow: '8' });
    expect(recordOf(axNode('slider', [], 50), attrs({ role: 'slider' }))).toBeNull();
    expect(recordOf(axNode('scrollbar', [valuemin(0), valuemax(100)], 50), attrs({ role: 'scrollbar' }))).toBeNull();
    expect(recordOf(axNode('scrollbar', [valuemin(0), valuemax(100)], 10), attrs({ role: 'scrollbar' }))).toEqual({
      ariaValueNow: '10',
    });
  });

  it('compares a range midpoint at the single precision the browser computes it in', () => {
    const min = Math.fround(0.1);
    const max = Math.fround(0.2);
    const midpoint = Math.fround(Math.fround(min + max) / 2);
    expect(recordOf(axNode('slider', [valuemin(min), valuemax(max)], midpoint), attrs({ role: 'slider' }))).toBeNull();
  });

  it('carries a meter value other than its minimum, and a separator value other than 50', () => {
    expect(recordOf(axNode('meter', [valuemin(0), valuemax(100)], 0), attrs({ role: 'meter' }))).toBeNull();
    expect(recordOf(axNode('meter', [valuemin(10), valuemax(100)], 10), attrs({ role: 'meter' }))).toBeNull();
    expect(recordOf(axNode('meter', [valuemin(10), valuemax(100)], 40), attrs({ role: 'meter' }))).toEqual({ ariaValueNow: '40' });
    expect(recordOf(axNode('separator', [], 50), attrs({ role: 'separator' }))).toBeNull();
    expect(recordOf(axNode('splitter', [], 20), attrs({ role: 'separator' }))).toEqual({ ariaValueNow: '20' });
  });

  it('never reads a text value as a range value', () => {
    expect(recordOf(axNode('slider', [], '30'), attrs({ role: 'slider' }))).toBeNull();
    expect(recordOf(axNode('textbox', [], 'typed text'), attrs({ role: 'textbox' }))).toBeNull();
  });

  it('carries nothing for an ignored node', () => {
    expect(recordOf({ ...(axNode('checkbox', [checked('true')]) as object), ignored: true }, attrs())).toBeNull();
  });
});

describe('internalsRecord: the defaults the real-browser test pins', () => {
  // The defaults test/support/internals-states.ts expects the tree to report for an element that
  // sets no state. The real-browser test checks them against Chrome; this checks the code drops
  // each one, so the two cannot drift apart.
  for (const entry of STATE_CASES.filter((candidate) => candidate.defaults !== null)) {
    it(`drops every default the tree reports for ${entry.id}`, () => {
      const role = /role="([^"]+)"/.exec(entry.html.replace(/^<div role="menu"[^>]*>/, ''))?.[1] ?? '';
      expect(role).toBe(entry.id.split('-')[0]);
      const { value, ...named } = entry.defaults ?? {};
      const properties = Object.entries(named).map(([name, propertyValue]) => ({ name, type: typeof propertyValue, value: propertyValue }));
      const attributes = attrs({ role, 'aria-label': 'Name' });
      expect(recordOf(axNode(role, properties, value), attributes)).toBeNull();
    });
  }
});

describe('the internals handed to axe', () => {
  const scope = globalThis as Record<string, unknown>;

  afterEach(() => {
    delete scope.axe;
    delete scope._elementInternals;
  });

  it('passes every carried state through to the ElementInternals map axe reads', () => {
    scope.axe = { commons: { aria: { isValidRole: (role: string) => role === 'checkbox' } } };
    const element = {};
    const record = { role: 'checkbox', ariaChecked: 'true', ariaExpanded: 'true', ariaLevel: '3', ariaValueNow: '30' };
    const install = new Function(`return (${SET_INTERNALS_FUNCTION})`)() as (this: unknown[], records: unknown[]) => void;
    install.call([element], [record]);
    const map = scope._elementInternals as WeakMap<object, unknown>;
    expect(map.get(element)).toEqual(record);
  });
});

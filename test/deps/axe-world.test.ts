/**
 * The semantics the isolated axe run reads for a custom element from the browser's accessibility
 * tree. The tree reports a default ARIA state, such as unchecked, whether or not the element set
 * one, so only a state that differs from the role's default reaches axe. Driven with accessibility
 * nodes shaped as Accessibility.getFullAXTree returns them, so no browser starts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SET_INTERNALS_FUNCTION, internalsRecord } from '../../src/deps/axe-world.js';
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

describe('internalsRecord: ARIA states', () => {
  it('carries a checked state that differs from the default as ariaChecked', () => {
    expect(internalsRecord(axNode('checkbox', [checked('true')]), attrs({ role: 'checkbox', 'aria-label': 'Agree' }))).toEqual({
      ariaChecked: 'true',
    });
    expect(internalsRecord(axNode('switch', [checked('mixed')]), attrs({ role: 'switch' }))).toEqual({ ariaChecked: 'mixed' });
  });

  it('drops the default checked state, which the tree reports when nothing set one', () => {
    expect(internalsRecord(axNode('checkbox', [checked('false')]), attrs({ role: 'checkbox' }))).toBeNull();
  });

  it('carries a checked state alongside a role read from the tree', () => {
    expect(internalsRecord(axNode('checkbox', [checked('true')]), attrs())).toEqual({ role: 'checkbox', ariaChecked: 'true' });
  });

  it('leaves a state to its attribute when the element has one', () => {
    expect(internalsRecord(axNode('checkbox', [checked('true')]), attrs({ role: 'checkbox', 'aria-checked': 'true' }))).toBeNull();
    expect(internalsRecord(axNode('combobox', [expanded(true)]), attrs({ role: 'combobox', 'aria-expanded': 'true' }))).toBeNull();
    expect(internalsRecord(axNode('heading', [level(3)]), attrs({ role: 'heading', 'aria-level': '3' }))).toBeNull();
    expect(internalsRecord(axNode('slider', [valuemin(0), valuemax(100)], 30), attrs({ role: 'slider', 'aria-valuenow': '30' }))).toBeNull();
  });

  it('carries an expanded state of true as ariaExpanded and drops false', () => {
    expect(internalsRecord(axNode('combobox', [expanded(true)]), attrs({ role: 'combobox' }))).toEqual({ ariaExpanded: 'true' });
    expect(internalsRecord(axNode('combobox', [expanded(false)]), attrs({ role: 'combobox' }))).toBeNull();
  });

  it('carries a heading level other than 2 as ariaLevel', () => {
    expect(internalsRecord(axNode('heading', [level(3)]), attrs({ role: 'heading' }))).toEqual({ ariaLevel: '3' });
    expect(internalsRecord(axNode('heading', [level(2)]), attrs({ role: 'heading' }))).toBeNull();
  });

  it('does not carry a level the browser computes from position, such as a tree item depth', () => {
    expect(internalsRecord(axNode('treeitem', [level(3)]), attrs({ role: 'treeitem' }))).toBeNull();
  });

  it('carries a slider or scrollbar value other than the midpoint of its range as ariaValueNow', () => {
    expect(internalsRecord(axNode('slider', [valuemin(0), valuemax(100)], 30), attrs({ role: 'slider' }))).toEqual({ ariaValueNow: '30' });
    expect(internalsRecord(axNode('slider', [valuemin(0), valuemax(100)], 50), attrs({ role: 'slider' }))).toBeNull();
    expect(internalsRecord(axNode('slider', [valuemin(0), valuemax(10)], 5), attrs({ role: 'slider' }))).toBeNull();
    expect(internalsRecord(axNode('slider', [valuemin(0), valuemax(10)], 8), attrs({ role: 'slider' }))).toEqual({ ariaValueNow: '8' });
    expect(internalsRecord(axNode('slider', [], 50), attrs({ role: 'slider' }))).toBeNull();
    expect(internalsRecord(axNode('scrollbar', [valuemin(0), valuemax(100)], 50), attrs({ role: 'scrollbar' }))).toBeNull();
    expect(internalsRecord(axNode('scrollbar', [valuemin(0), valuemax(100)], 10), attrs({ role: 'scrollbar' }))).toEqual({
      ariaValueNow: '10',
    });
  });

  it('compares a range midpoint at the single precision the browser computes it in', () => {
    const min = Math.fround(0.1);
    const max = Math.fround(0.2);
    const midpoint = Math.fround(Math.fround(min + max) / 2);
    expect(internalsRecord(axNode('slider', [valuemin(min), valuemax(max)], midpoint), attrs({ role: 'slider' }))).toBeNull();
  });

  it('carries a meter value other than its minimum, and a separator value other than 50', () => {
    expect(internalsRecord(axNode('meter', [valuemin(0), valuemax(100)], 0), attrs({ role: 'meter' }))).toBeNull();
    expect(internalsRecord(axNode('meter', [valuemin(10), valuemax(100)], 10), attrs({ role: 'meter' }))).toBeNull();
    expect(internalsRecord(axNode('meter', [valuemin(10), valuemax(100)], 40), attrs({ role: 'meter' }))).toEqual({ ariaValueNow: '40' });
    expect(internalsRecord(axNode('separator', [], 50), attrs({ role: 'separator' }))).toBeNull();
    expect(internalsRecord(axNode('splitter', [], 20), attrs({ role: 'separator' }))).toEqual({ ariaValueNow: '20' });
  });

  it('never reads a text value as a range value', () => {
    expect(internalsRecord(axNode('slider', [], '30'), attrs({ role: 'slider' }))).toBeNull();
    expect(internalsRecord(axNode('textbox', [], 'typed text'), attrs({ role: 'textbox' }))).toBeNull();
  });

  it('carries nothing for an ignored node', () => {
    expect(internalsRecord({ ...(axNode('checkbox', [checked('true')]) as object), ignored: true }, attrs())).toBeNull();
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
      expect(internalsRecord(axNode(role, properties, value), attributes)).toBeNull();
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

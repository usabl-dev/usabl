/**
 * Custom elements that set the ARIA states axe's aria-required-attr rule asks for through
 * ElementInternals, each with its role as an attribute so the rule applies. Every role has one
 * element that sets no state, which pins the default the browser's accessibility tree reports, and
 * one that sets a value other than that default. The comparison harness runs axe over them in both
 * worlds, and the real-browser test reads the tree for them.
 *
 * Test-only. Nothing here ships in the package.
 */

// Sets each ARIA state named by a data attribute through ElementInternals, such as
// data-valuenow="30" as ariaValueNow. The element has no aria-* attribute for any of them.
export const X_ARIA_SCRIPT =
  "customElements.define('x-aria', class extends HTMLElement {" +
  ' constructor() { super(); this._internals = this.attachInternals(); }' +
  ' connectedCallback() {' +
  "  const props = { checked: 'ariaChecked', expanded: 'ariaExpanded', level: 'ariaLevel', valuenow: 'ariaValueNow', valuemin: 'ariaValueMin', valuemax: 'ariaValueMax' };" +
  '  for (const [key, prop] of Object.entries(props)) { if (this.dataset[key] !== undefined) this._internals[prop] = this.dataset[key]; }' +
  ' } });';

// What the tree reports for one element, by the property names Accessibility.getFullAXTree uses.
// `value` is the node's own value, which carries the current value of a range role. A property the
// tree leaves out is absent.
export interface TreeStates {
  checked?: unknown;
  expanded?: unknown;
  level?: unknown;
  value?: unknown;
  valuemin?: unknown;
  valuemax?: unknown;
}

export interface StateCase {
  id: string;
  html: string;
  // The group the case is compared in, one harness page per group.
  group: string;
  // For a case that sets no state: the default the tree is expected to report. Null for a case
  // that sets one.
  defaults: TreeStates | null;
  // What internalsRecord is expected to hand axe for the element.
  record: Record<string, string> | null;
}

function el(id: string, role: string, data: Record<string, string>, extra = '', content = ''): string {
  const dataAttrs = Object.entries(data)
    .map(([key, value]) => ` data-${key}="${value}"`)
    .join('');
  return `<x-aria id="${id}" role="${role}"${dataAttrs}${extra}>${content}</x-aria>`;
}

const LABEL = (name: string): string => ` aria-label="${name}" tabindex="0"`;
const IN_MENU = (inner: string): string => `<div role="menu" aria-label="Options">${inner}</div>`;

export const STATE_CASES: StateCase[] = [
  // Checked. The default is false for every role that takes aria-checked.
  ...['checkbox', 'switch', 'radio'].flatMap((role): StateCase[] => [
    { id: `${role}-unset`, group: 'checked', html: el(`${role}-unset`, role, {}, LABEL('Agree')), defaults: { checked: 'false' }, record: null },
    {
      id: `${role}-set`,
      group: 'checked',
      html: el(`${role}-set`, role, { checked: 'true' }, LABEL('Agree')),
      defaults: null,
      record: { ariaChecked: 'true' },
    },
  ]),
  ...['menuitemcheckbox', 'menuitemradio'].flatMap((role): StateCase[] => [
    { id: `${role}-unset`, group: 'checked', html: IN_MENU(el(`${role}-unset`, role, {}, LABEL('Bold'))), defaults: { checked: 'false' }, record: null },
    {
      id: `${role}-set`,
      group: 'checked',
      html: IN_MENU(el(`${role}-set`, role, { checked: 'true' }, LABEL('Bold'))),
      defaults: null,
      record: { ariaChecked: 'true' },
    },
  ]),
  // Heading level. The default is 2. A heading that sets level 2 is dropped as a default.
  { id: 'heading-unset', group: 'heading', html: el('heading-unset', 'heading', {}, '', 'Section'), defaults: { level: 2 }, record: null },
  { id: 'heading-three', group: 'heading', html: el('heading-three', 'heading', { level: '3' }, '', 'Section'), defaults: null, record: { ariaLevel: '3' } },
  { id: 'heading-two', group: 'heading', html: el('heading-two', 'heading', { level: '2' }, '', 'Section'), defaults: null, record: null },
  // Slider. The default is halfway between the minimum and the maximum.
  { id: 'slider-unset', group: 'slider', html: el('slider-unset', 'slider', {}, LABEL('Volume')), defaults: { value: 50, valuemin: 0, valuemax: 100 }, record: null },
  { id: 'slider-set', group: 'slider', html: el('slider-set', 'slider', { valuenow: '30' }, LABEL('Volume')), defaults: null, record: { ariaValueNow: '30' } },
  {
    id: 'slider-range-unset',
    group: 'slider',
    html: el('slider-range-unset', 'slider', { valuemin: '2', valuemax: '10' }, LABEL('Level')),
    defaults: { value: 6, valuemin: 2, valuemax: 10 },
    record: null,
  },
  {
    id: 'slider-range-set',
    group: 'slider',
    html: el('slider-range-set', 'slider', { valuemin: '2', valuemax: '10', valuenow: '8' }, LABEL('Level')),
    defaults: null,
    record: { ariaValueNow: '8' },
  },
  // Scrollbar. The default is halfway between the minimum and the maximum.
  { id: 'scrollbar-unset', group: 'scrollbar', html: el('scrollbar-unset', 'scrollbar', {}, LABEL('Scroll')), defaults: { value: 50, valuemin: 0, valuemax: 100 }, record: null },
  { id: 'scrollbar-set', group: 'scrollbar', html: el('scrollbar-set', 'scrollbar', { valuenow: '10' }, LABEL('Scroll')), defaults: null, record: { ariaValueNow: '10' } },
  // A focusable separator, which takes a value. The default is 50.
  { id: 'separator-unset', group: 'separator', html: el('separator-unset', 'separator', {}, LABEL('Resize')), defaults: { value: 50, valuemin: 0, valuemax: 100 }, record: null },
  { id: 'separator-set', group: 'separator', html: el('separator-set', 'separator', { valuenow: '20' }, LABEL('Resize')), defaults: null, record: { ariaValueNow: '20' } },
  // Meter. The default is its minimum.
  { id: 'meter-unset', group: 'meter', html: el('meter-unset', 'meter', {}, ' aria-label="Usage"'), defaults: { value: 0, valuemin: 0, valuemax: 100 }, record: null },
  {
    id: 'meter-min-unset',
    group: 'meter',
    html: el('meter-min-unset', 'meter', { valuemin: '10' }, ' aria-label="Usage"'),
    defaults: { value: 10, valuemin: 10, valuemax: 100 },
    record: null,
  },
  { id: 'meter-set', group: 'meter', html: el('meter-set', 'meter', { valuenow: '40' }, ' aria-label="Usage"'), defaults: null, record: { ariaValueNow: '40' } },
  // Expanded. A combobox that controls a list box, so aria-expanded is the only state it can miss,
  // and a button. Chrome reports no expanded state for either when the element sets none.
  {
    id: 'combobox-unset',
    group: 'expanded',
    html: el('combobox-unset', 'combobox', {}, ' aria-label="Fruit" aria-controls="fruits" tabindex="0"'),
    defaults: {},
    record: null,
  },
  {
    id: 'combobox-set',
    group: 'expanded',
    html: el('combobox-set', 'combobox', { expanded: 'true' }, ' aria-label="Fruit" aria-controls="fruits" tabindex="0"'),
    defaults: null,
    record: { ariaExpanded: 'true' },
  },
  { id: 'button-unset', group: 'expanded', html: el('button-unset', 'button', {}, LABEL('Menu'), 'Menu'), defaults: {}, record: null },
  { id: 'button-set', group: 'expanded', html: el('button-set', 'button', { expanded: 'true' }, LABEL('Menu'), 'Menu'), defaults: null, record: { ariaExpanded: 'true' } },
];

// The list box the comboboxes control.
const LISTBOX = '<div id="fruits" role="listbox" aria-label="Fruits"><div role="option" aria-selected="false">Apple</div></div>';

// The markup of one group's page body.
export function stateGroupBody(group: string): string {
  const body = STATE_CASES.filter((entry) => entry.group === group)
    .map((entry) => entry.html)
    .join('');
  return group === 'expanded' ? `${body}${LISTBOX}` : body;
}

export const STATE_GROUPS = [...new Set(STATE_CASES.map((entry) => entry.group))];

/**
 * The sensitivity catalog: declared accessibility defects, each with the rules expected to report
 * it and the mutation that puts it on a live page.
 *
 * A mutation is data. It names a target finder (which element on a page can carry the defect, found
 * with the reads the engine already trusts) and one edit from a small fixed set of kinds. No entry
 * carries script. The edit kinds that need script are written once in the engine, in edits.ts, and
 * take page values as JSON arguments.
 *
 * Measurement only. The catalog decides no verdict, and nothing on the normal run path reads it.
 */
import { canonicalHash } from '../../primitives/canonical.js';

export const SENSITIVITY_CATALOG_VERSION = 1;

/** The Level 1 fixture screens. Each catalog entry names the one it runs on there. */
export type Level1ScreenId =
  | 'sensitivity-basic'
  | 'sensitivity-pf'
  | 'sensitivity-rhds'
  | 'sensitivity-flow'
  | 'sensitivity-voice'
  | 'sensitivity-docs';

/**
 * One DOM change. The set is fixed: a new kind is an engine change, never catalog data.
 *
 * - remove-attribute: removes each named attribute.
 * - set-attribute: sets one attribute to a fixed value.
 * - remove-text-name: removes every source of a text name: text inside the element, aria-label,
 *   aria-labelledby, title, placeholder, and the text of its label elements.
 * - set-style: sets inline style properties, marked important.
 * - remove-element: removes the element.
 * - replace-role: sets the role attribute.
 * - swallow-key: cancels one key on the element before the page sees it.
 * - ignore-focus-calls: makes script calls to focus() do nothing on the element and everything
 *   inside it. Focus by the keyboard still works.
 */
export type Edit =
  | { kind: 'remove-attribute'; names: readonly string[] }
  | { kind: 'set-attribute'; name: string; value: string }
  | { kind: 'remove-text-name' }
  | { kind: 'set-style'; styles: Readonly<Record<string, string>> }
  | { kind: 'remove-element' }
  | { kind: 'replace-role'; role: string }
  | { kind: 'swallow-key'; key: string }
  | { kind: 'ignore-focus-calls' };

export type EditKind = Edit['kind'];

export const EDIT_KINDS: readonly EditKind[] = [
  'remove-attribute',
  'set-attribute',
  'remove-text-name',
  'set-style',
  'remove-element',
  'replace-role',
  'swallow-key',
  'ignore-focus-calls',
];

/**
 * Which elements on a page can carry the defect. The selector is read with Page.queryAll, and each
 * match is then kept or dropped by what the accessibility tree and the element's own markup say,
 * read with Page.axAt and Page.hostMarkup.
 */
export interface TargetFinder {
  selector: string;
  // Tree facts the element must have. Absent means no tree read, for an element the tree does not
  // show yet, such as a dialog that is closed when the page loads.
  tree?: {
    roles?: readonly string[];
    // true: the tree gives it a non-empty name.
    named?: boolean;
  };
  // 'some': the element holds text of its own. 'none': it holds none, such as an icon-only button.
  text?: 'some' | 'none';
  // The first match only, or every match. Default: the first.
  every?: boolean;
  // The selector must match at least this many elements, or the defect cannot happen on this page.
  // For example one toolbar alone needs no label, so removing its label creates no defect.
  atLeast?: number;
}

/**
 * Where the expected rule reports the defect, relative to the element the edit changed.
 * - target: on the element itself.
 * - inside-target: on the element or an element inside it, such as an alert inside a live region.
 * - around-target: on the element or its shadow host. A removed element is replaced by its parent.
 * - screen: anywhere on the screen, for a rule that reports the page or the control that opens
 *   something rather than the thing that was changed.
 */
export type ReportedOn = 'target' | 'inside-target' | 'around-target' | 'screen';

export interface CatalogEntry {
  id: string;
  description: string;
  // The WCAG 2.2 success criterion the defect breaks.
  criterion: { id: string; name: string };
  // The rule ids expected to report it. A trailing star names a requirement family.
  expectedRules: readonly string[];
  // Set when no shipped rule claims the defect, with where a claim to catch it is made. The entry
  // is in the catalog to measure that claim, so it can only be missed or caught by another rule.
  noShippedRule?: string;
  expectedClass: 'deterministic' | 'preview';
  reportedOn: ReportedOn;
  level1Screen: Level1ScreenId;
  // Preconditions on the screen beyond the target finder. A screen that fails one is not applicable.
  needs?: { requirement?: 'flow' | 'voice'; profile?: 'docs' };
  mutation: { target: TargetFinder; edit: Edit };
}

const NAMED_BUTTON: TargetFinder = { selector: 'button', tree: { roles: ['button'], named: true } };

const MENU_TOGGLE = '[data-ouia-component-type="PF6/MenuToggle"], [aria-haspopup="menu"], [aria-haspopup="true"]';

const LIVE_REGION = '[aria-live="polite"], [aria-live="assertive"], [role="status"], [role="alert"], [role="log"]';

export const SENSITIVITY_CATALOG: readonly CatalogEntry[] = [
  {
    id: 'button-name-removed',
    description: 'A button loses every source of its accessible name.',
    criterion: { id: '4.1.2', name: 'Name, Role, Value' },
    expectedRules: ['button-name', 'keyboard-walk-unnamed-interactive', 'pf-icon-button-name'],
    expectedClass: 'deterministic',
    reportedOn: 'target',
    level1Screen: 'sensitivity-basic',
    mutation: { target: NAMED_BUTTON, edit: { kind: 'remove-text-name' } },
  },
  {
    id: 'image-alt-removed',
    description: 'An image loses its text alternative.',
    criterion: { id: '1.1.1', name: 'Non-text Content' },
    expectedRules: ['image-alt'],
    expectedClass: 'deterministic',
    reportedOn: 'target',
    level1Screen: 'sensitivity-basic',
    mutation: {
      target: { selector: 'img[alt]:not([alt=""])', tree: { named: true } },
      edit: { kind: 'remove-attribute', names: ['alt'] },
    },
  },
  {
    id: 'field-label-removed',
    description: 'A form field loses its label.',
    criterion: { id: '1.3.1', name: 'Info and Relationships' },
    expectedRules: ['label', 'keyboard-walk-unnamed-interactive'],
    expectedClass: 'deterministic',
    reportedOn: 'target',
    level1Screen: 'sensitivity-basic',
    mutation: {
      target: {
        selector:
          'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"]), select, textarea',
        tree: { named: true },
      },
      edit: { kind: 'remove-text-name' },
    },
  },
  {
    id: 'heading-one-removed',
    description: 'The page loses its level one heading. axe-core files this rule as a best practice.',
    criterion: { id: '1.3.1', name: 'Info and Relationships' },
    expectedRules: ['page-has-heading-one'],
    expectedClass: 'deterministic',
    reportedOn: 'screen',
    level1Screen: 'sensitivity-basic',
    mutation: {
      target: { selector: 'h1', tree: { roles: ['heading'] }, every: true },
      edit: { kind: 'remove-element' },
    },
  },
  {
    id: 'text-contrast-lowered',
    description: 'Body text is set to grey on white, a contrast ratio of about 2.8 to 1, below 4.5 to 1.',
    criterion: { id: '1.4.3', name: 'Contrast (Minimum)' },
    expectedRules: ['color-contrast'],
    expectedClass: 'deterministic',
    reportedOn: 'target',
    level1Screen: 'sensitivity-basic',
    mutation: {
      target: { selector: 'main p', text: 'some' },
      edit: { kind: 'set-style', styles: { color: '#999999', 'background-color': '#ffffff' } },
    },
  },
  {
    id: 'control-out-of-tab-order',
    description: 'A visible button is taken out of the Tab order with tabindex="-1".',
    criterion: { id: '2.1.1', name: 'Keyboard' },
    expectedRules: [],
    noShippedRule:
      'No shipped rule reports a visible control that Tab never reaches. The WCAG coverage map in docs/ground-truth.md section 28 claimed under 2.1.1 that the keyboard walk reports it, until this entry measured the claim.',
    expectedClass: 'deterministic',
    reportedOn: 'target',
    level1Screen: 'sensitivity-basic',
    mutation: { target: NAMED_BUTTON, edit: { kind: 'set-attribute', name: 'tabindex', value: '-1' } },
  },
  {
    id: 'focus-trap',
    description: 'A button keeps focus when Tab is pressed on it, so a keyboard user cannot move past it.',
    criterion: { id: '2.1.2', name: 'No Keyboard Trap' },
    expectedRules: ['keyboard-walk-trap'],
    expectedClass: 'deterministic',
    reportedOn: 'target',
    level1Screen: 'sensitivity-basic',
    mutation: { target: NAMED_BUTTON, edit: { kind: 'swallow-key', key: 'Tab' } },
  },
  {
    id: 'link-name-removed',
    description: 'A link loses every source of its accessible name.',
    criterion: { id: '2.4.4', name: 'Link Purpose (In Context)' },
    expectedRules: ['link-name', 'keyboard-walk-unnamed-interactive'],
    expectedClass: 'deterministic',
    reportedOn: 'target',
    level1Screen: 'sensitivity-basic',
    mutation: {
      target: { selector: 'a[href]', tree: { roles: ['link'], named: true } },
      edit: { kind: 'remove-text-name' },
    },
  },
  {
    id: 'page-title-removed',
    description: 'The page loses its title element.',
    criterion: { id: '2.4.2', name: 'Page Titled' },
    expectedRules: ['document-title'],
    expectedClass: 'deterministic',
    reportedOn: 'screen',
    level1Screen: 'sensitivity-basic',
    mutation: { target: { selector: 'head > title', every: true }, edit: { kind: 'remove-element' } },
  },
  {
    id: 'page-language-removed',
    description: 'The html element loses its lang attribute.',
    criterion: { id: '3.1.1', name: 'Language of Page' },
    expectedRules: ['html-has-lang'],
    expectedClass: 'deterministic',
    reportedOn: 'target',
    level1Screen: 'sensitivity-basic',
    mutation: { target: { selector: 'html[lang]' }, edit: { kind: 'remove-attribute', names: ['lang'] } },
  },
  {
    id: 'role-not-a-role',
    description: 'A button is given a role value that is not an ARIA role.',
    criterion: { id: '4.1.2', name: 'Name, Role, Value' },
    expectedRules: ['aria-roles'],
    expectedClass: 'deterministic',
    reportedOn: 'target',
    level1Screen: 'sensitivity-basic',
    mutation: { target: NAMED_BUTTON, edit: { kind: 'replace-role', role: 'buton' } },
  },
  {
    id: 'pf-icon-button-name-removed',
    description: 'An icon-only button loses its aria-label, its only name.',
    criterion: { id: '4.1.2', name: 'Name, Role, Value' },
    expectedRules: ['pf-icon-button-name', 'button-name', 'keyboard-walk-unnamed-interactive'],
    expectedClass: 'deterministic',
    reportedOn: 'target',
    level1Screen: 'sensitivity-pf',
    mutation: {
      target: { selector: 'button[aria-label]', tree: { roles: ['button'], named: true }, text: 'none' },
      edit: { kind: 'remove-attribute', names: ['aria-label'] },
    },
  },
  {
    id: 'menu-toggle-state-removed',
    description: 'A menu toggle loses aria-expanded, so it no longer says whether its menu is open.',
    criterion: { id: '4.1.2', name: 'Name, Role, Value' },
    expectedRules: ['pf-kebab-expanded-state'],
    expectedClass: 'deterministic',
    reportedOn: 'target',
    level1Screen: 'sensitivity-pf',
    mutation: {
      target: { selector: `:is(${MENU_TOGGLE})[aria-expanded]` },
      edit: { kind: 'remove-attribute', names: ['aria-expanded'] },
    },
  },
  {
    id: 'menu-does-not-open-on-enter',
    description: 'A menu toggle opens its menu on a click but not on Enter.',
    criterion: { id: '2.1.1', name: 'Keyboard' },
    expectedRules: [],
    noShippedRule:
      'No shipped check presses Enter on a menu toggle. The PatternFly menu probe opens a menu with a click. The WCAG coverage map in docs/ground-truth.md section 28 says under 2.1.1 that the PatternFly rules cover kebabs.',
    expectedClass: 'deterministic',
    reportedOn: 'target',
    level1Screen: 'sensitivity-pf',
    mutation: { target: { selector: MENU_TOGGLE }, edit: { kind: 'swallow-key', key: 'Enter' } },
  },
  {
    id: 'dialog-focus-not-moved-in',
    description: 'A dialog opens and focus stays behind it, because the move into the dialog does nothing.',
    criterion: { id: '2.4.3', name: 'Focus Order' },
    expectedRules: ['pf-focus-into-dialog', 'pf-modal-focus-return'],
    expectedClass: 'deterministic',
    reportedOn: 'screen',
    level1Screen: 'sensitivity-pf',
    mutation: { target: { selector: '[role="dialog"], [role="alertdialog"]' }, edit: { kind: 'ignore-focus-calls' } },
  },
  {
    id: 'dialog-focus-not-returned',
    description: 'A dialog closes and focus does not return to the control that opened it.',
    criterion: { id: '2.4.3', name: 'Focus Order' },
    expectedRules: ['pf-modal-focus-return'],
    expectedClass: 'deterministic',
    reportedOn: 'target',
    level1Screen: 'sensitivity-pf',
    mutation: { target: { selector: '[aria-haspopup="dialog"]' }, edit: { kind: 'ignore-focus-calls' } },
  },
  {
    id: 'toast-not-live',
    description: 'The region that holds a toast alert stops being a live region.',
    criterion: { id: '4.1.3', name: 'Status Messages' },
    expectedRules: ['pf-toast-live-region'],
    expectedClass: 'deterministic',
    reportedOn: 'inside-target',
    level1Screen: 'sensitivity-pf',
    mutation: {
      target: { selector: '[aria-live]:has([class~="pf-v6-c-alert"])', every: true },
      edit: { kind: 'remove-attribute', names: ['aria-live', 'role'] },
    },
  },
  {
    id: 'table-header-scope-removed',
    description: 'A table header cell loses its scope, so cells are no longer tied to it.',
    criterion: { id: '1.3.1', name: 'Info and Relationships' },
    expectedRules: ['pf-table-header-assoc'],
    expectedClass: 'deterministic',
    reportedOn: 'target',
    level1Screen: 'sensitivity-pf',
    mutation: { target: { selector: 'table th[scope]:not([id])' }, edit: { kind: 'remove-attribute', names: ['scope'] } },
  },
  {
    id: 'row-actions-share-a-name',
    description: 'Every row action button in a table is named "Delete", so a user cannot tell the rows apart.',
    criterion: { id: '2.4.6', name: 'Headings and Labels' },
    expectedRules: ['pf-row-action-name-unique'],
    expectedClass: 'deterministic',
    reportedOn: 'target',
    level1Screen: 'sensitivity-pf',
    mutation: {
      target: { selector: 'td button', tree: { roles: ['button'], named: true }, every: true, atLeast: 2 },
      edit: { kind: 'set-attribute', name: 'aria-label', value: 'Delete' },
    },
  },
  {
    id: 'repeated-toolbar-label-removed',
    description: 'One of two toolbars on the screen loses its label.',
    criterion: { id: '1.3.1', name: 'Info and Relationships' },
    expectedRules: ['pf-toolbar-labeled-when-repeated'],
    expectedClass: 'deterministic',
    reportedOn: 'target',
    level1Screen: 'sensitivity-pf',
    mutation: {
      target: { selector: '[class~="pf-v6-c-toolbar"][aria-label]', atLeast: 2 },
      edit: { kind: 'remove-attribute', names: ['aria-label'] },
    },
  },
  {
    id: 'flow-live-region-broken',
    description: 'The live region a flow requirement expects to hear stops being a live region.',
    criterion: { id: '4.1.3', name: 'Status Messages' },
    expectedRules: ['intake:*'],
    expectedClass: 'deterministic',
    reportedOn: 'screen',
    level1Screen: 'sensitivity-flow',
    needs: { requirement: 'flow' },
    mutation: { target: { selector: LIVE_REGION, every: true }, edit: { kind: 'remove-attribute', names: ['aria-live', 'role'] } },
  },
  {
    id: 'voice-live-region-broken',
    description: 'The live region a voice requirement must hear stops being a live region.',
    criterion: { id: '4.1.3', name: 'Status Messages' },
    expectedRules: ['intake:*'],
    expectedClass: 'preview',
    reportedOn: 'screen',
    level1Screen: 'sensitivity-voice',
    needs: { requirement: 'voice' },
    mutation: { target: { selector: LIVE_REGION, every: true }, edit: { kind: 'remove-attribute', names: ['aria-live', 'role'] } },
  },
  {
    id: 'rhds-button-label-removed',
    description: 'An rh-button loses the text in its default slot, its only name.',
    criterion: { id: '4.1.2', name: 'Name, Role, Value' },
    expectedRules: ['rhds-button-accessible-label'],
    expectedClass: 'deterministic',
    reportedOn: 'target',
    level1Screen: 'sensitivity-rhds',
    mutation: { target: { selector: 'rh-button:not([accessible-label])', text: 'some' }, edit: { kind: 'remove-text-name' } },
  },
  {
    id: 'rhds-cta-link-removed',
    description: 'An rh-cta without an href loses the link that was its first child.',
    criterion: { id: '4.1.2', name: 'Name, Role, Value' },
    expectedRules: ['rhds-cta-link'],
    expectedClass: 'deterministic',
    reportedOn: 'around-target',
    level1Screen: 'sensitivity-rhds',
    mutation: { target: { selector: 'rh-cta:not([href]) > a[href]:first-child' }, edit: { kind: 'remove-element' } },
  },
  {
    id: 'rhds-tab-panel-removed',
    description: 'An rh-tabs loses one tab panel, so a tab opens nothing.',
    criterion: { id: '1.3.1', name: 'Info and Relationships' },
    expectedRules: ['rhds-tabs-paired'],
    expectedClass: 'deterministic',
    reportedOn: 'around-target',
    level1Screen: 'sensitivity-rhds',
    mutation: { target: { selector: 'rh-tabs > rh-tab-panel' }, edit: { kind: 'remove-element' } },
  },
  {
    id: 'rhds-switch-label-removed',
    description: 'An rh-switch loses its accessible-label, its only name.',
    criterion: { id: '4.1.2', name: 'Name, Role, Value' },
    expectedRules: ['rhds-switch-label'],
    expectedClass: 'deterministic',
    reportedOn: 'target',
    level1Screen: 'sensitivity-rhds',
    mutation: { target: { selector: 'rh-switch[accessible-label]' }, edit: { kind: 'remove-attribute', names: ['accessible-label'] } },
  },
  {
    id: 'rhds-skip-link-target-missing',
    description: 'An rh-skip-link is pointed at an id no element has.',
    criterion: { id: '2.4.1', name: 'Bypass Blocks' },
    expectedRules: ['rhds-skip-link-target'],
    expectedClass: 'deterministic',
    reportedOn: 'target',
    level1Screen: 'sensitivity-rhds',
    mutation: {
      target: { selector: 'rh-skip-link[href^="#"]' },
      edit: { kind: 'set-attribute', name: 'href', value: '#usabl-sensitivity-no-such-target' },
    },
  },
  {
    id: 'docs-heading-level-skipped',
    description: 'A level two heading on a documentation page is exposed as level four.',
    criterion: { id: '1.3.1', name: 'Info and Relationships' },
    expectedRules: ['docs-heading-order'],
    expectedClass: 'deterministic',
    reportedOn: 'target',
    level1Screen: 'sensitivity-docs',
    needs: { profile: 'docs' },
    mutation: {
      target: { selector: 'h2', tree: { roles: ['heading'] } },
      edit: { kind: 'set-attribute', name: 'aria-level', value: '4' },
    },
  },
];

/**
 * Shipped rules the catalog has no entry for, each with the reason. Every other shipped rule an
 * entry does not name is listed in the attestation too, with a general reason, so no rule is left
 * out silently.
 */
export const NOT_EXERCISED_REASONS: Readonly<Record<string, string>> = {
  'keyboard-walk-unconfirmed-focus':
    'It needs a focused element the accessibility tree cannot describe. No edit kind in the catalog makes that happen reliably.',
  'keyboard-walk-truncated':
    'It discloses where the walk stopped. The focus trap entry produces it beside keyboard-walk-trap, so no entry expects it on its own.',
  'rhds-accordion-header-parent': 'It needs an element moved under a new parent. No edit kind moves an element.',
  'rhds-dialog-name':
    'A closed rh-dialog with no name source is reported as unverified by design, and an open one needs the real component. The fixture uses small stand-in elements that do not model a dialog.',
};

export const GENERAL_NOT_EXERCISED_REASON = 'The catalog declares no mutation for this rule yet.';

export const OFF_BY_DEFAULT_REASON = 'axe-core runs this rule only when a caller turns it on. usabl does not, so it never runs.';

/** A hash of the catalog version, every entry, and the not-exercised reasons. */
export function catalogHash(): string {
  return canonicalHash({
    version: SENSITIVITY_CATALOG_VERSION,
    entries: SENSITIVITY_CATALOG,
    notExercised: NOT_EXERCISED_REASONS,
  });
}

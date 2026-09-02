/**
 * PatternFly 6 selector constants for static rulepack checks.
 *
 * Matching the project fixture is not evidence. A fixture gets written to satisfy whatever
 * the selectors already say, so a selector can pass every unit test and still match nothing
 * on a real page. That is what happened here: menuToggle and dialogTrigger keyed on
 * aria-haspopup, which PatternFly 6's MenuToggle does not emit, and the rules built on them
 * were silent on every real screen while the suite stayed green.
 *
 * So the standard for this file is different. Every selector below is checked against markup
 * that PatternFly rendered, in fixtures/pf6/rendered-markup.html, by
 * test/providers/pf6-real-markup.test.ts. Change a selector here and change that test too.
 *
 * Version assumption: PatternFly 6. Two things are pinned to it. OUIA type values carry a
 * "PF6/" prefix, written by getOUIAProps in @patternfly/react-core. Class names carry a
 * "pf-v6-c-" prefix. Both need review for PatternFly 7. The role and ARIA state arms do not.
 */
export const SEL = {
  alert: '[class*="pf-v6-c-alert"]',
  liveContainer: '[aria-live], [role="status"], [role="alert"], [role="log"]',
  unnamedButton: 'button[aria-label=""], button:not([aria-label]):not([aria-labelledby])',

  /**
   * Menu toggles: dropdown triggers, select triggers and kebabs.
   *
   * MenuToggle is the component behind all of them in PatternFly 6, and it emits no
   * aria-haspopup at all. What it does emit, on the interactive element, is
   * data-ouia-component-type="PF6/MenuToggle". That holds for the plain button variant and
   * for the typeahead and split-button variants, where the toggle is an inner button and the
   * outer pf-v6-c-menu-toggle element is a div with no toggle semantics. Keying on the OUIA
   * attribute lands on the right element in all three; keying on the class would also pick up
   * those wrapper divs and report them as toggles with no state.
   *
   * OUIA is PatternFly's published automation contract, so it is the most stable handle
   * available, but it is not universal: Dropdown, Select and Menu set it, while Popover and
   * Tooltip do not. Only components confirmed to set it are used here.
   *
   * aria-haspopup="menu" stays because it is not dead. PatternFly emits it from NavItem
   * flyouts, MenuItem flyouts and the Tabs overflow toggle, and it is the correct thing for
   * an application to author on a custom toggle.
   *
   * aria-haspopup="true" is the legacy ARIA synonym for "menu". PatternFly 6.5.1 never
   * produces it (ToolbarToggleGroup tries, but parses a rem breakpoint as a pixel count and
   * always resolves false), so this arm exists for application-authored toggles only.
   */
  menuToggle: '[data-ouia-component-type="PF6/MenuToggle"], [aria-haspopup="menu"], [aria-haspopup="true"]',

  /**
   * Controls that open a dialog.
   *
   * PatternFly 6 puts no marker on a Modal trigger. A Modal is rendered from component state
   * and its trigger is an ordinary Button, so there is nothing in the markup that connects
   * the two. Popover is the same. The one component in the library that declares dialog
   * intent is DatePicker's calendar button, which sets aria-haspopup="dialog" by hand.
   *
   * The second arm is the ARIA disclosure contract: a control that names the surface it
   * shows, through aria-controls, and reports whether that surface is showing, through
   * aria-expanded. PatternFly does not add those for you, but it renders them when an
   * application passes them, and an application that wants its modals checked has to make
   * the relationship visible one way or the other. Disclosure controls are also safe for the
   * probe to activate, which matters because probeDialogs clicks whatever this matches.
   *
   * Deliberately absent: any arm that would match ordinary buttons, such as
   * data-ouia-component-type="PF6/Button". Clicking every button on a live screen would
   * submit forms and delete records.
   *
   * Known gap, stated rather than papered over: a PatternFly Modal opened by a bare Button
   * cannot be found from markup, so the dialog focus rules do not reach it.
   */
  dialogTrigger: '[aria-haspopup="dialog"], [aria-expanded][aria-controls]',

  dialog: '[role="dialog"], [role="alertdialog"]',
  menu: '[role="menu"], [role="listbox"]',
  toolbar: '[class*="pf-v6-c-toolbar"]',
  rowActionButton: 'td button, td [role="button"]',
  unscopedTh: 'table th:not([scope]):not([id])',
} as const;

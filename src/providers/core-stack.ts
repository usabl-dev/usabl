/**
 * Deterministic scan providers shared by `buildDeps` and `checkPage`.
 * Both build their provider list through makeScanProviders, so the core stack and the
 * intake-mapped providers cannot drift apart between the CLI and the Playwright helper.
 * buildDeps then adds the optional commercial engines the trusted config turns on, after this list;
 * checkPage does not. This unit never mints a verdict.
 */
import type { Provider, RequirementBundle } from '../contracts/index.js';
import { mapRequirementsToProviders } from '../intake/map-to-providers.js';
import { axeProvider } from './axe/index.js';
import { makeDocsRulepackProvider } from './docs-rulepack/index.js';
import { makeKeyboardWalkProvider } from './keyboard-walk/index.js';
import { makeRhdsRulepackProvider } from './rhds/index.js';
import { makeRulepackProvider } from './rulepack/index.js';

// Per-screen budget for the keyboard walk, anchored when each walk starts. It guards against a
// focus order that never cycles back; it is not a throttle on normal screens, which end on their
// own once focus returns to a stop already seen. Wall clock binds before the 200 tab-stop cap does.
// Measured screens carry up to about 145 focusable elements, and every stop costs several browser
// round trips, so a large screen on a busy main thread needs seconds, not milliseconds. This is
// also the budget the real-browser smoke entry uses, so the shipped path and the path we actually
// exercise against Chromium agree.
export const KEYBOARD_WALL_CLOCK_MS = 15_000;

export interface CoreProviderOptions {
  keyboardWalk?: boolean;
  tabCap?: number;
  wallClockMs?: number;
}

/**
 * Core provider stack for a live scan. Order matches buildDeps: axe, PatternFly rulepack (runs only
 * on a page with a PatternFly marker, never on docs), RHDS rulepack (runs only on a page with an
 * RHDS element, on app and docs), docs rulepack (self-gates to the docs profile), keyboard walk.
 * The provider runner moves page-mutating providers, such as the PatternFly probes, to the end.
 */
export function makeCoreProviders(options: CoreProviderOptions = {}): Provider[] {
  const providers: Provider[] = [
    axeProvider,
    makeRulepackProvider(),
    makeRhdsRulepackProvider(),
    makeDocsRulepackProvider(),
  ];
  if (options.keyboardWalk === false) {
    return providers;
  }

  const walkOptions: { wallClockMs: number; tabCap?: number } = {
    wallClockMs: options.wallClockMs ?? KEYBOARD_WALL_CLOCK_MS,
  };
  if (options.tabCap !== undefined) {
    walkOptions.tabCap = options.tabCap;
  }
  providers.push(makeKeyboardWalkProvider(walkOptions));
  return providers;
}

/**
 * The core provider list for one scan: the core stack, then one provider per runtime design
 * requirement. This is the one place that list is built. The CLI and the Playwright helper both
 * call it, so a page cannot pass one of them and regress in the other because a deterministic
 * provider was wired into only one. buildDeps adds the trusted engines after this list. Their
 * findings are preview, and preview never moves a verdict: the gate ignores it and the helper lists
 * it as advisory. So the helper leaving the engines out cannot make the two disagree, and neither
 * can the preview drafts of a voice requirement, which both run. Null means the requirements could
 * not be loaded; the caller must disclose that, because the core stack alone does not check them.
 */
export function makeScanProviders(
  requirements: RequirementBundle | null,
  options: CoreProviderOptions = {},
): Provider[] {
  const providers = makeCoreProviders(options);
  if (requirements !== null) {
    providers.push(...mapRequirementsToProviders(requirements));
  }
  return providers;
}

/**
 * One plain sentence per provider on what it checks, keyed by provider id. `usabl brief` prints
 * these so an agent knows what each check proves before it starts a task. A test builds every
 * provider a run can have and fails when one has no sentence here, so a new provider cannot reach
 * the brief without one.
 */
export const PROVIDER_PROVES: Readonly<Record<string, string>> = {
  'axe-core':
    'Runs the axe-core rules on the rendered page: names, roles, states, contrast, labels, and structure.',
  'pf-rulepack':
    'Checks PatternFly components for barriers axe misses, such as icon buttons with no name, kebab menus with no expanded state, and table headers with no scope or id to tie cells to them.',
  'rhds-rulepack':
    'Checks Red Hat Design System elements are put together as their documentation requires, such as buttons with a label and tabs paired with panels.',
  'docs-rulepack': 'Checks heading order on the rendered documentation page.',
  'keyboard-walk':
    'Tabs through the screen as it loaded and checks that each focus stop has a name and that focus is not trapped.',
  deque: 'Runs the rules of Deque axe DevTools that axe-core does not have. Its findings are preview.',
  evinced: 'Runs the Evinced issue checks on the rendered page. Its findings are preview.',
};

// The silent change rule runs inside the step loops of flow and voice requirements, so the brief
// names it with both.
const SILENT_CHANGE_PROVES =
  'It also runs the silent change rule on each click and activate step: a step that changes the page, is not announced, and does not move focus to a named control is a preview finding.';

// Intake providers are one per design requirement, so their ids are the requirement ids. Their
// sentence comes from the kind of requirement, which is the provider layer.
const INTAKE_PROVES: Readonly<Record<string, string>> = {
  'intake-content':
    'content requirement: the element the requirement names has the accessible text or name the requirement states.',
  'intake-flow': `flow requirement: after the steps the requirement lists, the expected announcement is heard on focus or in a live region. ${SILENT_CHANGE_PROVES}`,
  voicing: `voice requirement: after each step the requirement lists, the focused control has a name and role, and the words each obligation requires are heard. Its findings are preview unless the trusted config promotes the obligation class. ${SILENT_CHANGE_PROVES}`,
  'intake-name': 'name requirement: exactly one element on the screen has the role and accessible name the requirement states.',
  'intake-heading': 'heading requirement: the one heading with the name the requirement states is at the level it states.',
  'intake-landmark': 'landmark requirement: the screen has a landmark with the role, and the name when one is given, that the requirement states.',
  'intake-focus-order': 'focus order requirement: Tab from the top of the screen as it loaded reaches the names the requirement lists, each on one stop, in that order.',
  'intake-target-size': 'target size requirement: the one element with the role and name the requirement states is at least as wide and as high as the size it states, in CSS pixels.',
};

/** The sentence for one provider, or null when this table does not know it. */
export function providerProves(provider: Provider): string | null {
  const own = PROVIDER_PROVES[provider.id];
  if (own !== undefined) {
    return own;
  }
  if (provider.id.startsWith('intake:')) {
    return INTAKE_PROVES[provider.layer] ?? null;
  }
  return null;
}

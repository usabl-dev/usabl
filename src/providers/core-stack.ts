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
 * findings are preview and never move the verdict, so the helper leaving them out cannot make the
 * two disagree on a regression. Null means the requirements could not be loaded; the caller must
 * disclose that, because the core stack alone does not check them.
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

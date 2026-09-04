/**
 * Deterministic scan providers shared by `buildDeps` and `checkPage`.
 * Intake-mapped providers stay wired only by buildDeps. This unit never mints a verdict.
 */
import type { Provider } from '../contracts/index.js';
import { axeProvider } from './axe/index.js';
import { makeDocsRulepackProvider } from './docs-rulepack/index.js';
import { makeKeyboardWalkProvider } from './keyboard-walk/index.js';
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
 * Core provider stack for a live scan. Order matches buildDeps: axe, PatternFly rulepack,
 * docs rulepack (self-gates to the docs profile), keyboard walk.
 */
export function makeCoreProviders(options: CoreProviderOptions = {}): Provider[] {
  const providers: Provider[] = [axeProvider, makeRulepackProvider(), makeDocsRulepackProvider()];
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

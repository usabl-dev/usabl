/**
 * Parse the keyboardWalk block of usabl.config.json: the walk budget of each screen.
 * This unit validates shape and bounds only. It must never mint a verdict.
 *
 * A long table page has more Tab stops than the engine default allows, and a walk that runs out is
 * a coverage gap on its screen, so the budget has to be something an operator can raise. Each value
 * has an upper bound: a walk past it costs more time than a gate can wait, and a value past it is
 * almost always a typo. checkPage checks its own options with the same bounds.
 */
import type { KeyboardWalkConfig, KeyboardWalkScreenConfig } from '../contracts/index.js';
import { configError } from './config-error.js';
import { describeIdProblem } from './id-grammar.js';

// The most Tab stops one walk takes. A screen with more is better split into several screens.
export const MAX_WALK_TAB_CAP = 2000;
// The most time one walk spends, five minutes.
export const MAX_WALK_WALL_CLOCK_MS = 300_000;

const SCREEN_KEYS = new Set(['tabCap', 'wallClockMs']);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A safe integer, because JSON reads 1e100 as a number that passes Number.isInteger.
function inRange(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max;
}

/**
 * The tabCap and wallClockMs of one walk, each checked against its bound. `label` names where the
 * values came from, so the message says which field to fix. A value left out stays out.
 */
export function parseWalkBudget(raw: { tabCap?: unknown; wallClockMs?: unknown }, label: string): KeyboardWalkScreenConfig {
  const budget: KeyboardWalkScreenConfig = {};
  if (raw.tabCap !== undefined) {
    if (!inRange(raw.tabCap, MAX_WALK_TAB_CAP)) {
      throw configError`${label}.tabCap must be a whole number of Tab stops from 1 to ${String(MAX_WALK_TAB_CAP)}. A screen with more Tab stops than that is better split into several screens.`;
    }
    budget.tabCap = raw.tabCap;
  }
  if (raw.wallClockMs !== undefined) {
    if (!inRange(raw.wallClockMs, MAX_WALK_WALL_CLOCK_MS)) {
      throw configError`${label}.wallClockMs must be a whole number of milliseconds from 1 to ${String(MAX_WALK_WALL_CLOCK_MS)}.`;
    }
    budget.wallClockMs = raw.wallClockMs;
  }
  return budget;
}

function parseScreen(raw: unknown, label: string): KeyboardWalkScreenConfig {
  if (!isObject(raw)) {
    throw configError`${label} must be an object`;
  }
  // A misspelled key would leave the default budget on the screen without a word.
  for (const key of Object.keys(raw)) {
    if (!SCREEN_KEYS.has(key)) {
      throw configError`${label} has an unknown key "${key}". The keys it accepts are tabCap and wallClockMs.`;
    }
  }
  return parseWalkBudget({ tabCap: raw['tabCap'], wallClockMs: raw['wallClockMs'] }, label);
}

export function parseKeyboardWalkConfig(raw: unknown): KeyboardWalkConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isObject(raw)) {
    throw configError`keyboardWalk must be an object`;
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'perSurface') {
      throw configError`keyboardWalk has an unknown key "${key}". The key it accepts is perSurface.`;
    }
  }
  const perSurfaceRaw = raw['perSurface'];
  if (perSurfaceRaw === undefined) {
    return {};
  }
  if (!isObject(perSurfaceRaw)) {
    throw configError`keyboardWalk.perSurface must be an object`;
  }
  // Null prototype, so a key such as "__proto__" is a screen of its own and every read is an own key.
  const perSurface: Record<string, KeyboardWalkScreenConfig> = Object.create(null);
  let keyPosition = 0;
  for (const [screenId, value] of Object.entries(perSurfaceRaw)) {
    keyPosition += 1;
    // Every key is a screen id, matched by exact comparison, so it answers to the id grammar. A key
    // the grammar refuses can never match a screen, and its budget would apply to nothing. The key
    // is named by its position, never printed back, as noiseBudget.perSurface does.
    const problem = describeIdProblem(screenId);
    if (problem !== null) {
      throw configError`keyboardWalk.perSurface key ${String(keyPosition)} names a screen, and a key the id grammar refuses can never match one, so its settings would apply to nothing. The count is the order the keys are read back, which is not always the order they appear in the file. The key ${problem}`;
    }
    perSurface[screenId] = parseScreen(value, `keyboardWalk.perSurface.${screenId}`);
  }
  return { perSurface };
}

/** The settings of one screen, or none. Only an own key counts. */
export function walkScreenConfig(config: { keyboardWalk?: KeyboardWalkConfig }, screenId: string): KeyboardWalkScreenConfig | undefined {
  const perSurface = config.keyboardWalk?.perSurface;
  return perSurface !== undefined && Object.hasOwn(perSurface, screenId) ? perSurface[screenId] : undefined;
}

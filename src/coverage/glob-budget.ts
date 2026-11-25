/**
 * The budgets that keep glob matching in one planner run short. Each match costs at most its
 * pattern's length times its path's length, but a run tests many files against many patterns, and
 * a long list with long changed paths could add up to minutes. A Stop hook's deadline is a timer
 * in the same process and cannot end a match that is running, so the planner carries these budgets
 * and reads a file it could not finish as a gap. This unit holds no verdict and decides none.
 */
import { GLOB_IMPORT_CHARACTERS, GlobImportBudget } from './import-graph.js';
import { GlobMatchBudget, RUN_GLOB_MATCH_STEPS } from '../primitives/match-glob.js';
import { compareCodeUnits } from '../primitives/sortKey.js';

/**
 * The glob matching steps test-file placement may spend in a run. Placement tests every test file
 * of the repository against every import.meta.glob pattern, so a large app spends far more there
 * than on the changed files. An app of 20,000 test files about 60 characters deep and 40 calls of
 * three ordinary patterns spent 0.51 billion steps, about half of this budget; with test files
 * about 30 characters deep it spent 0.26 billion. On a loaded 8-core machine the worst shapes ran
 * at 20 to 35 million steps a second, so this budget and the two planner budgets together, 1.2
 * billion steps, are at most about 60 seconds of matching at the slowest rate measured.
 */
export const PLACEMENT_GLOB_MATCH_STEPS = 1_000_000_000;

export interface RunGlobBudgets {
  // The steps the planner's other glob matches may take together: the changed files against the
  // policy lists, and the discovery detail of each gap.
  steps: GlobMatchBudget;
  // The steps test-file placement may take: every test file against every import.meta.glob pattern.
  placement: GlobMatchBudget;
  // The characters of import.meta.glob patterns the run reads, across every call.
  globImports: GlobImportBudget;
}

export function runGlobBudgets(): RunGlobBudgets {
  return {
    steps: new GlobMatchBudget(RUN_GLOB_MATCH_STEPS),
    placement: new GlobMatchBudget(PLACEMENT_GLOB_MATCH_STEPS),
    globImports: new GlobImportBudget(GLOB_IMPORT_CHARACTERS),
  };
}

/**
 * The changed files in the order a budget spends on them: sorted by UTF-16 code units, so the
 * same set of changed files runs out at the same file whatever order the caller lists them in.
 */
export function budgetOrder(files: readonly string[]): string[] {
  return [...files].sort(compareCodeUnits);
}

function grouped(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+$)/g, ',');
}

/** The gap reason for a changed file usabl could not test against the globs in time. */
export function globBudgetGapReason(lists: string): string {
  return (
    `usabl used its budget of ${grouped(RUN_GLOB_MATCH_STEPS)} glob matching steps for this check before it could test ` +
    `this changed file against ${lists}, so it cannot tell what the file is and did not check it. ` +
    'This happens only with very long globs, very many of them, or very long changed paths. Shorten the globs ' +
    'or the paths, or check a smaller change.'
  );
}

/**
 * Said before a gap reason when a budget ran out while usabl read the loads that may reach a file.
 * `steps` is the size of the budget that ran out, and `what` says what it was spent on.
 */
export function globBudgetLoadsNote(steps: number, what: string): string {
  return (
    `usabl used its budget of ${grouped(steps)} glob matching steps for ${what} in this check, ` +
    'so it reads every import.meta.glob call left to test as one that may load this file.'
  );
}

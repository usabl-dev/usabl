/**
 * The budgets that keep glob matching in one planner run short. Each match costs at most its
 * pattern's length times its path's length, but a run tests many files against many patterns, and
 * a long list with long changed paths could add up to minutes. A Stop hook's deadline is a timer
 * in the same process and cannot end a match that is running, so the planner carries these budgets
 * and reads a file it could not finish as a gap. This unit holds no verdict and decides none.
 */
import { GLOB_IMPORT_CHARACTERS, GlobImportBudget } from './import-graph.js';
import { GlobMatchBudget, RUN_GLOB_MATCH_STEPS } from '../primitives/match-glob.js';

export interface RunGlobBudgets {
  // The steps every glob match of the run may take together.
  steps: GlobMatchBudget;
  // The characters of import.meta.glob patterns the run reads, across every call.
  globImports: GlobImportBudget;
}

export function runGlobBudgets(): RunGlobBudgets {
  return { steps: new GlobMatchBudget(RUN_GLOB_MATCH_STEPS), globImports: new GlobImportBudget(GLOB_IMPORT_CHARACTERS) };
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

/** Said before a gap reason when the budget ran out while usabl read the loads that may reach a file. */
export const GLOB_BUDGET_LOADS_NOTE =
  `usabl used its budget of ${grouped(RUN_GLOB_MATCH_STEPS)} glob matching steps for this check, ` +
  'so it reads every import.meta.glob call left to test as one that may load this file.';

/**
 * Validate that operator surface ids can carry scan identity.
 * A surface id is the key the coverage planner stores affected screens under, so it has to be
 * present, it has to be readable, and it has to name exactly one screen. Two surfaces sharing an
 * id would collapse into one map entry: the second screen is dropped from the scan while its
 * changed files still count as mapped, so the run reports both screens as covered when only one
 * was ever opened. An empty id is the same failure with a blank key.
 * This unit validates ids only. It must never rewrite an id or choose a screen.
 */
import type { SurfaceConfig } from '../contracts/index.js';
import { configError } from './config-error.js';
import { describeIdProblem } from './id-grammar.js';

/**
 * Returns why an id cannot carry scan identity, or null when it can.
 *
 * The rule is the shared id grammar and nothing else, so surface ids, screen ids, and requirement
 * ids all answer to one definition of what an id may contain. This unit adds only the uniqueness
 * check, which needs the whole surface list.
 *
 * Exported so a generator can ask the question the parser is going to ask, rather than writing a
 * config the parser then refuses to read.
 */
export function describeSurfaceIdProblem(id: string): string | null {
  return describeIdProblem(id);
}

export function assertSurfaceIds(surfaces: readonly SurfaceConfig[]): void {
  const firstIndexById = new Map<string, number>();
  surfaces.forEach((surface, index) => {
    const problem = describeSurfaceIdProblem(surface.id);
    if (problem !== null) {
      throw configError`surfaces[${index}].id ${problem}`;
    }

    const firstIndex = firstIndexById.get(surface.id);
    if (firstIndex !== undefined) {
      throw configError`surfaces[${index}].id "${surface.id}" repeats surfaces[${firstIndex}].id. Every surface id must be unique, because usabl tracks coverage by surface id and a repeated id hides one of the two screens from the scan. Give one of them a different id.`;
    }
    firstIndexById.set(surface.id, index);
  });
}

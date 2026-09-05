/**
 * Validate that operator surface ids can carry scan identity.
 * A surface id is the key the coverage planner stores affected screens under, so it has to be
 * present and it has to name exactly one screen. Two surfaces sharing an id would collapse into
 * one map entry: the second screen is dropped from the scan while its changed files still count
 * as mapped, so the run reports both screens as covered when only one was ever opened. An empty
 * id is the same failure with a blank key. Both are refused here.
 * This unit validates ids only. It must never rewrite an id or choose a screen.
 */
import type { SurfaceConfig } from '../contracts/index.js';

export function assertSurfaceIds(surfaces: readonly SurfaceConfig[]): void {
  // Ids are compared with surrounding whitespace removed. Everything downstream compares ids
  // exactly, so "settings" and " settings " would not collide in the map, but they read as the
  // same screen to the operator writing the config and to anyone reading the report. Treat them
  // as the duplicate they look like rather than let one of them stand for a screen nobody meant.
  const firstIndexById = new Map<string, number>();
  surfaces.forEach((surface, index) => {
    const id = surface.id.trim();
    if (id.length === 0) {
      throw new Error(
        `surfaces[${index}].id must be a non-empty string. ` +
          `usabl tracks coverage by surface id, so a blank id cannot name a screen.`,
      );
    }
    const firstIndex = firstIndexById.get(id);
    if (firstIndex !== undefined) {
      throw new Error(
        `surfaces[${index}].id "${surface.id}" repeats surfaces[${firstIndex}].id. ` +
          `Every surface id must be unique, because usabl tracks coverage by surface id and a ` +
          `repeated id hides one of the two screens from the scan. Give one of them a different id.`,
      );
    }
    firstIndexById.set(id, index);
  });
}

/**
 * The provider notes a Result carries, one entry per note with the screen it is about, for the
 * surfaces that print them beside the coverage gaps. A note is disclosure only: it is not a gap,
 * it never moves the verdict, and nothing here reads it as evidence of anything.
 *
 * The Result is exported and a caller can build one outside the engine, so a screen list or a note
 * list that is not a list, and a note whose fields are not strings, contribute nothing.
 */
import type { Result } from '../contracts/index.js';

/** The label every surface prints a note under, so a reader never takes one for a gap. */
export const NOTES_HEADING = 'disclosed, does not block';

export interface ScreenNote {
  screenId: string;
  ref: string;
  reason: string;
}

export function screenNotes(result: Result): ScreenNote[] {
  const screens: unknown = result.screens;
  if (!Array.isArray(screens)) {
    return [];
  }
  const out: ScreenNote[] = [];
  for (const screen of screens as Array<{ screenId?: unknown; notes?: unknown }>) {
    if (!Array.isArray(screen?.notes) || typeof screen.screenId !== 'string') {
      continue;
    }
    for (const note of screen.notes as Array<{ ref?: unknown; reason?: unknown }>) {
      if (typeof note?.ref === 'string' && typeof note.reason === 'string') {
        out.push({ screenId: screen.screenId, ref: note.ref, reason: note.reason });
      }
    }
  }
  return out;
}

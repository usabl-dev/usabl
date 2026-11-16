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

/**
 * The ref of the note the keyboard walk gives a region it could not read into and that the team
 * listed for the screen in usabl.config.json. The region was not checked, so it is a known limit,
 * and every surface that shows a verdict says the run has known limits.
 */
export const UNREAD_REGION_NOTE_REF = 'provider:keyboard-walk/unread-region';

/**
 * The ref of the note for a listing that matched no region on a walk that reached the end of the
 * page. Nothing went unchecked because of it, so it is not a known limit. It asks for the line to
 * be removed or corrected.
 */
export const STALE_REGION_LISTING_NOTE_REF = 'provider:keyboard-walk/stale-region-listing';

export interface ScreenNote {
  screenId: string;
  ref: string;
  reason: string;
}

/** Whether the Result holds a known limit: a region the walk could not read that the team listed. */
export function hasKnownLimits(result: Result): boolean {
  return screenNotes(result).some((note) => note.ref === UNREAD_REGION_NOTE_REF);
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

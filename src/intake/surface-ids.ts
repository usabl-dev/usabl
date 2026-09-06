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
import { codePointLabel, validateId } from './id-grammar.js';

// The character rule lives in the shared id grammar, so surface ids, screen ids, and requirement
// ids all answer to one definition of what an id may contain. This unit only turns that grammar's
// result into the message a config error carries, and adds the uniqueness check that needs the
// whole surface list.

const BLANK_ID_PROBLEM =
  'must be a non-empty string. usabl tracks coverage by surface id, so a blank id cannot name a screen.';

/**
 * Returns why an id cannot carry scan identity, or null when it can.
 *
 * Exported so a generator can ask the question the parser is going to ask, rather than writing a
 * config the parser then refuses to read.
 */
export function describeSurfaceIdProblem(id: string): string | null {
  // Blankness is checked on the trimmed value so an id of only spaces is reported as the empty id
  // it is. That is the clearer message. The grammar below still refuses the whitespace itself, and
  // comparison never trims.
  if (id.trim().length === 0) {
    return BLANK_ID_PROBLEM;
  }

  const result = validateId(id);
  if (result.ok) {
    return null;
  }

  switch (result.problem) {
    case 'empty':
      // Unreachable after the trimmed check above, kept so the switch stays exhaustive.
      return BLANK_ID_PROBLEM;
    case 'disallowed-character':
      // The offending character is reported as a position and a code point rather than repeated
      // into the message, because every character the grammar rejects is either invisible or
      // reorders its neighbours. Printing one back would show the operator nothing, or would show
      // them something other than what the file holds. The position counts characters from one,
      // which is how a person reading the config file counts.
      return (
        `contains a character that is not allowed, at position ${result.index + 1}: ` +
        `${codePointLabel(result.codePoint)}. A surface id must not contain whitespace, and must not ` +
        `contain invisible or control characters, because usabl tracks coverage by surface id and ` +
        `an id that renders as nothing cannot be told from another one. Use visible characters ` +
        `with no spaces, for example "user-settings".`
      );
    case 'not-nfc':
      return (
        'must be written in Unicode NFC form. Two canonically equivalent spellings look identical ' +
        'but compare as different ids, so usabl would treat one screen as two.'
      );
  }
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

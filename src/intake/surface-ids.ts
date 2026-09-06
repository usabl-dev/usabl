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

// Characters a surface id may not contain.
//
// Ids are compared exactly, because exact is the comparison every consumer downstream already
// makes: the planner's affected-screen map, the evidence floor, and the receipt all key on the id
// as written. A rule that folded ids together for validation but not for lookup would refuse pairs
// that actually work while passing pairs that actually collide.
//
// So the grammar, not the comparison, is what removes ids that cannot be told apart on sight.
// \s covers the space characters that render as a gap, including U+00A0 and U+3000. Cc and Cf
// cover controls and format characters. Default_Ignorable_Code_Point covers the rest of what a
// conforming renderer is expected to draw as nothing, which is where the variation selectors, the
// Hangul fillers, and the combining grapheme joiner live, and it is a maintained Unicode property
// rather than a hand-picked list that goes stale. Cs and Co are lone surrogates and private use,
// which have no agreed rendering.
//
// What this does NOT deliver, stated plainly so the rule is not read as more than it is. It does
// not stop confusables across scripts, so Latin "a" and Cyrillic "a" are both accepted and remain
// distinct ids. That is a deliberate limit: both are scanned, both appear in receipt coverage, and
// waiver matching is exact, so no screen is lost by it. Unassigned code points are also accepted,
// because rejecting them would make an id's validity depend on which Unicode version the running
// Node build happens to carry. The claim here is narrow: an accepted id renders as something, and
// two accepted ids that differ do so visibly unless their difference is a confusable glyph.
const DISALLOWED_ID_CHARACTER = /[\s\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Default_Ignorable_Code_Point}]/u;

/**
 * Describes a code point the way a config file can be searched for it.
 *
 * The offending character is reported as a code point rather than repeated into the message,
 * because every character the grammar rejects is either invisible or reorders its neighbours.
 * Printing one back would show the operator nothing, or would show them something other than what
 * the file holds.
 */
function codePointLabel(character: string): string {
  const point = character.codePointAt(0) ?? 0;
  return `U+${point.toString(16).toUpperCase().padStart(4, '0')}`;
}

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
    return 'must be a non-empty string. usabl tracks coverage by surface id, so a blank id cannot name a screen.';
  }

  let position = 0;
  for (const character of id) {
    position += 1;
    if (DISALLOWED_ID_CHARACTER.test(character)) {
      return (
        `contains a character that is not allowed, at position ${position}: ` +
        `${codePointLabel(character)}. A surface id must not contain whitespace, and must not ` +
        `contain invisible or control characters, because usabl tracks coverage by surface id and ` +
        `an id that renders as nothing cannot be told from another one. Use visible characters ` +
        `with no spaces, for example "user-settings".`
      );
    }
  }

  // Canonically equivalent spellings are the same text by definition, so they render identically
  // while comparing unequal. Requiring one spelling keeps exact comparison honest for them without
  // folding anything at lookup time.
  if (id !== id.normalize('NFC')) {
    return (
      'must be written in Unicode NFC form. Two canonically equivalent spellings look identical ' +
      'but compare as different ids, so usabl would treat one screen as two.'
    );
  }

  return null;
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

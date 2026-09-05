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
import { scrubString } from '../surfaces/scrub.js';

// Characters a surface id may not contain.
//
// Ids are compared exactly, because exact is the comparison every consumer downstream already
// makes: the planner's affected-screen map, the evidence floor, and the receipt all key on the id
// as written. A rule that folded ids together for validation but not for lookup would refuse
// pairs that actually work while passing pairs that actually collide.
//
// Exact comparison is only honest if distinct ids also look distinct. Two ids no reader can tell
// apart are a hazard whether or not they are the same map key: an operator cannot see which
// screen a report is about, and cannot see that a second screen went unscanned. So the grammar
// removes the characters that make ids indistinguishable, rather than the comparison doing it.
// \s covers the space characters that render as a gap, including U+00A0 and U+3000. Cc and Cf
// cover controls and format characters, which is where the zero-width and bidirectional
// characters live: U+200B, U+200F, and U+202E render as nothing at all, and the bidi ones also
// reorder the text printed around them. Cs and Co are lone surrogates and private use, which have
// no agreed rendering. Everything a font actually draws is still allowed, so the ids discovery
// derives from route paths, such as "users-:id", stay valid.
const DISALLOWED_ID_CHARACTER = /[\s\p{Cc}\p{Cf}\p{Cs}\p{Co}]/u;

// Caps how much of an operator string an error message repeats back.
const MESSAGE_TEXT_LIMIT = 120;

/**
 * Prepares operator text for an error message.
 *
 * Config parsing runs before a Result exists, so none of this passes through scrubResult on the
 * way out. A config error goes straight to stderr and, through the stop hook, to a model. Branch
 * config is not trusted until the guard has checked it, so a value read out of one is untrusted
 * text arriving at a terminal, and this is its egress. Reuse the surface scrubber rather than
 * write a second one: control sequences and forged frame markers have to come out here the same
 * way they come out of page text. The cap keeps one very long value from burying the sentence
 * that explains what to fix.
 */
export function forMessage(text: string): string {
  const scrubbed = scrubString(text);
  const characters = [...scrubbed];
  if (characters.length <= MESSAGE_TEXT_LIMIT) {
    return scrubbed;
  }
  return `${characters.slice(0, MESSAGE_TEXT_LIMIT).join('')} (truncated)`;
}

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

function assertIdGrammar(id: string, index: number): void {
  let position = 0;
  for (const character of id) {
    position += 1;
    if (!DISALLOWED_ID_CHARACTER.test(character)) {
      continue;
    }
    throw new Error(
      `surfaces[${index}].id contains a character that is not allowed, at position ${position}: ` +
        `${codePointLabel(character)}. A surface id must not contain whitespace, and must not ` +
        `contain invisible or control characters, because usabl tracks coverage by surface id and ` +
        `two ids that look alike must not stand for two different screens. Use visible characters ` +
        `with no spaces, for example "user-settings".`,
    );
  }
}

export function assertSurfaceIds(surfaces: readonly SurfaceConfig[]): void {
  const firstIndexById = new Map<string, number>();
  surfaces.forEach((surface, index) => {
    // Blankness is checked on the trimmed value so an id of only spaces is reported as the empty
    // id it is. That is the clearer message for the operator. The grammar below still refuses the
    // whitespace itself, and comparison further down never trims.
    if (surface.id.trim().length === 0) {
      throw new Error(
        `surfaces[${index}].id must be a non-empty string. ` +
          `usabl tracks coverage by surface id, so a blank id cannot name a screen.`,
      );
    }
    assertIdGrammar(surface.id, index);

    const firstIndex = firstIndexById.get(surface.id);
    if (firstIndex !== undefined) {
      throw new Error(
        `surfaces[${index}].id "${forMessage(surface.id)}" repeats surfaces[${firstIndex}].id. ` +
          `Every surface id must be unique, because usabl tracks coverage by surface id and a ` +
          `repeated id hides one of the two screens from the scan. Give one of them a different id.`,
      );
    }
    firstIndexById.set(surface.id, index);
  });
}

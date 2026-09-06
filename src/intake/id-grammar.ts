/**
 * The one character grammar for every operator-authored id.
 *
 * Surface ids, screen ids, and requirement ids are all compared exactly, because exact is the
 * comparison every consumer downstream already makes: the planner's affected-screen map, the
 * evidence floor, the receipt, and waiver matching all key on the id as written. A rule that
 * folded ids together for validation but not for lookup would refuse pairs that actually work
 * while passing pairs that actually collide. So the grammar, not the comparison, is what removes
 * ids that cannot be told apart on sight. Every id field uses this grammar so two fields in one
 * product cannot drift into two different rules about what an id may contain.
 *
 * This unit validates text only. It must never rewrite an id, compare two ids for a caller, or
 * decide what happens when an id is refused.
 */

// Characters an id may not contain.
//
// \s covers the space characters that render as a gap, including U+00A0 and U+3000. Cc and Cf
// cover controls and format characters, which is where the zero-width characters and the bidi
// overrides live. Cs and Co are lone surrogates and private use, which have no agreed rendering.
// Default_Ignorable_Code_Point covers the rest of what a conforming renderer is expected to draw
// as nothing: the variation selectors, the Hangul fillers, the combining grapheme joiner, and the
// reserved ranges Unicode has set aside for more of the same. It is a maintained Unicode property
// rather than a hand-picked list that goes stale.
//
// U+2800, the empty braille pattern, is listed by hand. It is an assigned symbol (category So),
// it is not default-ignorable, and it renders as blank space, so none of the properties above
// catch it. The other assigned characters that render as blank were each probed against this
// Node build's Unicode tables and are already Default_Ignorable_Code_Point, so they need no entry
// of their own: U+115F and U+1160 (Hangul choseong and jungseong fillers), U+17B4 and U+17B5
// (Khmer inherent vowels), U+3164 (Hangul filler), and U+FFA0 (halfwidth Hangul filler). If a
// future probe finds one of them outside the property, add it beside U+2800.
//
// Unassigned code points (category Cn) are accepted on purpose. Which code points are unassigned
// changes with every Unicode release, and Node carries whichever tables its ICU was built with,
// so rejecting them would make an id valid on one Node build and refused on another. Unassigned
// is not a promise in either direction though: the reserved ranges Unicode marks
// default-ignorable, such as U+2065 and U+FFF0, are rejected by that property, while U+0378 and
// U+05FF are accepted.
//
// What this does NOT deliver, stated plainly so the rule is not read as more than it is. It does
// not stop confusables across scripts, so Latin "a" and Cyrillic "a" are both accepted and remain
// distinct ids. That is a deliberate limit: both are scanned, both appear in receipt coverage,
// and waiver matching is exact, so no screen or requirement is lost by it. The claim here is
// narrow, and it is only this: an accepted id renders as something.
const DISALLOWED_ID_CHARACTER = /[\s\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Default_Ignorable_Code_Point}\u2800]/u;

/**
 * Why an id was refused, or that it was not.
 *
 * `index` counts code points from zero, not UTF-16 units, so it matches what a person counting
 * characters in the file would reach. `codePoint` is the numeric value; use `codePointLabel` to
 * print it. The character itself is never returned as text, because every character the grammar
 * rejects is either invisible or reorders its neighbours, so printing it back would show the
 * operator nothing, or would show them something other than what the file holds.
 */
export type IdGrammarResult =
  | { ok: true }
  | { ok: false; problem: 'empty' }
  | { ok: false; problem: 'disallowed-character'; index: number; codePoint: number }
  | { ok: false; problem: 'not-nfc' };

/**
 * Formats a code point the way a config file can be searched for it, for example U+200B.
 */
export function codePointLabel(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Checks one id against the grammar and returns the first problem found.
 *
 * Order matters and is fixed: emptiness first, then the first disallowed character, then NFC.
 * An id with a disallowed character is reported for that character even if it is also not in
 * NFC form, because the character is the more specific thing to fix and the NFC check is only
 * meaningful once every character in the id is one that renders.
 */
export function validateId(id: string): IdGrammarResult {
  if (id.length === 0) {
    return { ok: false, problem: 'empty' };
  }

  let index = 0;
  for (const character of id) {
    if (DISALLOWED_ID_CHARACTER.test(character)) {
      return { ok: false, problem: 'disallowed-character', index, codePoint: character.codePointAt(0) ?? 0 };
    }
    index += 1;
  }

  // Canonically equivalent spellings are the same text by definition, so they render identically
  // while comparing unequal. Requiring one spelling keeps exact comparison honest for them
  // without folding anything at lookup time.
  if (id !== id.normalize('NFC')) {
    return { ok: false, problem: 'not-nfc' };
  }

  return { ok: true };
}

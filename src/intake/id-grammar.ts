/**
 * The one character grammar for every operator-authored id.
 *
 * Surface ids, screen ids, and requirement ids are all compared exactly, because exact is the
 * comparison every consumer downstream already makes: the planner's affected-screen map, the
 * evidence floor, the receipt, and waiver matching all key on the id as written. A rule that
 * folded ids together for validation but not for lookup would refuse pairs that actually work
 * while passing pairs that actually collide. So the grammar, not the comparison, is what removes
 * ids that cannot be told apart on sight. Every id field on the command path uses this grammar so
 * two fields in one product cannot drift into two different rules about what an id may contain.
 *
 * Where the grammar is checked, stated exactly. It governs every operator-authored and derived id
 * on the `usabl` command path: surface ids, sidecar route screen ids, screen ids the router
 * fallback derives, docs page ids, requirement ids and the surface a requirement names, the keys
 * of `noiseBudget.perSurface`, and every id that app init and docs init derive. It is not checked
 * again downstream. Ids already present
 * in the evidence floor and in waiver files, and inputs passed directly to the exported library
 * functions, are not re-validated; on the command path they were minted from or matched against
 * ids that had already passed here at parse, and a library caller that builds those inputs itself
 * bypasses that parse. That includes the `UsablConfig` handed to `mintReceipt()`: the command path
 * parses it first, but the function accepts any structurally valid config and does not parse one
 * itself, so a library caller can hand it a surface id or a per-surface budget key the grammar
 * would refuse.
 *
 * The contract, stated exactly. The grammar refuses whitespace, control and format characters,
 * surrogates, private use, default-ignorable characters, and the known assigned blank glyphs, and
 * it requires one canonical spelling (NFC). It accepts everything else, including unassigned code
 * points, standalone combining marks, visible right-to-left letters, and cross-script confusables.
 * It does not claim that an accepted id never reorders text: right-to-left letters reorder the run
 * they sit in without any control character, and accepting them is a product choice, because
 * Hebrew and Arabic ids are real ids. It does not claim that every accepted character has a glyph
 * in every font. What it does claim is this: two accepted ids that compare unequal are spelled
 * differently, and no accepted character is one that Unicode defines as whitespace, a control, a
 * format, or default-ignorable.
 *
 * This unit validates text and describes the failure. It must never rewrite an id, compare two
 * ids for a caller, or decide what happens when an id is refused.
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
// Four assigned characters that render as blank are listed by hand, because no property above
// catches them. Each was probed against this Node build's Unicode tables (Unicode 17.0):
//   U+2800  BRAILLE PATTERN BLANK             So, not default-ignorable
//   U+13441 EGYPTIAN HIEROGLYPH FULL BLANK    Lo, not default-ignorable
//   U+13442 EGYPTIAN HIEROGLYPH HALF BLANK    Lo, not default-ignorable
//   U+16FE4 KHITAN SMALL SCRIPT FILLER        Mn, not default-ignorable
// The other assigned blanks probed are already Default_Ignorable_Code_Point and need no entry:
// U+115F and U+1160 (Hangul choseong and jungseong fillers), U+17B4 and U+17B5 (Khmer inherent
// vowels), U+3164 (Hangul filler), and U+FFA0 (halfwidth Hangul filler). The tests hold each of
// these ten to being refused, so a Node build that moves one out of the property is noticed.
//
// The grammar refuses only what is invisible or is an explicit formatting control. It does not
// refuse visible right-to-left letters, which reorder the run around them without any control
// character; that is an accepted product choice, since Hebrew and Arabic ids are real ids. It does
// not refuse a standalone combining mark, which is drawn on whatever precedes it.
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
// distinct ids. That is a deliberate limit. What it costs is nothing structural: the two never
// fold into one entry, each is scanned when a change affects it, and waiver matching is exact, so
// neither screen or requirement is hidden behind the other. What it does not do is stop a reader
// from mistaking one for the other. The claim here is narrow: the grammar refuses what is listed
// above and accepts everything else.
const DISALLOWED_ID_CHARACTER =
  /[\s\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Default_Ignorable_Code_Point}\u2800\u{13441}\u{13442}\u{16fe4}]/u;

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

/** The refusing half of `IdGrammarResult`, for callers that keep a refusal to report later. */
export type IdGrammarRefusal = Exclude<IdGrammarResult, { ok: true }>;

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

/**
 * Describes why an id was refused in the words a config message carries, or returns null when
 * the id is accepted. Every id field in the product uses this text after its own field label, so
 * a refused id reads the same way wherever it was written.
 *
 * The text never contains the id. A refused character is named by position and code point,
 * because it is invisible or a formatting control, so printing it back would show the operator
 * nothing or would show them something other than what the file holds. The position counts
 * characters from one, which is how a person reading the file counts.
 */
export function describeIdProblem(id: string): string | null {
  const result = validateId(id);
  return result.ok ? null : describeIdRefusal(result);
}

/**
 * The words for one refusal, for a caller that validated earlier and kept the result. Same text
 * as `describeIdProblem`, same no-echo rule: a refused character is named by position and code
 * point; an id that is empty or not in NFC form has no single character to name, so those two
 * are described by the rule they broke.
 */
export function describeIdRefusal(result: IdGrammarRefusal): string {
  switch (result.problem) {
    case 'empty':
      return 'must be a non-empty string. A blank id cannot name anything.';
    case 'disallowed-character':
      return (
        `contains a character that is not allowed, at position ${result.index + 1}: ` +
        `${codePointLabel(result.codePoint)}. An id must not contain whitespace, invisible ` +
        'characters, or formatting controls, because ids are compared exactly and a character ' +
        'that renders as nothing cannot be told from its absence. Use visible characters with no ' +
        'spaces, for example "user-settings".'
      );
    case 'not-nfc':
      return (
        'must be written in Unicode NFC form. Two canonically equivalent spellings look identical ' +
        'but compare as different ids.'
      );
  }
}

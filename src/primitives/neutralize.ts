/**
 * Terminal egress neutralizer for untrusted finding text.
 * It strips control bytes, control sequences, and the characters that reorder how text renders.
 * It must never decide verdicts, sanitize HTML, or alter identity keys.
 *
 * What it removes is deliberately narrow. usabl reports on the text that is actually on a page,
 * including accessible names, so rewriting that text would make every surface misrepresent the
 * evidence. Only characters that make a display lie are removed. Characters that merely have no
 * glyph are kept, because plenty of them carry meaning: tag characters spell the region in a flag
 * emoji, variation selectors choose how a glyph is drawn, invisible operators are real notation in
 * mathematics, and joiners build words in Persian, Arabic, and Indic scripts. Removing a character
 * because a reader cannot see it would corrupt all of that.
 *
 * The characters kept here are invisible, so any of them can be planted inside a literal that a
 * later stage matches on. Defending a literal is that literal's own job, and the untrusted-text
 * frame in the surface scrubber does it by matching through invisible characters rather than by
 * having them deleted here first.
 */

/**
 * True for a Unicode bidirectional control.
 *
 * These are the twelve characters of the Bidi_Control property: the direction marks, the
 * embeddings and overrides, the isolates, and the Arabic letter mark. They tell a renderer to draw
 * the characters around them in a different order than they are stored, so page text can use them
 * to make usabl print a finding that reads as the opposite of the finding usabl reached. Nothing
 * about the stored bytes looks wrong, which is what makes them worth removing rather than keeping.
 *
 * Letters that have a direction of their own, Hebrew and Arabic script, are untouched. They render
 * right to left without any control character, so real right-to-left text survives this pass.
 */
function isBidiControl(code: number): boolean {
  return (
    code === 0x061c || // Arabic letter mark
    code === 0x200e || // left-to-right mark
    code === 0x200f || // right-to-left mark
    (code >= 0x202a && code <= 0x202e) || // embeddings, overrides, and pop
    (code >= 0x2066 && code <= 0x2069) // isolates and pop
  );
}

/**
 * Where the control sequence starting at an escape byte ends, exclusive.
 * An unterminated sequence runs to the end of the text, because a terminal would swallow the rest.
 */
function endOfEscapeSequence(text: string, start: number): number {
  const next = text.charCodeAt(start + 1);

  if (next === 0x5b) {
    let cursor = start + 2;
    while (cursor < text.length) {
      const byte = text.charCodeAt(cursor);
      cursor += 1;
      if (byte >= 0x40 && byte <= 0x7e) {
        return cursor;
      }
    }
    return text.length;
  }

  if (next === 0x5d) {
    let cursor = start + 2;
    while (cursor < text.length) {
      const byte = text.charCodeAt(cursor);
      if (byte === 0x07) {
        return cursor + 1;
      }
      if (byte === 0x1b && text.charCodeAt(cursor + 1) === 0x5c) {
        return cursor + 2;
      }
      cursor += 1;
    }
    return text.length;
  }

  let cursor = start + 1;
  while (cursor < text.length) {
    const byte = text.charCodeAt(cursor);
    if (byte >= 0x20 && byte <= 0x2f) {
      cursor += 1;
      continue;
    }
    break;
  }
  if (cursor >= text.length) {
    return text.length;
  }
  if (text.charCodeAt(cursor) >= 0x30 && text.charCodeAt(cursor) <= 0x7e) {
    return cursor + 1;
  }

  // A lone escape byte with nothing that completes a sequence after it.
  return start + 1;
}

export function neutralize(text: string): string {
  if (text.length === 0) {
    return '';
  }

  // Kept text is copied in runs rather than one character at a time, and text with nothing to
  // remove, which is nearly all of it, is returned as it arrived. A per-character copy allocates
  // many times the size of the input for a long string, and page text can be long.
  let out = '';
  let copied = 0;
  let removedAnything = false;
  let i = 0;

  // One forward scan avoids chaining replaces that could leave second-order sequences.
  while (i < text.length) {
    const code = text.charCodeAt(i);
    let removeUntil = -1;

    if (code === 0x1b) {
      removeUntil = endOfEscapeSequence(text, i);
    }

    // U+007F is the last C0 control and sits outside the 0x00 to 0x1f block. U+2028 and U+2029 are
    // not C0 or C1 controls at all, but terminals render them as line breaks, so page-derived text
    // could forge extra CLI lines at this egress. Bidi controls are removed for the reason above.
    //
    // All of these are dropped, not replaced with a notice. None of them has a glyph, so dropping
    // one takes nothing away that the reader could have seen, and a notice per character would let
    // page text pad usabl's own output at will.
    //
    // The escape byte is itself a C0 control, so this runs only when the branch above did not
    // already claim a whole sequence. Otherwise a sequence would lose its escape byte and print
    // the rest of itself.
    if (
      removeUntil === -1 &&
      ((code >= 0x00 && code <= 0x1f) ||
        code === 0x7f ||
        (code >= 0x80 && code <= 0x9f) ||
        code === 0x2028 ||
        code === 0x2029 ||
        isBidiControl(code))
    ) {
      removeUntil = i + 1;
    }

    if (removeUntil === -1) {
      i += 1;
      continue;
    }

    out += text.slice(copied, i);
    copied = removeUntil;
    removedAnything = true;
    i = removeUntil;
  }

  return removedAnything ? out + text.slice(copied) : text;
}

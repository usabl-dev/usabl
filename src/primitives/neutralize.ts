/**
 * Terminal egress neutralizer for untrusted finding text.
 * It strips control bytes, control sequences, and the characters that reorder how text renders,
 * and it turns the control characters that separate words into a space.
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
 * Removing them is a real trade, not a free win, and it should not be read as one. Letters that
 * have a direction of their own, Hebrew and Arabic script, need no control character and are
 * untouched, so ordinary right-to-left text is unaffected. Mixed-direction text is a different
 * case: Unicode recommends the isolates for exactly that, to keep a number, a bracket, or an
 * embedded Latin phrase from being drawn in the wrong place inside a right-to-left sentence. Page
 * text that used them correctly can therefore come out looking wrong in usabl's own surfaces. That
 * is accepted here because the alternative is worse: the same characters let a page make a finding
 * render as the opposite of what usabl found, and a verdict that cannot be trusted to say what it
 * means is a deeper failure than a mixed-direction label that reads awkwardly.
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
 * True for a control character that separates words rather than commanding a terminal.
 *
 * A tab, a line break, or a Unicode separator inside an accessible name is real text: it is where
 * a label wraps. Deleting it welds the words on either side into one, so "Save" and "button" on
 * two lines get reported as "Savebutton", which is not the name the page has. Each of these
 * becomes a space instead, so the reported name still says two words.
 */
function isSeparatorControl(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) || // tab, line feed, vertical tab, form feed, carriage return
    code === 0x85 || // next line
    code === 0x2028 || // line separator
    code === 0x2029 // paragraph separator
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
  // remove, which is nearly all of it, is returned as it arrived and allocates nothing.
  //
  // That is the whole of the claim, and it is worth being exact about where it stops. Text with
  // removals scattered through it still builds its result in pieces, one per run, and costs
  // several times the size of the input: four million characters alternating between a letter and
  // a control byte measured 61 to 64 MiB of heap across runs, against 4 MiB for the same length
  // of clean text. The saving is on text that is mostly or entirely clean, which is what real
  // page text is.
  let out = '';
  let copied = 0;
  let removedAnything = false;
  let i = 0;

  // One forward scan avoids chaining replaces that could leave second-order sequences.
  while (i < text.length) {
    const code = text.charCodeAt(i);
    let removeUntil = -1;
    let standsIn = '';

    if (code === 0x1b) {
      removeUntil = endOfEscapeSequence(text, i);
    }

    // A whole run of separators becomes one space, not one space each. A line break written as
    // carriage return and line feed is one break, and a label indented onto the next line is one
    // gap between words, so spacing them out would be its own distortion of the name.
    if (removeUntil === -1 && isSeparatorControl(code)) {
      let end = i + 1;
      while (end < text.length && isSeparatorControl(text.charCodeAt(end))) {
        end += 1;
      }
      removeUntil = end;
      standsIn = ' ';
    }

    // U+007F is the last C0 control and sits outside the 0x00 to 0x1f block. Bidi controls are
    // removed for the reason given above them.
    //
    // These leave nothing behind, and no notice either. None of them has a glyph, so dropping one
    // takes nothing away that the reader could have seen, and a notice per character would let
    // page text pad usabl's own output at will.
    //
    // The escape byte is itself a C0 control, so this runs only when the branches above did not
    // already claim a span. Otherwise a sequence would lose its escape byte and print the rest of
    // itself, and a line break would be deleted rather than kept as a space.
    if (
      removeUntil === -1 &&
      ((code >= 0x00 && code <= 0x1f) ||
        code === 0x7f ||
        (code >= 0x80 && code <= 0x9f) ||
        isBidiControl(code))
    ) {
      removeUntil = i + 1;
    }

    if (removeUntil === -1) {
      i += 1;
      continue;
    }

    out += text.slice(copied, i) + standsIn;
    copied = removeUntil;
    removedAnything = true;
    i = removeUntil;
  }

  return removedAnything ? out + text.slice(copied) : text;
}

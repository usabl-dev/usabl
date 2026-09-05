/**
 * Terminal egress neutralizer for untrusted finding text.
 * It strips control bytes, control sequences, and invisible formatting characters before CLI output.
 * It must never decide verdicts, sanitize HTML, or alter identity keys.
 */

/**
 * The formatting characters a reader never sees but that change what the text looks like or hide
 * content inside it. Ranges are inclusive code points.
 *
 * Two groups are covered. The bidirectional controls, the embeddings, overrides, isolates, and
 * direction marks, tell a renderer to draw characters in a different order than they are stored.
 * Page text can use them to make usabl print a verdict that reads as the opposite of the verdict
 * usabl reached, which is the defect this guard exists to close. The rest have no glyph at all,
 * so they can pad a string, hide characters inside it, or split a literal that a later stage
 * matches on, with nothing visible to warn the reader.
 *
 * The joiners U+200C and U+200D are deliberately absent. They carry meaning in Persian, Arabic,
 * and Indic text, and they bind emoji sequences into one glyph, so removing them would mangle
 * legitimate content. Letters that have a direction of their own, Hebrew and Arabic script, are
 * untouched: they render right to left without any control character, so right-to-left text
 * survives this pass unchanged.
 *
 * This list is exported because the untrusted-text frame in the surface scrubber has to recognise
 * a marker that page text split with one of these characters. Both places work from this one list,
 * so what one removes and what the other tolerates cannot drift apart.
 */
export const INVISIBLE_FORMAT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad], // soft hyphen
  [0x061c, 0x061c], // Arabic letter mark
  [0x200b, 0x200b], // zero width space
  [0x200e, 0x200f], // left-to-right and right-to-left marks
  [0x202a, 0x202e], // bidi embeddings, overrides, and pop
  [0x2060, 0x2064], // word joiner and invisible operators
  [0x2066, 0x206f], // bidi isolates and deprecated format characters
  [0xfeff, 0xfeff], // zero width no-break space, the byte order mark
  [0xfff9, 0xfffb], // interlinear annotation
  [0xe0000, 0xe007f], // tag characters, an invisible copy of ASCII
];

/**
 * True for a code point in the list above.
 *
 * The scan below reads one UTF-16 code unit at a time, and a single code unit can never reach the
 * tag range, so that last entry is inert here. The surrogate pair check does that work instead.
 */
function isInvisibleFormat(code: number): boolean {
  for (const [first, last] of INVISIBLE_FORMAT_RANGES) {
    if (code >= first && code <= last) {
      return true;
    }
  }
  return false;
}

/**
 * True for the two code units of a tag character, U+E0000 to U+E007F.
 *
 * These are an invisible copy of ASCII. A string spelled in them reaches anything that reads the
 * bytes while a person sees nothing, so they are removed as a pair to keep the scan on a character
 * boundary. Every other astral character passes through, since only this block is invisible.
 */
function isTagPair(high: number, low: number): boolean {
  return high === 0xdb40 && low >= 0xdc00 && low <= 0xdc7f;
}

export function neutralize(text: string): string {
  if (text.length === 0) {
    return '';
  }

  let safe = '';
  let i = 0;

  // One forward scan avoids chaining replaces that could leave second-order sequences.
  while (i < text.length) {
    const code = text.charCodeAt(i);

    if (code === 0x1b) {
      const next = text.charCodeAt(i + 1);

      if (next === 0x5b) {
        i += 2;
        while (i < text.length) {
          const byte = text.charCodeAt(i);
          i += 1;
          if (byte >= 0x40 && byte <= 0x7e) {
            break;
          }
        }
        continue;
      }

      if (next === 0x5d) {
        i += 2;
        while (i < text.length) {
          const byte = text.charCodeAt(i);
          if (byte === 0x07) {
            i += 1;
            break;
          }
          if (byte === 0x1b && text.charCodeAt(i + 1) === 0x5c) {
            i += 2;
            break;
          }
          i += 1;
        }
        continue;
      }

      let cursor = i + 1;
      while (cursor < text.length) {
        const byte = text.charCodeAt(cursor);
        if (byte >= 0x20 && byte <= 0x2f) {
          cursor += 1;
          continue;
        }
        break;
      }
      if (cursor >= text.length) {
        i = text.length;
        continue;
      }
      if (text.charCodeAt(cursor) >= 0x30 && text.charCodeAt(cursor) <= 0x7e) {
        i = cursor + 1;
        continue;
      }

      i += 1;
      continue;
    }

    // U+2028 and U+2029 are not C0 or C1 controls, but terminals render them as line breaks.
    // Strip them here so page-derived text cannot forge extra CLI lines at this egress.
    if (
      (code >= 0x00 && code <= 0x1f) ||
      (code >= 0x80 && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029
    ) {
      i += 1;
      continue;
    }

    // Invisible formatting characters are dropped, not replaced with a notice. Everything this
    // function removes is removed silently, and none of these characters has a glyph, so dropping
    // one takes nothing away that the reader could have seen. Marking them would also let page
    // text pad usabl's own output at will, one notice per planted character.
    if (isInvisibleFormat(code)) {
      i += 1;
      continue;
    }

    if (isTagPair(code, text.charCodeAt(i + 1))) {
      i += 2;
      continue;
    }

    safe += text[i];
    i += 1;
  }

  return safe;
}

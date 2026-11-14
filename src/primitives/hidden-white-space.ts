/**
 * White space a person cannot tell apart on screen, for the design checks only.
 *
 * A name on the page that differs from the design only in such a character, such as "Refresh"
 * followed by a no-break space, looks the same to a person. A bare "there is no button named
 * Refresh" for it is a failure nobody can understand. Every design check that looks a name up uses
 * this one list to find such a near match and ask for review, naming the character. It never makes
 * a name match: names are still compared with collapseWhiteSpace, the browser's own rule.
 */

/**
 * Each character, with the words a sentence uses for it. It holds every character the JavaScript
 * \s class matches, plus the zero width space (U+200B) and the word joiner (U+2060), which \s does
 * not match and which a person cannot see either. A test holds that no \s character is missing.
 */
export const HIDDEN_WHITE_SPACE: ReadonlyMap<string, string> = new Map([
  ['\t', 'a tab'],
  ['\n', 'a line break'],
  ['\v', 'a vertical tab'],
  ['\f', 'a form feed'],
  ['\r', 'a carriage return'],
  [' ', 'a space'],
  [' ', 'a no-break space'],
  [' ', 'an Ogham space mark'],
  [' ', 'an en quad'],
  [' ', 'an em quad'],
  [' ', 'an en space'],
  [' ', 'an em space'],
  [' ', 'a three-per-em space'],
  [' ', 'a four-per-em space'],
  [' ', 'a six-per-em space'],
  [' ', 'a figure space'],
  [' ', 'a punctuation space'],
  [' ', 'a thin space'],
  [' ', 'a hair space'],
  ['​', 'a zero width space'],
  [' ', 'a line separator'],
  [' ', 'a paragraph separator'],
  [' ', 'a narrow no-break space'],
  [' ', 'a medium mathematical space'],
  ['⁠', 'a word joiner'],
  ['　', 'an ideographic space'],
  ['﻿', 'a zero width no-break space'],
]);

// The characters that take no width. Between two letters they join them, so a loose name drops
// them, where any other one reads as a space.
const ZERO_WIDTH = new Set(['​', '⁠', '﻿']);

function isHidden(character: string): boolean {
  return HIDDEN_WHITE_SPACE.has(character);
}

/**
 * A name with each zero width character removed, every other run of hidden white space read as one
 * space, and none at either end. Used only to find a near match, never to decide a match.
 */
export function looseName(name: string): string {
  let out = '';
  let pendingSpace = false;
  for (const character of name) {
    if (ZERO_WIDTH.has(character)) continue;
    if (isHidden(character)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && out !== '') out += ' ';
    pendingSpace = false;
    out += character;
  }
  return out;
}

// The name cut into runs of hidden white space and runs of other text, in order.
function runs(name: string): Array<{ hidden: boolean; text: string }> {
  const out: Array<{ hidden: boolean; text: string }> = [];
  for (const character of name) {
    const hidden = isHidden(character);
    const last = out[out.length - 1];
    if (last !== undefined && last.hidden === hidden) {
      last.text += character;
    } else {
      out.push({ hidden, text: character });
    }
  }
  return out;
}

/**
 * A name written out so a person can see where hidden white space sits, for example '"Refresh"
 * followed by a no-break space'. A run of plain spaces between words stays inside the quotes. In a
 * run that holds any other hidden character, each character is named, plain spaces included.
 */
export function spelledName(name: string): string {
  const parts: string[] = [];
  let text = '';
  for (const run of runs(name)) {
    if (run.hidden && !/^ +$/u.test(run.text)) {
      if (text !== '') {
        parts.push(`"${text}"`);
        text = '';
      }
      parts.push(...Array.from(run.text, (character) => HIDDEN_WHITE_SPACE.get(character) ?? ''));
    } else {
      text += run.text;
    }
  }
  if (text !== '' || parts.length === 0) {
    parts.push(`"${text}"`);
  }
  if (parts.length === 1) {
    return parts[0] ?? '';
  }
  if (parts.length === 2) {
    return `${parts[0] ?? ''} followed by ${parts[1] ?? ''}`;
  }
  return `${parts.slice(0, -1).join(', ')}, then ${parts[parts.length - 1] ?? ''}`;
}

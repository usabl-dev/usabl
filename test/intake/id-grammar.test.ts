import { describe, expect, it } from 'vitest';
import { codePointLabel, validateId } from '../../src/intake/id-grammar.js';
import { screenIdFromUrl } from '../../src/coverage/router-parse.js';

const charFor = (point: string) => String.fromCodePoint(Number.parseInt(point.slice(2), 16));

function refusedCharacter(id: string): { index: number; codePoint: number } {
  const result = validateId(id);
  expect(result.ok).toBe(false);
  if (result.ok || result.problem !== 'disallowed-character') {
    throw new Error(`expected a disallowed character, got ${JSON.stringify(result)}`);
  }
  return { index: result.index, codePoint: result.codePoint };
}

describe('validateId', () => {
  it('accepts an ordinary id', () => {
    expect(validateId('user-settings')).toEqual({ ok: true });
  });

  it('refuses the empty id', () => {
    expect(validateId('')).toEqual({ ok: false, problem: 'empty' });
  });

  // One example per class the grammar names. Each is refused by exactly the rule listed, so a
  // class silently dropping out of the regex fails the test for that class.
  it.each([
    ['whitespace (\\s)', 'U+0020'],
    ['whitespace beyond ASCII (\\s)', 'U+3000'],
    ['a control character (Cc)', 'U+001B'],
    ['a format character (Cf)', 'U+200B'],
    ['a bidi override (Cf)', 'U+202E'],
    ['a lone surrogate (Cs)', 'U+D800'],
    ['a private-use code point (Co)', 'U+E000'],
    ['a default-ignorable that is not Cf (combining grapheme joiner)', 'U+034F'],
    ['a default-ignorable reserved code point', 'U+2065'],
  ])('refuses %s and reports its code point', (_label, point) => {
    const { codePoint } = refusedCharacter(`settings${charFor(point)}`);
    expect(codePointLabel(codePoint)).toBe(point);
  });

  // Assigned characters that render as blank space. U+2800 is the one no Unicode property
  // catches, so it is listed by hand in the grammar. The rest are Default_Ignorable_Code_Point
  // on the Node build this was written against; this test is what notices if one of them is not.
  it.each([
    ['the empty braille pattern', 'U+2800'],
    ['the Hangul choseong filler', 'U+115F'],
    ['the Hangul jungseong filler', 'U+1160'],
    ['the Khmer inherent vowel aq', 'U+17B4'],
    ['the Khmer inherent vowel aa', 'U+17B5'],
    ['the Hangul filler', 'U+3164'],
    ['the halfwidth Hangul filler', 'U+FFA0'],
  ])('refuses %s, which renders as blank', (_label, point) => {
    const { codePoint } = refusedCharacter(`settings${charFor(point)}`);
    expect(codePointLabel(codePoint)).toBe(point);
  });

  it('accepts an unassigned code point that no property marks as ignorable', () => {
    // Which code points are unassigned changes between Unicode releases, so refusing them would
    // tie an id's validity to the Node build. U+0378 is reserved and not default-ignorable.
    expect(/\p{Cn}/u.test(charFor('U+0378'))).toBe(true);
    expect(validateId(`screen${charFor('U+0378')}`)).toEqual({ ok: true });
  });

  it('refuses an id that is not in NFC form and accepts its NFC form', () => {
    const decomposed = 'cafe\u0301';
    const composed = decomposed.normalize('NFC');
    expect(composed).not.toBe(decomposed);
    expect(validateId(decomposed)).toEqual({ ok: false, problem: 'not-nfc' });
    expect(validateId(composed)).toEqual({ ok: true });
  });

  it('accepts both halves of a cross-script confusable pair, a documented limit', () => {
    // Latin "a" and Cyrillic "a" look alike. Both are accepted and remain distinct ids; the
    // grammar does not claim to stop this.
    expect(validateId('varia')).toEqual({ ok: true });
    expect(validateId('vari\u0430')).toEqual({ ok: true });
  });

  it('accepts the id usabl init derives from a parameter route', () => {
    const id = screenIdFromUrl('/users/:id');
    expect(id).toBe('users-:id');
    expect(validateId(id)).toEqual({ ok: true });
  });

  it('reports the index of the offending character, counted in code points from zero', () => {
    expect(refusedCharacter('ab\u2800c')).toEqual({ index: 2, codePoint: 0x2800 });
    // An astral character before the fault counts as one character, not two UTF-16 units.
    expect(refusedCharacter('\u{1F468}x\u200dy')).toEqual({ index: 2, codePoint: 0x200d });
  });

  it('reports the first disallowed character when there are several', () => {
    expect(refusedCharacter('a\u200bb\u2800c')).toEqual({ index: 1, codePoint: 0x200b });
  });

  it('reports a disallowed character before a missing NFC form', () => {
    expect(validateId('cafe\u0301\u200b')).toMatchObject({ problem: 'disallowed-character', index: 5 });
  });
});

describe('codePointLabel', () => {
  it('pads to four hex digits and grows past them for astral code points', () => {
    expect(codePointLabel(0x1b)).toBe('U+001B');
    expect(codePointLabel(0x2800)).toBe('U+2800');
    expect(codePointLabel(0xe0100)).toBe('U+E0100');
  });
});

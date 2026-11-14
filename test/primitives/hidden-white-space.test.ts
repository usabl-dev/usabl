/**
 * The one list of white space characters a person cannot tell apart on screen, which every design
 * check uses to turn a bare "there is no" failure into needs review that names the character.
 */
import { describe, expect, it } from 'vitest';
import { HIDDEN_WHITE_SPACE, looseName, spelledName } from '../../src/primitives/hidden-white-space.js';

describe('the hidden white space list', () => {
  it('holds every character \\s matches, and the zero width space and word joiner', () => {
    const missing: string[] = [];
    for (let code = 0; code <= 0xffff; code += 1) {
      const character = String.fromCharCode(code);
      if (/\s/u.test(character) && !HIDDEN_WHITE_SPACE.has(character)) {
        missing.push(`U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
      }
    }
    expect(missing).toEqual([]);
    expect(HIDDEN_WHITE_SPACE.has('​')).toBe(true);
    expect(HIDDEN_WHITE_SPACE.has('⁠')).toBe(true);
  });

  it('gives every character a word a sentence can use', () => {
    for (const [character, word] of HIDDEN_WHITE_SPACE) {
      expect({ character, word }).toEqual({ character, word: expect.stringMatching(/^an? [A-Za-z]/u) });
    }
  });
});

describe('looseName', () => {
  it('reads each run of white space as one space and removes zero width characters', () => {
    expect(looseName(' Save　\tdraft ')).toBe('Save draft');
    expect(looseName('Re​fresh⁠')).toBe('Refresh');
    expect(looseName('Save​ draft')).toBe('Save draft');
  });
});

describe('spelledName', () => {
  it('names each hidden character where it is, and keeps a plain space inside the quotes', () => {
    expect(spelledName('Refresh ')).toBe('"Refresh" followed by a no-break space');
    expect(spelledName('Save⁠draft')).toBe('"Save", a word joiner, then "draft"');
    expect(spelledName('Save draft')).toBe('"Save draft"');
  });
});

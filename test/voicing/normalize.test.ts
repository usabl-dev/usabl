import { describe, expect, it } from 'vitest';
import { normalizeToken, obligationSatisfied } from '../../src/voicing/normalize.js';

describe('normalizeToken', () => {
  it('normalizes punctuation and case for matching', () => {
    expect(normalizeToken('Save Changes!')).toBe('save changes');
  });

  it('collapses repeated whitespace and trims boundaries', () => {
    expect(normalizeToken('  Save   Changes  ')).toBe('save changes');
  });

  it('maps null to an empty token', () => {
    expect(normalizeToken(null)).toBe('');
  });

  it('keeps plain role text stable', () => {
    expect(normalizeToken('dialog')).toBe('dialog');
  });
});

describe('matching words in any script', () => {
  it('keeps letters, digits, and marks in every script', () => {
    expect(normalizeToken('削除')).toBe('削除');
    expect(normalizeToken('Ligne supprimée !')).toBe('ligne supprimée');
    expect(normalizeToken('हटाया गया')).toBe('हटाया गया');
  });

  it('matches a non-Latin token only when the announcement holds it', () => {
    expect(obligationSatisfied(['削除'], [{ text: '行を削除しました' }])).toBe(true);
    // A token that compared as empty used to be found in every announcement, so this passed on
    // words that never said it.
    expect(obligationSatisfied(['削除'], [{ text: '保存しました' }])).toBe(false);
  });
});

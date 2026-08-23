import { describe, expect, it } from 'vitest';
import { normalizeToken } from '../../src/voicing/normalize.js';

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

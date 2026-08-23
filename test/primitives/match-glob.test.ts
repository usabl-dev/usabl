import { describe, expect, it } from 'vitest';
import { matchGlob } from '../../src/primitives/match-glob.js';

describe('matchGlob', () => {
  it('matches src/**/*.tsx against src/App.tsx', () => {
    expect(matchGlob('src/**/*.tsx', 'src/App.tsx')).toBe(true);
  });
});

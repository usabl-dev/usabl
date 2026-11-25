/**
 * The time to match a glob grows with the pattern's length times the path's length, never faster.
 * A regular expression with many wildcards tries each way they can split a name, so a committed
 * glob and a long changed file name could run past the host's limit for a Stop hook, and no timer
 * in the same process can end a match that is running.
 */
import { describe, expect, it } from 'vitest';
import { globMatcher, matchGlob } from '../../src/primitives/match-glob.js';
import { compileCodeownersPattern } from '../../src/primitives/match-codeowners.js';
import { regexGlobMatcher } from '../support/glob-regex-reference.js';

// Twelve wildcards, as in the committed uiFileGlobs entry that made a stop take 81.7 seconds.
const MANY_WILDCARDS = `src/${'*a'.repeat(12)}*b`;
const LONG_NAME = `src/${'a'.repeat(38)}`;

function elapsedMs(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe('glob matching time', () => {
  it('matches twelve wildcards against a 38-letter name in well under a second', () => {
    for (const options of [{}, { dot: false }]) {
      let answer: boolean | undefined;
      const ms = elapsedMs(() => {
        answer = matchGlob(MANY_WILDCARDS, LONG_NAME, options);
      });
      expect(answer, JSON.stringify(options)).toBe(false);
      expect(ms, JSON.stringify(options)).toBeLessThan(250);
    }
  });

  it('gives the old answer for the same pattern where the old matcher finishes', () => {
    for (const options of [{}, { dot: false }]) {
      const matches = globMatcher(MANY_WILDCARDS, options);
      const old = regexGlobMatcher(MANY_WILDCARDS, options);
      for (const name of [`src/${'a'.repeat(12)}b`, `src/${'a'.repeat(14)}`, `src/${'a'.repeat(38)}b`, `src/${'ab'.repeat(13)}`]) {
        expect(matches(name), name).toBe(old(name));
      }
      expect(matches(`src/${'a'.repeat(38)}b`)).toBe(true);
    }
  });

  it('matches a long name against a long pattern in time that grows with their lengths only', () => {
    const pattern = `src/**/${'*x'.repeat(500)}*y`;
    const name = `src/${'d/'.repeat(500)}${'x'.repeat(2000)}`;
    for (const options of [{}, { dot: false }]) {
      let answer: boolean | undefined;
      const ms = elapsedMs(() => {
        answer = matchGlob(pattern, name, options);
      });
      expect(answer).toBe(false);
      expect(ms).toBeLessThan(1000);
    }
  });

  it('matches a CODEOWNERS pattern with many wildcards against a long name in well under a second', () => {
    const compiled = compileCodeownersPattern(`${'*a'.repeat(12)}*b`);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    let answer: string | undefined;
    const ms = elapsedMs(() => {
      answer = compiled.state(`src/${'a'.repeat(30)}/x.ts`);
    });
    expect(answer).toBe('none');
    expect(ms).toBeLessThan(250);
  });
});

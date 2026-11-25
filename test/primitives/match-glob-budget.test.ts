/**
 * The glob matching budget counts work in steps, never time, so the same input runs out at the
 * same place every time. Once it is spent, every match given it throws, and a normal run spends a
 * small part of it.
 */
import { describe, expect, it } from 'vitest';
import { GlobBudgetExhausted, GlobMatchBudget, globMatcher, RUN_GLOB_MATCH_STEPS } from '../../src/primitives/match-glob.js';

describe('GlobMatchBudget', () => {
  it('charges a match at most its pattern length times its path length, plus the quick checks', () => {
    const pattern = `${'*a'.repeat(50)}*b`;
    const file = `${'a'.repeat(200)}/b`;
    const budget = new GlobMatchBudget(Number.MAX_SAFE_INTEGER);
    globMatcher(pattern, { budget })(file);
    const spent = budget.steps - budget.remaining;
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThanOrEqual((pattern.length + 2) * (file.length + 1) + pattern.length);
  });

  it('runs out at the same file every time, and then every match throws', () => {
    const files = Array.from({ length: 40 }, (_, index) => `${'a/'.repeat(300)}${String(index)}`);
    const outcomes = [0, 1].map(() => {
      const budget = new GlobMatchBudget(2_000_000);
      const matches = globMatcher(`${'**a'.repeat(100)}b**`, { budget });
      const answered: boolean[] = [];
      let stoppedAt = -1;
      for (const [index, file] of files.entries()) {
        try {
          answered.push(matches(file));
        } catch (err) {
          expect(err).toBeInstanceOf(GlobBudgetExhausted);
          stoppedAt = index;
          break;
        }
      }
      expect(budget.exhausted).toBe(true);
      expect(() => matches('a')).toThrow(GlobBudgetExhausted);
      return { answered, stoppedAt };
    });
    expect(outcomes[0]?.stoppedAt).toBeGreaterThan(0);
    expect(outcomes[1]).toEqual(outcomes[0]);
  });

  it('charges the dot rule too', () => {
    const budget = new GlobMatchBudget(1000);
    const matches = globMatcher('**/*.tsx', { dot: false, budget });
    expect(() => {
      for (let i = 0; i < 1000; i += 1) matches(`src/${'a/'.repeat(50)}x.tsx`);
    }).toThrow(GlobBudgetExhausted);
  });

  it('leaves a normal run far inside the budget', () => {
    const budget = new GlobMatchBudget(RUN_GLOB_MATCH_STEPS);
    const matchers = ['src/**/*.{ts,tsx}', 'src/**/*.css', 'app/**/*.tsx', 'packages/*/src/**/*.tsx'].map((glob) => globMatcher(glob, { budget }));
    for (let i = 0; i < 20_000; i += 1) {
      const file = `src/components/area${String(i % 50)}/Widget${String(i)}.tsx`;
      matchers.some((matches) => matches(file));
    }
    expect(budget.steps - budget.remaining).toBeLessThan(RUN_GLOB_MATCH_STEPS / 20);
  });
});

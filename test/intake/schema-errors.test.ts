import { describe, expect, it, vi } from 'vitest';
import { parseBundle } from '../../src/intake/schema.js';

// The id check runs inside the schema parse. Here it throws for chosen ids, so each test can put
// one error inside the parse and see what parseBundle does with it.
vi.mock('../../src/intake/requirement-ids.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/intake/requirement-ids.js')>();
  return {
    ...original,
    describeRequirementIdProblem: (id: string) => {
      if (id === 'stack-overflow') throw new RangeError('Maximum call stack size exceeded');
      if (id === 'other-range-error') throw new RangeError('Invalid count value: -1');
      if (id === 'type-error') throw new TypeError('not a function');
      return original.describeRequirementIdProblem(id);
    },
  };
});

function bundleWithId(id: string): unknown {
  return {
    version: 1,
    requirements: [
      { id, kind: 'content', surface: 'home', description: 'd', assertion: { type: 'content', selector: 'h1' }, approved: true },
    ],
  };
}

describe('an error inside the requirement schema parse', () => {
  it('reads a stack overflow as too many problems to check', () => {
    expect(parseBundle(bundleWithId('stack-overflow'))).toEqual({
      ok: false,
      verdict: 'approval_required',
      reason: 'this file has too many problems to check, so it is refused; shorten or fix its longest list',
    });
  });

  // Any other error is a fault in usabl, not a fact about the file, so it is not named as one.
  it('throws any other RangeError on, unchanged', () => {
    expect(() => parseBundle(bundleWithId('other-range-error'))).toThrow(new RangeError('Invalid count value: -1'));
  });

  it('throws an error of another kind on, unchanged', () => {
    expect(() => parseBundle(bundleWithId('type-error'))).toThrow(new TypeError('not a function'));
  });

  it('still parses a file whose id check does not throw', () => {
    expect(parseBundle(bundleWithId('r1')).ok).toBe(true);
  });
});

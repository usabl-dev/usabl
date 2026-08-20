import { describe, it, expect } from 'vitest';
import { sortBy } from '../../src/primitives/sortKey.js';

describe('sortBy', () => {
  it('sorts by the string key using code-unit order', () => {
    const out = sortBy([{ k: 'b' }, { k: 'a' }, { k: 'c' }], (x) => x.k);
    expect(out.map((x) => x.k)).toEqual(['a', 'b', 'c']);
  });

  it('is stable for equal keys and does not mutate the input', () => {
    const input = [{ k: 'a', n: 1 }, { k: 'a', n: 2 }, { k: 'a', n: 3 }];
    const out = sortBy(input, (x) => x.k);
    expect(out.map((x) => x.n)).toEqual([1, 2, 3]);
    expect(input.map((x) => x.n)).toEqual([1, 2, 3]); // input untouched
  });
});

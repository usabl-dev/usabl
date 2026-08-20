import { describe, it, expect } from 'vitest';
import { canonicalize, sha256, canonicalHash } from '../../src/primitives/canonical.js';

describe('canonicalize', () => {
  it('sorts object keys and is insensitive to input key order', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it('recurses into nested objects and arrays (array order preserved)', () => {
    expect(canonicalize({ z: [{ y: 1, x: 2 }], a: null })).toBe('{"a":null,"z":[{"x":2,"y":1}]}');
  });

  it('drops undefined-valued keys like JSON does', () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('throws on non-finite numbers', () => {
    expect(() => canonicalize({ a: Number.NaN })).toThrow();
  });
});

describe('sha256 / canonicalHash', () => {
  it('hashes deterministically and independently of key order', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
  });
});

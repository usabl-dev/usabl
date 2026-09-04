import { describe, expect, it } from 'vitest';
import { parseEvidenceFloor } from '../../src/evidence/floor.js';

const entry = {
  screenId: 'clusters',
  layer: 'axe',
  rule: 'color-contrast',
  elementKey: 'clusters|color-contrast|name:save',
  identityBasis: 'name',
  count: 4,
};

describe('parseEvidenceFloor', () => {
  it('preserves version 1 so the gate knows the counts are untrustworthy', () => {
    expect(parseEvidenceFloor({ version: 1, entries: [entry] }).version).toBe(1);
  });

  it('preserves version 2 so the gate knows the counts are trustworthy', () => {
    expect(parseEvidenceFloor({ version: 2, entries: [entry] }).version).toBe(2);
  });

  it('rejects a version it cannot interpret', () => {
    expect(() => parseEvidenceFloor({ version: 3, entries: [] })).toThrow(/version/);
  });

  it('carries a partial scope through when present', () => {
    const parsed = parseEvidenceFloor({ version: 2, scope: 'partial', entries: [entry] });
    expect(parsed.scope).toBe('partial');
  });

  it('leaves scope undefined for a complete floor with no scope field', () => {
    const parsed = parseEvidenceFloor({ version: 2, entries: [entry] });
    expect(parsed.scope).toBeUndefined();
  });

  it('rejects a scope value other than partial', () => {
    expect(() => parseEvidenceFloor({ version: 2, scope: 'full', entries: [entry] })).toThrow(/scope/);
  });

  it('rejects a floor entry count that is not a finite non-negative safe integer', () => {
    // 9007199254740993 is past 2^53, so JSON.parse already rounded it to ...992 before it reached
    // here. isInteger would accept the rounded value; isSafeInteger rejects it so the gate never
    // compares against a tally that does not match the file.
    for (const count of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      1.5,
      '4',
      Number.MAX_SAFE_INTEGER + 1,
      9007199254740993,
    ]) {
      expect(() => parseEvidenceFloor({ version: 2, entries: [{ ...entry, count }] })).toThrow(/count/);
    }
  });

  it('accepts a zero count as a valid observed debt tally', () => {
    const parsed = parseEvidenceFloor({ version: 2, entries: [{ ...entry, count: 0 }] });
    expect(parsed.entries[0]?.count).toBe(0);
  });
});

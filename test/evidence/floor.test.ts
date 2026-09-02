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
});

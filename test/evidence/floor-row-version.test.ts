import { describe, expect, it } from 'vitest';
import { parseEvidenceFloor } from '../../src/evidence/floor.js';

const rowEntry = {
  screenId: 'jobs',
  layer: 'pf',
  rule: 'pf-icon-button-name',
  elementKey: 'jobs|pf-icon-button-name|row:["main>table","aaaaaaaaaaaaaaaa","button","td:nth-child(4) > button:nth-child(1)"]',
  identityBasis: 'row',
  count: 1,
};

describe('evidence floor version 3', () => {
  it('reads a version 3 floor and keeps its version, so the gate keys rows separately', () => {
    const parsed = parseEvidenceFloor({ version: 3, entries: [rowEntry] });
    expect(parsed.version).toBe(3);
    expect(parsed.entries[0]!.identityBasis).toBe('row');
  });

  it('refuses a row entry in a version 2 floor, because version 2 had no row keys', () => {
    expect(() => parseEvidenceFloor({ version: 2, entries: [rowEntry] })).toThrow(/row/);
    expect(() => parseEvidenceFloor({ version: 1, entries: [rowEntry] })).toThrow(/row/);
  });

  it('refuses a row entry with no element key', () => {
    expect(() => parseEvidenceFloor({ version: 3, entries: [{ ...rowEntry, elementKey: null }] })).toThrow(/elementKey/);
  });
});

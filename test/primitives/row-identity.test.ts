/**
 * Controls repeated per table row, such as an icon button or a kebab toggle in every row, used to
 * collapse onto one identity whose count followed how many rows the page showed. A barrier fixed in
 * one row and a new one in another row then left the count unchanged, and the new one read as
 * carried. A row-scoped key names the row and the control inside it, so two rows never share one.
 */
import { describe, expect, it } from 'vitest';
import type { Draft } from '../../src/contracts/index.js';
import { computeIdentity, identitySchemeFor } from '../../src/primitives/identity.js';

function rowDraft(row: string, over: Partial<Draft> = {}): Draft {
  return {
    rule: 'pf-icon-button-name', layer: 'pf', severity: 'serious', evidenceClass: 'deterministic',
    screenId: 'jobs', elementPath: `table > tbody > tr:nth-child(2) > td:nth-child(4) > button`,
    elementName: null, role: 'button', whatUserExperiences: '', why: '', fix: '',
    evidence: {
      extra: {
        rowScope: { table: 'main>table', row, role: 'button', path: 'td:nth-child(4) > button:nth-child(1)' },
      },
    },
    confidence: 'fail',
    ...over,
  };
}

describe('row-scoped identity', () => {
  it('keys an unnamed control in each row on its own, so two rows never collapse', () => {
    const a = computeIdentity(rowDraft('0123456789abcdef'));
    const b = computeIdentity(rowDraft('fedcba9876543210'));
    expect(a.identityBasis).toBe('row');
    expect(b.identityBasis).toBe('row');
    expect(a.elementKey).not.toBeNull();
    expect(a.elementKey).not.toBe(b.elementKey);
  });

  it('gives the same row the same key on another run', () => {
    expect(computeIdentity(rowDraft('0123456789abcdef')).elementKey).toBe(
      computeIdentity(rowDraft('0123456789abcdef', { elementPath: 'table > tbody > tr:nth-child(7) > td:nth-child(4) > button' })).elementKey,
    );
  });

  it('keys by row ahead of an accessible name every row repeats', () => {
    const named = (row: string): Draft =>
      rowDraft(row, {
        rule: 'pf-row-action-name-unique',
        evidence: {
          name: { value: 'Edit', source: 'ax-tree', fromTree: true },
          extra: { rowScope: { table: 'main>table', row, role: 'button', path: 'td:nth-child(5) > button:nth-child(1)' } },
        },
      });
    const a = computeIdentity(named('0123456789abcdef'));
    const b = computeIdentity(named('fedcba9876543210'));
    expect(a.identityBasis).toBe('row');
    expect(a.elementKey).not.toBe(b.elementKey);
  });

  it('keeps two controls in one row apart by where they sit in the row', () => {
    const first = computeIdentity(rowDraft('0123456789abcdef'));
    const second = computeIdentity(
      rowDraft('0123456789abcdef', {
        evidence: {
          extra: {
            rowScope: { table: 'main>table', row: '0123456789abcdef', role: 'button', path: 'td:nth-child(5) > button:nth-child(1)' },
          },
        },
      }),
    );
    expect(first.elementKey).not.toBe(second.elementKey);
  });

  it('ignores the row under the legacy scheme a version 2 floor was written with', () => {
    const legacy = computeIdentity(rowDraft('0123456789abcdef'), 'legacy');
    expect(legacy).toEqual({ elementKey: null, identityBasis: 'count' });
  });

  it('ignores a row scope that is not four strings, and falls back to the old key', () => {
    const broken = rowDraft('0123456789abcdef', {
      evidence: { extra: { rowScope: { table: 'main>table', row: 7, role: 'button', path: 'td' } } },
    });
    expect(computeIdentity(broken)).toEqual({ elementKey: null, identityBasis: 'count' });
    const emptyRow = rowDraft('', {});
    expect(computeIdentity(emptyRow)).toEqual({ elementKey: null, identityBasis: 'count' });
  });

  it('cannot be confused by a separator inside a field', () => {
    const a = computeIdentity(
      rowDraft('x', { evidence: { extra: { rowScope: { table: 't|row:', row: 'x', role: 'button', path: 'p' } } } }),
    );
    const b = computeIdentity(
      rowDraft('row:x', { evidence: { extra: { rowScope: { table: 't|', row: 'x', role: 'button', path: 'p' } } } }),
    );
    expect(a.elementKey).not.toBe(b.elementKey);
  });
});

describe('identitySchemeFor', () => {
  it('keys rows separately for a version 3 floor', () => {
    expect(identitySchemeFor({ version: 3, entries: [] })).toBe('row-scoped');
  });

  it('keeps the old keys for a version 2 or version 1 floor that holds entries', () => {
    const entry = {
      screenId: 'jobs', layer: 'pf', rule: 'pf-icon-button-name', elementKey: null,
      identityBasis: 'count' as const, count: 2,
    };
    expect(identitySchemeFor({ version: 2, entries: [entry] })).toBe('legacy');
    expect(identitySchemeFor({ version: 1, entries: [entry] })).toBe('legacy');
  });

  it('keys rows separately when the floor is empty, because there is nothing to compare', () => {
    expect(identitySchemeFor({ version: 2, entries: [] })).toBe('row-scoped');
  });
});

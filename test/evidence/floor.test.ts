import { describe, expect, it } from 'vitest';
import { parseEvidenceFloor } from '../../src/evidence/floor.js';
import { InputRefusedError } from '../../src/intake/input-refusal.js';

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
    expect(() => parseEvidenceFloor({ version: 4, entries: [] })).toThrow(/version/);
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

  it('rejects duplicate screen|rule|elementKey identities that the gate would last-win', () => {
    const duplicateLayer = { ...entry, layer: 'pf' };
    expect(() => parseEvidenceFloor({ version: 2, entries: [entry, duplicateLayer] })).toThrow(
      /duplicate identity/,
    );
  });

  it('accepts distinct identities that share a screen', () => {
    const other = {
      ...entry,
      rule: 'button-name',
      elementKey: null,
      identityBasis: 'count' as const,
      count: 1,
    };
    expect(parseEvidenceFloor({ version: 2, entries: [entry, other] }).entries).toHaveLength(2);
  });

  it('names the duplicate entries by position and never repeats the identity', () => {
    const duplicateLayer = { ...entry, layer: 'pf' };
    let message = '';
    try {
      parseEvidenceFloor({ version: 2, entries: [entry, duplicateLayer] });
    } catch (err) {
      expect(err).toBeInstanceOf(InputRefusedError);
      expect((err as InputRefusedError).field).toBe('entries[1]');
      message = (err as Error).message;
    }
    expect(message).toContain('entries[0]');
    expect(message).not.toContain('name:save');
    expect(message).not.toContain('clusters|');
  });

  it('refuses an entry screen id the id grammar refuses, by position, without repeating it', () => {
    let refused: unknown;
    try {
      parseEvidenceFloor({ version: 2, entries: [entry, { ...entry, rule: 'other', screenId: 'leak-me\u200bnow' }] });
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(InputRefusedError);
    expect((refused as InputRefusedError).field).toBe('entries[1].screenId');
    expect((refused as Error).message).toContain('U+200B');
    expect((refused as Error).message).not.toContain('leak-me');
  });
});

describe('parseEvidenceFloor total', () => {
  it('refuses a floor whose counts add up past the largest exact whole number, naming the field only', () => {
    const entry = (rule: string, count: number) => ({
      screenId: 'orders', layer: 'axe', rule, elementKey: null, identityBasis: 'count', count,
    });
    const floor = { version: 2, entries: [entry('button-name', Number.MAX_SAFE_INTEGER), entry('image-alt', 2)] };
    for (const [origin, field] of [
      [undefined, 'entries'],
      [{ source: 'gate() input', path: 'floor' }, 'floor.entries'],
    ] as const) {
      let refused: unknown;
      try {
        parseEvidenceFloor(floor, origin);
      } catch (err) {
        refused = err;
      }
      expect(refused).toBeInstanceOf(InputRefusedError);
      expect((refused as InputRefusedError).field).toBe(field);
      expect(String(refused)).toMatch(/more barriers in total than usabl can count exactly/);
      expect(String(refused)).not.toContain(String(Number.MAX_SAFE_INTEGER));
    }
    expect(() => parseEvidenceFloor({ version: 2, entries: [entry('button-name', Number.MAX_SAFE_INTEGER)] })).not.toThrow();
  });
});

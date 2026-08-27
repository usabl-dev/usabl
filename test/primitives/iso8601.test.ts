import { describe, expect, it } from 'vitest';
import { assertIso8601Utc } from '../../src/primitives/iso8601.js';

describe('assertIso8601Utc', () => {
  it('accepts a Date.toISOString value', () => {
    expect(() => assertIso8601Utc('2026-06-01T00:00:00.000Z', 'waiver expires')).not.toThrow();
  });

  it('rejects garbage, never, and non-UTC offsets', () => {
    expect(() => assertIso8601Utc('never', 'waiver expires')).toThrow(/ISO-8601 UTC/);
    expect(() => assertIso8601Utc('tomorrow', 'waiver expires')).toThrow(/ISO-8601 UTC/);
    expect(() => assertIso8601Utc('2026-12-31T00:00:00.000-05:00', 'waiver expires')).toThrow(/ISO-8601 UTC/);
  });

  it('rejects a matching-shape invalid calendar date', () => {
    expect(() => assertIso8601Utc('2026-02-31T00:00:00.000Z', 'waiver created')).toThrow(/ISO-8601 UTC/);
  });

  it('rejects an out-of-range month with the same actionable error', () => {
    expect(() => assertIso8601Utc('2026-13-01T00:00:00.000Z', 'waiver expires')).toThrow(/ISO-8601 UTC/);
  });
});

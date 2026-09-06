import { describe, expect, it } from 'vitest';
import { TEXT_CAPS, boundField, boundText } from '../../src/output/bounded-text.js';

describe('boundText', () => {
  it('leaves text that fits untouched, including text exactly at the cap', () => {
    expect(boundText('short', 10)).toBe('short');
    expect(boundText('x'.repeat(10), 10)).toBe('x'.repeat(10));
  });

  it('shortens oversized text and says how many characters were omitted', () => {
    const text = 'a'.repeat(1000);

    const out = boundText(text, 100);

    expect(out).toBe(`${'a'.repeat(100)} [shortened, 900 characters omitted]`);
  });

  it('never cuts between the halves of a surrogate pair', () => {
    // Four code units: two astral characters. A cap of 3 would land inside the second pair.
    const text = '\u{1F600}\u{1F601}';

    const out = boundText(text, 3);

    expect(out.startsWith('\u{1F600} [shortened, ')).toBe(true);
    expect(out).toContain('2 characters omitted');
  });

  it('is monotone: a longer input never yields a shorter kept prefix', () => {
    const kept = (length: number) => boundText('b'.repeat(length), 50).slice(0, 50);
    expect(kept(60)).toBe(kept(600));
  });
});

describe('boundField', () => {
  it('applies the cap named for the field', () => {
    for (const [field, cap] of Object.entries(TEXT_CAPS)) {
      const fits = 'c'.repeat(cap);
      const over = 'c'.repeat(cap + 1);
      expect(boundField(fits, field as keyof typeof TEXT_CAPS)).toBe(fits);
      expect(boundField(over, field as keyof typeof TEXT_CAPS)).toBe(
        `${fits} [shortened, 1 characters omitted]`,
      );
    }
  });

  it('keeps every cap large enough to name a cause and small enough to bound a message', () => {
    for (const cap of Object.values(TEXT_CAPS)) {
      expect(cap).toBeGreaterThanOrEqual(40);
      expect(cap).toBeLessThanOrEqual(600);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { neutralize } from '../../src/primitives/neutralize.js';

describe('neutralize', () => {
  it('strips ANSI CSI style sequences', () => {
    expect(neutralize('\u001b[31mRED')).toBe('RED');
  });

  it('strips ANSI ED clear-screen sequences', () => {
    expect(neutralize('\u001b[2J')).toBe('');
  });

  it('strips OSC payload and terminator', () => {
    expect(neutralize('\u001b]0;evil\u0007title')).toBe('title');
  });

  it('strips BEL control bytes', () => {
    expect(neutralize('alert\u0007done')).toBe('alertdone');
  });

  it('strips line-feed control bytes', () => {
    expect(neutralize('a\nb')).toBe('ab');
  });

  it('strips Unicode line separator bytes', () => {
    expect(neutralize('a\u2028b')).toBe('ab');
  });

  it('strips Unicode paragraph separator bytes', () => {
    expect(neutralize('a\u2029b')).toBe('ab');
  });

  it('strips C1 controls including 8-bit CSI', () => {
    expect(neutralize('\u009b31mRED')).toBe('31mRED');
  });

  it('preserves non-control Unicode text', () => {
    expect(neutralize('café')).toBe('café');
  });

  it('preserves empty input', () => {
    expect(neutralize('')).toBe('');
  });

  it('does not HTML-escape text', () => {
    expect(neutralize('<script>')).toBe('<script>');
  });
});

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

  // Invisible characters below stay written as escapes on purpose, so a reviewer can see
  // exactly which character each case covers. Visible letters stay literal.

  it('strips bidi embedding and override controls', () => {
    expect(neutralize('a\u202ab\u202bc\u202cd\u202de\u202ef')).toBe('abcdef');
  });

  it('strips bidi isolate controls', () => {
    expect(neutralize('a\u2066b\u2067c\u2068d\u2069e')).toBe('abcde');
  });

  it('strips directional marks', () => {
    expect(neutralize('a\u200eb\u200fc\u061cd')).toBe('abcd');
  });

  it('strips deprecated formatting controls', () => {
    expect(neutralize('a\u206ab\u206fc')).toBe('abc');
  });

  it('strips a reordering payload so the reader sees the real character order', () => {
    // A right-to-left override makes a terminal draw this label as "status: not verified"
    // while the characters the page actually holds say something else. Removing the control
    // means the printed text and the stored text agree.
    expect(neutralize('status: \u202edeifirev ton\u202c')).toBe('status: deifirev ton');
  });

  it('strips zero-width and invisible spacing characters', () => {
    expect(neutralize('a\u200bb\u2060c\ufeffd\u00ade')).toBe('abcde');
  });

  it('strips invisible math operators', () => {
    expect(neutralize('a\u2061b\u2062c\u2063d\u2064e')).toBe('abcde');
  });

  it('strips interlinear annotation characters', () => {
    expect(neutralize('a\ufff9b\ufffac\ufffbd')).toBe('abcd');
  });

  it('strips tag characters that hide ASCII from a human reader', () => {
    expect(neutralize('ok\u{e0041}\u{e0042}\u{e007f}')).toBe('ok');
  });

  it('preserves non-control Unicode text', () => {
    expect(neutralize('café')).toBe('café');
  });

  it('preserves right-to-left script text', () => {
    expect(neutralize('שלום עולם')).toBe('שלום עולם');
    expect(neutralize('مرحبا بالعالم')).toBe('مرحبا بالعالم');
  });

  it('preserves a right-to-left word inside an English sentence', () => {
    expect(neutralize('button שמור has no accessible name')).toBe(
      'button שמור has no accessible name',
    );
  });

  it('preserves joiners that carry meaning in text and emoji', () => {
    // A zero width non-joiner between two Persian words, and the zero width joiner that binds
    // an emoji sequence into one glyph. Removing either would change legitimate content.
    expect(neutralize('نمی\u200cخواهم')).toBe('نمی\u200cخواهم');
    expect(neutralize('\u{1f469}\u200d\u{1f4bb}')).toBe('\u{1f469}\u200d\u{1f4bb}');
  });

  it('preserves astral characters outside the tag block', () => {
    expect(neutralize('score \u{1f4af}')).toBe('score \u{1f4af}');
  });

  it('removes formatting characters without leaving a marker', () => {
    expect(neutralize('ver\u202eified')).toBe('verified');
  });

  it('is idempotent', () => {
    const text = 'status: \u202edeifirev ton\u202c \u001b[31m\u200bok\u2069';
    const once = neutralize(text);
    expect(once).toBe('status: deifirev ton ok');
    expect(neutralize(once)).toBe(once);
  });

  it('preserves empty input', () => {
    expect(neutralize('')).toBe('');
  });

  it('does not HTML-escape text', () => {
    expect(neutralize('<script>')).toBe('<script>');
  });
});

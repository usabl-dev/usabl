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

  it('turns a line feed into a space rather than welding the words together', () => {
    // An accessible name that wraps onto a second line is two words. Deleting the break would
    // report it as one, which is not the name the page has.
    expect(neutralize('Save\nbutton')).toBe('Save button');
  });

  it('turns a tab into a space', () => {
    expect(neutralize('Save\tbutton')).toBe('Save button');
  });

  it('turns a run of separators into a single space', () => {
    // A carriage return and line feed are one line break, and an indented continuation is one
    // gap between words, so spacing them out would be its own distortion.
    expect(neutralize('Save\r\n\tbutton')).toBe('Save button');
  });

  it('turns the Unicode separators and next line into a space', () => {
    expect(neutralize('line\u2028separator')).toBe('line separator');
    expect(neutralize('line\u2029separator')).toBe('line separator');
    expect(neutralize('line\u0085separator')).toBe('line separator');
  });

  it('still deletes control bytes that are not word separators', () => {
    expect(neutralize('alert\u0007done')).toBe('alertdone');
    expect(neutralize('a\u0000b')).toBe('ab');
  });

  it('strips the DELETE control byte', () => {
    expect(neutralize('a\u007fb')).toBe('ab');
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

  it('strips a reordering payload so the reader sees the real character order', () => {
    // A right-to-left override makes a terminal draw this label as "status: not verified"
    // while the characters the page actually holds say something else. Removing the control
    // means the printed text and the stored text agree.
    expect(neutralize('status: \u202edeifirev ton\u202c')).toBe('status: deifirev ton');
  });

  // Everything below is invisible and stays. usabl reports the text that is on the page, so
  // removing a character because a reader cannot see it would misrepresent the evidence. Each
  // of these carries meaning that removal would destroy.

  it('preserves the tag characters that spell the region in a flag emoji', () => {
    // The flag of England: a waving black flag followed by six tag characters. Dropping the tags
    // turns a valid emoji sequence into a plain black flag, a different accessible name.
    const flag = '\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}';

    expect(neutralize(flag)).toBe(flag);
    expect([...neutralize(flag)]).toHaveLength(7);
  });

  it('preserves variation selectors that choose how a glyph is drawn', () => {
    expect(neutralize('\u{1f44d}\ufe0f')).toBe('\u{1f44d}\ufe0f');
    expect(neutralize('\u{845b}\u{e0100}')).toBe('\u{845b}\u{e0100}');
  });

  it('preserves invisible mathematical operators', () => {
    expect(neutralize('f(x)\u2061 and a\u2062b')).toBe('f(x)\u2061 and a\u2062b');
  });

  it('preserves soft hyphens, which are a line-break hint in real prose', () => {
    expect(neutralize('accessibility\u00ad label')).toBe('accessibility\u00ad label');
  });

  it('preserves zero-width spaces, word joiners, and the byte order mark', () => {
    expect(neutralize('a\u200bb\u2060c\ufeffd')).toBe('a\u200bb\u2060c\ufeffd');
  });

  it('preserves deprecated formatting characters', () => {
    expect(neutralize('a\u206ab\u206fc')).toBe('a\u206ab\u206fc');
  });

  it('preserves interlinear annotation characters', () => {
    expect(neutralize('a\ufff9b\ufffac\ufffbd')).toBe('a\ufff9b\ufffac\ufffbd');
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

  it('preserves astral characters', () => {
    expect(neutralize('score \u{1f4af}')).toBe('score \u{1f4af}');
  });

  it('returns text with nothing to remove unchanged', () => {
    const clean = 'button "Save" has no accessible name on /clusters';

    expect(neutralize(clean)).toBe(clean);
  });

  it('removes what it removes without leaving a marker', () => {
    expect(neutralize('ver\u202eified')).toBe('verified');
  });

  it('is idempotent', () => {
    const text = 'status: \u202edeifirev ton\u202c\n\u001b[31m\u200bok\u2069';
    const once = neutralize(text);

    expect(once).toBe('status: deifirev ton \u200bok');
    expect(neutralize(once)).toBe(once);
  });

  it('preserves empty input', () => {
    expect(neutralize('')).toBe('');
  });

  it('does not HTML-escape text', () => {
    expect(neutralize('<script>')).toBe('<script>');
  });
});

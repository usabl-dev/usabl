/**
 * The vite alias object is read in time that grows with its length, with the entries the pattern
 * it replaced read. That pattern took time that grew with the square of the text when many values
 * start a path.resolve( call that never closes: 340,000 characters took about 15 seconds. The
 * comparison reads generated text with both and wants the same entries in the same order. The time
 * check is a loose bound far above the measured time.
 */
import { describe, expect, it } from 'vitest';
import { aliasObjectEntries } from '../../src/coverage/alias-config.js';

// The pattern the reader replaced, as it was.
const OLD_ENTRY_RE =
  /(?:['"`]([^'"`]+)['"`]|(?<![\w$.])([A-Za-z_$][\w$]*))\s*:\s*((?:path\.resolve\([^)]+\)|['"`][^'"`]*['"`]|[^,}\n]+))/g;

function oldEntries(text: string): Array<{ find: string; replacement: string }> {
  const found: Array<{ find: string; replacement: string }> = [];
  for (const match of text.matchAll(OLD_ENTRY_RE)) {
    const find = match[1] ?? match[2];
    const replacement = match[3];
    if (typeof find === 'string' && typeof replacement === 'string') found.push({ find, replacement });
  }
  return found;
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const PIECES = [
  "'@'",
  '"~"',
  '`#`',
  'key',
  '$a',
  '_b',
  '9',
  '.x',
  ':',
  ':',
  ' ',
  '  ',
  '\n',
  '\t',
  ',',
  'path.resolve(',
  'path.resolve(__dirname, "./src")',
  ')',
  "'./src'",
  '"',
  "'",
  '`',
  './lib',
  '\u00a0',
  'é',
];

function generated(next: () => number): string {
  let text = '';
  const count = 1 + Math.floor(next() * 30);
  for (let index = 0; index < count; index += 1) text += PIECES[Math.floor(next() * PIECES.length)]!;
  return text;
}

const COMPARISON_TIMEOUT_MS = 60_000;

describe('the vite alias object reader', () => {
  it('reads the same entries as the old pattern on 30,000 generated texts', () => {
    const next = random(4242);
    let withEntries = 0;
    for (let index = 0; index < 30_000; index += 1) {
      const text = generated(next);
      const expected = oldEntries(text);
      expect(aliasObjectEntries(text), JSON.stringify(text)).toEqual(expected);
      if (expected.length > 0) withEntries += 1;
    }
    expect(withEntries).toBeGreaterThan(5_000);
    // About 2.8 seconds alone, and past the 5 second default on a busy machine (load about 9).
    // The comparison needs this many texts, so the case gets a limit well above its time.
  }, COMPARISON_TIMEOUT_MS);

  it('reads the same entries as the old pattern on hand-written cases', () => {
    const cases = [
      " '@': './src', tests: path.resolve(__dirname, './tests'), ",
      "\n  '@': path.resolve(\n    __dirname,\n    './src'\n  ),\n  lib: './lib'\n",
      'a: ,',
      'a:\n ,',
      'a: \n',
      'a.b: x',
      "'': x",
      "'a' : 'b' 'c'",
      'path.resolve(: x',
      'a: path.resolve()',
      'a: `x',
      '$: x, _: y',
    ];
    for (const text of cases) {
      expect(aliasObjectEntries(text), JSON.stringify(text)).toEqual(oldEntries(text));
    }
  });

  it('reads text whose values open calls and strings that never close inside a loose bound', () => {
    for (const piece of ['k: path.resolve(\n', "k: '\n", 'k: `\n', "'k\n"]) {
      const text = piece.repeat(Math.ceil(400_000 / piece.length));
      const started = performance.now();
      aliasObjectEntries(text);
      expect(performance.now() - started, piece).toBeLessThan(10_000);
    }
  });
});

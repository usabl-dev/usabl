/**
 * The glob matcher that does not backtrack must give the answers the old regular expression
 * matchers gave, for both dot rules and for CODEOWNERS patterns. Patterns and paths are generated
 * from a fixed seed, so a run is the same every time, and kept short so the old matchers finish.
 */
import { describe, expect, it } from 'vitest';
import { globMatcher } from '../../src/primitives/match-glob.js';
import { compileCodeownersPattern } from '../../src/primitives/match-codeowners.js';
import { regexCodeownersState, regexGlobMatcher } from '../support/glob-regex-reference.js';

// A small fixed-seed generator, so every run tests the same cases.
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PATTERN_PIECES = [
  'a', 'b', 'A', '.', '/', '*', '**', '**/', '/**', '/**/', '?', '[', ']', '[ab]', '\\', '\\*',
  '{a,b}', '{x}', '{', '}', '$', '(', ')', '+', '^', '|', '-', '\n', '\x00', '.a', 'src/', '*.tsx',
];
const PATH_PIECES = ['a', 'b', 'A', 'B', '.', '/', '.a', 'x', '?', '[', ']', '\\', '{', '}', '*', '$', '\n', 'src/', '.tsx', '//'];

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

function build(random: () => number, pieces: readonly string[], most: number): string {
  const count = Math.floor(random() * (most + 1));
  let text = '';
  for (let i = 0; i < count; i += 1) text += pick(random, pieces);
  return text;
}

// Patterns written the way the guard, the planner, and the import graph use them, to cover each
// form the brief names: dot files, ** at the start, middle and end, a trailing slash, character
// classes, escaped characters, and letter case.
const FIXED_PATTERNS = [
  '', '*', '**', '**/*', '**/.*', '**/.*/**', '.*', 'src/**', 'src/**/*.tsx', 'src/**/*.{ts,tsx}', '**/x.json',
  'policy/*.json', 'policy/**/x.json', 'policy/', 'policy/**/', 'a/**/b', 'a/**/**/b', 'a/**/**', '**/a/**',
  'src/*/', 'src/.*', 'src/.x/**', 'SRC/**', 'src/[id]/*.tsx', 'src/\\*.tsx', 'src/x?.tsx', 'src/**?',
  'src/a?b', 'src/a??b', 'src/**/?', 'a**b', 'a***b', 'a/***/b', '{src,app}/**/*.tsx', 'src/App.{tsx}',
  'src/{a,b', 'x}/y', '/a', '//a', 'a//b', 'a/', 'src/**/.x', 'src/**/.*/**', '.x/**', '\x00', 'a\x00b',
];
const FIXED_PATHS = [
  '', 'a', 'src', 'src/', 'src/App.tsx', 'src/.env', 'src/.x/y', 'src/a/.b/c.tsx', 'SRC/App.tsx', 'src/app.TSX',
  'policy/x.json', 'policy/.override.json', 'policy/a/x.json', 'policy/', 'a/b', 'a/x/b', 'a/xb', 'a/.x/b',
  'a//b', '/a', '//a', 'a/', 'src/[id]/x.tsx', 'src/*.tsx', 'src/x?.tsx', 'src/xa.tsx', 'src/ab', 'src/b',
  'src/a\nb.tsx', 'src/App.{tsx}', 'src/{a,b', 'x}/y', 'ab', 'axb', 'ax/yb', '.x/y', '.x', 'x.json',
];

function outcome(build: () => (file: string) => boolean): ((file: string) => boolean) | 'refused' {
  try {
    return build();
  } catch {
    return 'refused';
  }
}

// How many times the old matcher said yes, so a test can show it compared true answers too.
const matched = { count: 0 };

function compare(pattern: string, paths: readonly string[], dot: boolean): string[] {
  const options = dot ? {} : { dot: false };
  const old = outcome(() => regexGlobMatcher(pattern, options));
  const now = outcome(() => globMatcher(pattern, options));
  if (old === 'refused' || now === 'refused') {
    return old === now ? [] : [`${JSON.stringify(pattern)} dot=${String(dot)}: old ${old === 'refused' ? 'refused' : 'built'}, new ${now === 'refused' ? 'refused' : 'built'}`];
  }
  const differences: string[] = [];
  for (const path of paths) {
    if (old(path)) matched.count += 1;
    if (old(path) !== now(path)) {
      differences.push(`${JSON.stringify(pattern)} dot=${String(dot)} ${JSON.stringify(path)}: old ${String(old(path))}, new ${String(now(path))}`);
    }
  }
  return differences;
}

describe('the glob matcher gives the old regular expression answers', () => {
  it('for the fixed patterns and paths, with both dot rules', () => {
    matched.count = 0;
    const differences = FIXED_PATTERNS.flatMap((pattern) => [...compare(pattern, FIXED_PATHS, true), ...compare(pattern, FIXED_PATHS, false)]);
    expect(differences).toEqual([]);
    expect(matched.count).toBeGreaterThan(200);
  });

  it('for generated patterns and paths, with both dot rules', () => {
    const random = generator(20261124);
    const paths = [...FIXED_PATHS, ...Array.from({ length: 60 }, () => build(random, PATH_PIECES, 8))];
    const differences: string[] = [];
    matched.count = 0;
    for (let i = 0; i < 800; i += 1) {
      const pattern = build(random, PATTERN_PIECES, 6);
      differences.push(...compare(pattern, paths, true), ...compare(pattern, paths, false));
    }
    expect(differences.slice(0, 20)).toEqual([]);
    expect(matched.count).toBeGreaterThan(500);
  });

  it('for generated paths made to match the pattern, so a true answer is tested as often as a false one', () => {
    const random = generator(7);
    const differences: string[] = [];
    matched.count = 0;
    for (let i = 0; i < 1000; i += 1) {
      const pattern = build(random, PATTERN_PIECES, 5);
      // A path built from the pattern's own text, with each star replaced by a short run.
      const near = Array.from({ length: 8 }, () =>
        pattern
          .replace(/\*\*/g, () => pick(random, ['', 'a/', 'a/b/', '.a/', 'x']))
          .replace(/\*/g, () => pick(random, ['', 'a', '.a', 'ab', '/']))
          .replace(/\?/g, () => pick(random, ['', '?', 'a'])),
      );
      differences.push(...compare(pattern, near, true), ...compare(pattern, near, false));
    }
    expect(differences.slice(0, 20)).toEqual([]);
    expect(matched.count).toBeGreaterThan(2000);
  });
});

const CODEOWNERS_PIECES = ['a', 'b', '.', '/', '*', '?', 'x.js', 'docs', '{', '}', '$', '+', '-'];

describe('the CODEOWNERS matcher gives the old regular expression answers', () => {
  it('for generated patterns and paths', () => {
    const random = generator(42);
    const paths = [
      'a', 'a/b', 'docs/a.js', 'docs/x.js/b', 'a/docs/x.js', 'x.js', '.a/x.js', 'a//b', 'a/b/', 'docs',
      ...Array.from({ length: 60 }, () => build(random, ['a', 'b', '/', '.', 'x.js', 'docs', '?', '\n'], 6)),
    ];
    const differences: string[] = [];
    let compiled = 0;
    let owned = 0;
    for (let i = 0; i < 800; i += 1) {
      const pattern = build(random, CODEOWNERS_PIECES, 5);
      const now = compileCodeownersPattern(pattern);
      if (!now.ok) continue;
      compiled += 1;
      const old = regexCodeownersState(pattern);
      for (const path of paths) {
        if (old(path) !== 'none') owned += 1;
        if (old(path) !== now.state(path)) differences.push(`${JSON.stringify(pattern)} ${JSON.stringify(path)}: old ${old(path)}, new ${now.state(path)}`);
      }
    }
    expect(compiled).toBeGreaterThan(250);
    expect(owned).toBeGreaterThan(200);
    expect(differences.slice(0, 20)).toEqual([]);
  });
});

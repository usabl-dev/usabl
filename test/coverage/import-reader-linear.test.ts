/**
 * The import reader reads in time that grows with the length of the text, with the same answers it
 * gave before. The static import pattern it replaced took time that grew with the square of a
 * line's length, so one long line an agent wrote could hold a check for minutes. The comparison
 * reads generated text with the old pattern and the new reader and wants the same paths in the
 * same order. The time checks are loose bounds far above the measured times: each shape took the
 * old pattern minutes, or the old readers tens of seconds, and takes the new readers milliseconds.
 */
import { describe, expect, it } from 'vitest';
import type { FsGlob } from '../../src/contracts/index.js';
import {
  buildImportGraph,
  inspectDirectImports,
  MAX_SOURCE_CHARACTERS,
  MAX_SOURCE_LINE_CHARACTERS,
  importMayLoad,
  staticImportSpecifiers,
} from '../../src/coverage/import-graph.js';
import { describeLoad } from '../../src/coverage/discovery-diagnostics.js';

// The pattern the reader replaced, as it was.
const OLD_FROM_IMPORT_RE = /\bimport\s+(?:type\s+)?[^"'`;\n]+?\sfrom\s*["'`]([^"'`]+)["'`]/g;

function oldSpecifiers(source: string): string[] {
  return [...source.matchAll(OLD_FROM_IMPORT_RE)].map((match) => match[1]!);
}

// A small generator with a fixed seed, so a failure names a text that can be read again.
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const PIECES = [
  'import',
  'import',
  'type',
  'from',
  'from',
  ' ',
  ' ',
  '  ',
  '\t',
  '\n',
  '\r',
  ' ',
  ' ',
  '﻿',
  "'",
  '"',
  '`',
  ';',
  'a',
  'x',
  '_',
  '$',
  '9',
  './y',
  '{ a }',
  '*',
  ',',
  'é',
  '\u{1f600}',
];

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length)]!;
}

function noise(next: () => number, count: number): string {
  let text = '';
  for (let index = 0; index < count; index += 1) text += pick(next, PIECES);
  return text;
}

const SPACES = [' ', '  ', '\t', '\n', '\u00a0', ' \n ', '\r\n', '\u2028', ''];
const CLAUSES = ['a', '{ a }', 'type', 'from', 'a from b', '* as x', 'a;b', "a'b", '', 'import x'];
const QUOTES = ["'", '"', '`', ''];
const PATHS = ['./a', 'b', '', 'x\ny', 'from', './c d', "'"];

// An import that is close to one the pattern reads, with each part picked from near misses, so
// many texts match and many miss by one character.
function nearImport(next: () => number): string {
  const type = next() < 0.3 ? `type${pick(next, SPACES)}` : '';
  return (
    `import${pick(next, SPACES)}${type}${pick(next, CLAUSES)}${pick(next, SPACES)}from${pick(next, SPACES)}` +
    `${pick(next, QUOTES)}${pick(next, PATHS)}${pick(next, QUOTES)}`
  );
}

function generated(next: () => number, count: number): string {
  if (next() < 0.3) return noise(next, count);
  let text = '';
  const imports = 1 + Math.floor(next() * 4);
  for (let index = 0; index < imports; index += 1) {
    text += nearImport(next) + noise(next, Math.floor(next() * 4));
  }
  return text;
}

describe('the static import reader', () => {
  it('reads the same paths as the old pattern on 30,000 generated texts', () => {
    const next = random(20261127);
    let compared = 0;
    let withPaths = 0;
    for (let index = 0; index < 30_000; index += 1) {
      const text = generated(next, 1 + Math.floor(next() * 40));
      const expected = oldSpecifiers(text);
      expect(staticImportSpecifiers(text), JSON.stringify(text)).toEqual(expected);
      compared += 1;
      if (expected.length > 0) withPaths += 1;
    }
    expect(compared).toBe(30_000);
    // The texts are not all empty of imports, so the comparison reads real matches.
    expect(withPaths).toBeGreaterThan(5_000);
  });

  it('reads the same paths as the old pattern on hand-written cases', () => {
    const cases = [
      "import x from './a';",
      "import type T from './t';",
      "import type from './t';",
      "import   from './x';",
      "import  from './x';",
      "import a from b from './c';",
      "import a\nfrom './a';",
      "import\nx from './a';",
      "import \n from './a';",
      "import  \n  from './a';",
      "import a from\n\n  './a';",
      "import a from '';",
      "import a from './a\nb';",
      "import { a } from './a'; import { b } from './b';",
      "ximport a from './a';",
      "$import a from './a';",
      "import a from './a' import b from './b'",
      "import type  a  from './a'",
      "import type\nfrom './a'",
      "import type \nfrom './a'",
      'import a from "./a\'',
      "import a from 'x' from 'y'",
      "import a;b from 'x'",
      "import 'side-effect';",
      'import',
      'import ',
      "import a from '",
    ];
    for (const text of cases) {
      expect(staticImportSpecifiers(text), JSON.stringify(text)).toEqual(oldSpecifiers(text));
    }
  });
});

// A file system that holds a few files in memory.
function memoryFs(files: Record<string, string>): FsGlob {
  return {
    readFile: async (path) => files[path] ?? null,
    glob: async () => [],
  };
}

// The text shapes that made a reader slow: each repeats a piece that a reader would scan from to
// the end of a line or of the file.
function slowShapes(length: number): Record<string, string> {
  const fill = (piece: string): string => piece.repeat(Math.ceil(length / piece.length)).slice(0, length);
  return {
    'spaces after import': `import${' '.repeat(length)}'./styles.css';`,
    'import x on one line': fill('import x '),
    'import x in a comment': `// ${fill('import x ')}`,
    'import type on one line': fill('import  type  '),
    'from with no path': fill('import a from '),
    'from with an open path': fill("import a from '"),
    'import on every line': fill('import\n'),
    'comments that never close': fill('import(/*'),
    'glob options that never close': fill("import.meta.glob('a',"),
    'glob types that never close': fill('import.meta.glob<'),
    'a comment before each call': fill('/* c */ import(x)\n'),
    'require context with no path': fill('require.context('),
    'dynamic import with an open path': fill("import('"),
    // Each call is its own load, so the graph keeps one entry for each.
    'many loader calls': Array.from({ length: Math.ceil(length / 16) }, (_, index) => `import(x${index});`).join('\n'),
  };
}

const LOOSE_BOUND_MS = 10_000;

describe('the import readers on long text', () => {
  it('read each slow shape of 200,000 characters inside a loose bound, the complete reading included', async () => {
    for (const [shape, source] of Object.entries(slowShapes(200_000))) {
      const started = performance.now();
      const graph = await buildImportGraph(memoryFs({ 'src/App.tsx': source }), ['src/App.tsx'], undefined, { complete: true });
      await inspectDirectImports(memoryFs({ 'src/App.tsx': source }), 'src/App.tsx');
      staticImportSpecifiers(source);
      const ms = performance.now() - started;
      expect(ms, shape).toBeLessThan(LOOSE_BOUND_MS);
      expect(graph.visited.has('src/App.tsx'), shape).toBe(true);
    }
  }, 120_000);
});

describe('a file past the reader bounds', () => {
  it('is read as one that may load any file, in the graph and in the direct reading', async () => {
    const longLine = `import a from './a';\n${'x'.repeat(MAX_SOURCE_LINE_CHARACTERS + 1)}\n`;
    const longFile = `${'x\n'.repeat(Math.floor(MAX_SOURCE_CHARACTERS / 2) + 1)}import a from './a';\n`;
    for (const [why, source] of [
      ['line', longLine],
      ['size', longFile],
    ] as const) {
      const fs = memoryFs({ 'src/App.tsx': source, 'src/a.ts': 'export const a = 1;\n' });
      const graph = await buildImportGraph(fs, ['src/App.tsx']);
      const entry = { importer: 'src/App.tsx', specifier: '', kind: 'unread-source', why } as const;
      expect(graph.unresolvable).toEqual([entry]);
      // Its imports are not followed, so nothing it imports is reached through it.
      expect(graph.get('src/App.tsx')).toEqual([]);
      expect(graph.visited.has('src/a.ts')).toBe(false);
      expect(await inspectDirectImports(fs, 'src/App.tsx')).toEqual([entry]);
      expect(importMayLoad(entry, 'src/anything/at/all.test.tsx')).toBe(true);
      expect(describeLoad(entry)).toContain('src/App.tsx was not read for imports');
      expect(describeLoad(entry)).toContain('so it may load any file');
    }
  });

  it('reads a file right at the bounds as it always did', async () => {
    const atLine = `import a from './a';\n${'x'.repeat(MAX_SOURCE_LINE_CHARACTERS)}\n`;
    const fs = memoryFs({ 'src/App.tsx': atLine, 'src/a.ts': 'export const a = 1;\n' });
    const graph = await buildImportGraph(fs, ['src/App.tsx']);
    expect(graph.unresolvable).toEqual([]);
    expect(graph.get('src/App.tsx')).toEqual(['src/a.ts']);
  });
});

/**
 * import.meta.glob patterns come from source code, so they have the size bounds of the policy glob
 * lists. A pattern past a bound may load any file, a gap, and is never ignored. A pattern inside
 * the bounds is built once for the run, not once for each file it is tested against.
 */
import { describe, expect, it } from 'vitest';
import { buildImportGraph, GlobImportBudget, importMayLoad, type UnresolvableImport } from '../../src/coverage/import-graph.js';
import { GlobMatchBudget } from '../../src/primitives/match-glob.js';
import { describeLoad } from '../../src/coverage/discovery-diagnostics.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { regexGlobMatcher } from '../support/glob-regex-reference.js';

const graphOf = (source: string) =>
  buildImportGraph(
    makeFakeDeps({ files: { 'src/pages/Page.tsx': source, 'src/tests/Widget.tsx': '' } }).fs,
    ['src/pages/Page.tsx'],
  );

function onlyGlobEntry(entries: readonly UnresolvableImport[]): Extract<UnresolvableImport, { kind: 'glob-import' }> {
  expect(entries).toHaveLength(1);
  const entry = entries[0];
  if (entry?.kind !== 'glob-import') throw new Error('expected one glob-import entry');
  return entry;
}

function elapsedMs(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

const FILES = Array.from({ length: 2000 }, (_, index) => `src/pages/${'x'.repeat(40)}/${String(index)}.tsx`);

describe('the character budget for import.meta.glob patterns across a run', () => {
  const call = (folder: string, length: number): string => `const a = import.meta.glob('./${folder}/${'x'.repeat(length)}*.tsx');\n`;

  it('counts every call once, across graphs, and reads every call after the budget as one that may load any file', async () => {
    const files = {
      'src/A.tsx': call('a', 600),
      'src/B.tsx': call('b', 600),
      'src/C.tsx': call('c', 10),
    };
    const fs = makeFakeDeps({ files }).fs;
    const globImports = new GlobImportBudget(1300);
    const first = await buildImportGraph(fs, ['src/A.tsx', 'src/B.tsx', 'src/C.tsx'], undefined, { globImports });
    const unread = first.unresolvable.map((entry) => (entry.kind === 'glob-import' ? (entry.unread ?? 'read') : 'other'));
    // All three fit in 1300 characters. A graph built again, in another order, is not charged again
    // and gives every call the same answer.
    expect(unread).toEqual(['read', 'read', 'read']);
    const again = await buildImportGraph(fs, ['src/C.tsx', 'src/B.tsx', 'src/A.tsx'], undefined, { globImports });
    expect(again.unresolvable.map((entry) => (entry.kind === 'glob-import' ? (entry.unread ?? 'read') : 'other'))).toEqual(['read', 'read', 'read']);

    const small = new GlobImportBudget(700);
    const graph = await buildImportGraph(fs, ['src/A.tsx', 'src/B.tsx', 'src/C.tsx'], undefined, { globImports: small });
    const entries = graph.unresolvable.filter((entry) => entry.kind === 'glob-import');
    expect(entries.map((entry) => entry.unread ?? 'read')).toEqual(['read', 'budget', 'budget']);
    const past = entries[1];
    if (past?.kind !== 'glob-import') throw new Error('expected a glob-import entry');
    expect(past.patterns).toBeNull();
    expect(importMayLoad(past, 'src/anything.tsx')).toBe(true);
    expect(describeLoad(past)).toContain('budget of 65,536 characters');
  });

  it('reads a glob as one that may load the file once the matching budget is spent', async () => {
    const graph = await graphOf("const a = import.meta.glob('../tests/*.tsx');");
    const entry = onlyGlobEntry(graph.unresolvable);
    expect(importMayLoad(entry, 'src/other/x.tsx')).toBe(false);
    const spent = new GlobMatchBudget(0);
    expect(() => spent.charge(1)).toThrow();
    expect(importMayLoad(entry, 'src/other/x.tsx', new Map(), spent)).toBe(true);
    const tight = new GlobMatchBudget(5);
    expect(importMayLoad(entry, `src/${'a/'.repeat(100)}x.tsx`, new Map(), tight)).toBe(true);
  });
});

describe('import.meta.glob pattern bounds', () => {
  it('reads a 10,000-character pattern as one that may load any file, at no cost for each file', async () => {
    const graph = await graphOf(`const a = import.meta.glob('./${'x'.repeat(10_000)}*.tsx');`);
    const entry = onlyGlobEntry(graph.unresolvable);
    expect(entry.patterns).toBeNull();
    expect(entry.unread).toBe('size');
    expect(describeLoad(entry)).toContain('longer than 1024 characters');
    let loaded = 0;
    const ms = elapsedMs(() => {
      for (const file of FILES) if (importMayLoad(entry, file)) loaded += 1;
    });
    expect(loaded).toBe(FILES.length);
    expect(ms).toBeLessThan(250);
  });

  it('reads a call past the bound on patterns in all as one that may load any file', async () => {
    // 64 alternatives in each of 65 patterns is 4160 patterns, past the bound of 4096.
    const group = `{${Array.from({ length: 64 }, (_, index) => `p${String(index)}`).join(',')}}`;
    const list = Array.from({ length: 65 }, (_, index) => `'./${String(index)}${group}/*.tsx'`).join(', ');
    const entry = onlyGlobEntry((await graphOf(`const a = import.meta.glob([${list}]);`)).unresolvable);
    expect(entry.patterns).toBeNull();
    expect(entry.unread).toBe('size');
  });

  it('builds a pattern inside the bounds once and gives the old matcher answers', async () => {
    // 64 alternatives of about 900 characters each, every one inside the bound of 1024.
    const alternatives = Array.from({ length: 64 }, (_, index) => `${'x'.repeat(40)}/${String(index)}/${'y'.repeat(850)}*.tsx`);
    const graph = await graphOf(`const a = import.meta.glob('./{${alternatives.join(',')}}');`);
    const entry = onlyGlobEntry(graph.unresolvable);
    expect(entry.patterns).toHaveLength(64);
    const old = (entry.patterns ?? []).map((pattern) => regexGlobMatcher(pattern));
    const sample = [...FILES.slice(0, 50), `src/pages/${'x'.repeat(40)}/7/${'y'.repeat(850)}Widget.tsx`];
    for (const file of sample) {
      expect(importMayLoad(entry, file), file).toBe(old.some((matches) => matches(file)));
    }
    let loaded = 0;
    const ms = elapsedMs(() => {
      for (const file of FILES) if (importMayLoad(entry, file)) loaded += 1;
    });
    expect(loaded).toBe(0);
    expect(ms).toBeLessThan(500);
  });
});

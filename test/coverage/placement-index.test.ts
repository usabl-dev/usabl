/**
 * Test-file placement looks up the loads that could reach each file instead of testing every file
 * against every load, with the same answers. Before, 20,000 test files against 4,000 unresolved
 * imports took one synchronous piece of tens of seconds. The comparison checks the index against
 * importMayLoad for every pair on generated loads, files, and package folders. Work that is still
 * charged to the placement budget is checked by its step count with a small budget, not by the
 * clock, and a spent budget leaves the files as gaps.
 */
import { describe, expect, it } from 'vitest';
import type { FsGlob, UsablConfig } from '../../src/contracts/index.js';
import { loadAppAliasConfig } from '../../src/coverage/alias-config.js';
import { runGlobBudgets } from '../../src/coverage/glob-budget.js';
import {
  importMayLoad,
  LoadIndex,
  testedForEachFile,
  type PackageFolders,
  type UnresolvableImport,
} from '../../src/coverage/import-graph.js';
import { placeTestFiles } from '../../src/coverage/test-files.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { GlobMatchBudget } from '../../src/primitives/match-glob.js';

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length)]!;
}

const NAMES = ['Widget', 'widget', 'index', 'Index', 'tests', 'k1', '#k1', '@/tests', '@/', 'Dashboard', 'view', ''];
const FOLDERS = ['src', 'src/tests', 'src/tests/Dashboard', 'packages/ui', 'src/Widget', 'lib'];

function specifierOf(next: () => number): string {
  const name = pick(next, NAMES);
  return pick(next, [name, `./${name}`, `@/tests/${name}`, `${name}.tsx`, `#${name}`, `../${name}/index`, `${name}?raw`]);
}

function loadOf(next: () => number, importer: string): UnresolvableImport {
  const specifier = specifierOf(next);
  switch (Math.floor(next() * 9)) {
    case 0:
      return { importer, specifier, kind: 'file-not-found' };
    case 1:
      return { importer, specifier, kind: 'bare-unknown' };
    case 2:
      return { importer, specifier, kind: 'alias-unmapped' };
    case 3:
      return { importer, specifier, kind: 'ambiguous-candidates', candidates: [`${pick(next, FOLDERS)}/${pick(next, NAMES)}.tsx`] };
    case 4:
      return { importer, specifier, kind: 'base-url', candidates: [`${pick(next, FOLDERS)}/${pick(next, NAMES)}.tsx`] };
    case 5:
      return { importer, specifier, kind: 'package-subpath', packageDir: next() < 0.2 ? null : pick(next, FOLDERS) };
    case 6:
      return next() < 0.3
        ? { importer, specifier: 'import(x)', kind: 'dynamic-import', prefixes: null }
        : { importer, specifier: 'import(x)', kind: 'dynamic-import', prefixes: [`${pick(next, FOLDERS)}/`], nameStarts: [pick(next, NAMES)] };
    case 7:
      return next() < 0.3
        ? { importer, specifier: 'import.meta.glob(x)', kind: 'glob-import', patterns: null }
        : { importer, specifier: 'import.meta.glob(x)', kind: 'glob-import', patterns: [`${pick(next, FOLDERS)}/**/*.tsx`] };
    default:
      return { importer, specifier: '', kind: 'unread-source', why: 'size' };
  }
}

function fileOf(next: () => number): string {
  const name = pick(next, NAMES.filter((name) => name !== '' && !name.includes('/') && !name.startsWith('#')));
  return pick(next, [`${pick(next, FOLDERS)}/${name}.tsx`, `${pick(next, FOLDERS)}/${name}/index.tsx`, `${pick(next, FOLDERS)}/${name}.test.tsx`]);
}

function foldersOf(next: () => number): PackageFolders {
  const folders = new Map<string, { targets: { exact: ReadonlySet<string>; prefixes: readonly string[] } | null }>();
  for (const dir of FOLDERS) {
    if (next() < 0.5) continue;
    folders.set(
      dir,
      next() < 0.3 ? { targets: null } : { targets: { exact: new Set([`${dir}/widget`.toLowerCase()]), prefixes: [`${dir}/view`.toLowerCase()] } },
    );
  }
  return folders;
}

describe('the load index', () => {
  it('names the same loads for each file as importMayLoad does, on 3,000 generated placements', () => {
    const next = random(1127);
    let pairs = 0;
    let loaded = 0;
    for (let round = 0; round < 3_000; round += 1) {
      const loads = Array.from({ length: 1 + Math.floor(next() * 8) }, () => loadOf(next, `src/${pick(next, NAMES) || 'App'}.tsx`));
      const folders = foldersOf(next);
      const index = new LoadIndex(loads, folders);
      for (let count = 0; count < 6; count += 1) {
        const file = fileOf(next);
        const expected = loads.flatMap((entry, at) => (importMayLoad(entry, file, folders) ? [at] : []));
        const tested = loads.flatMap((entry, at) => (testedForEachFile(entry) && importMayLoad(entry, file, folders) ? [at] : []));
        const actual = [...new Set([...index.matches(file), ...index.everyFile, ...tested])].sort((a, b) => a - b);
        expect(actual, JSON.stringify({ loads, folders: [...folders.keys()], file })).toEqual(expected);
        pairs += loads.length;
        loaded += expected.length;
      }
    }
    expect(pairs).toBeGreaterThan(50_000);
    expect(loaded).toBeGreaterThan(5_000);
  });
});

const fsOf = (files: Record<string, string>): FsGlob => makeFakeDeps({ files }).fs;

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: ['usabl.config.json'],
};

// 20,000 test files that nothing loads, and a screen file with 4,000 imports no package explains.
function heavyApp(): Record<string, string> {
  const files: Record<string, string> = {};
  for (let index = 0; index < 20_000; index += 1) {
    files[`src/__tests__/f${String(index).padStart(5, '0')}.test.ts`] = 'export const t = 1;\n';
  }
  const imports = Array.from({ length: 4_000 }, (_, index) => `import k${String(index)} from '#k${String(index)}';`).join('\n');
  files['src/App.tsx'] = `${imports}\nexport const App = 1;\n`;
  return files;
}

describe('test-file placement with many files and many unresolved imports', () => {
  it('excludes a test file no load names, and spends no budget on the name lookups', async () => {
    const fs = fsOf(heavyApp());
    const budgets = runGlobBudgets();
    const changed = 'src/__tests__/f00007.test.ts';
    const aliases = await loadAppAliasConfig(fs, 'src/App.tsx');
    const placements = await placeTestFiles(fs, config, [], aliases, [changed], [], false, budgets);
    expect(placements.get(changed)).toEqual({ state: 'none' });
    expect(budgets.placement.steps - budgets.placement.remaining).toBe(0);
  }, 120_000);

  it('places a test file that one of the imports names as one it may load', async () => {
    const tree = heavyApp();
    tree['src/__tests__/k7.ts'] = 'export const k = 1;\n';
    const fs = fsOf(tree);
    const changed = 'src/__tests__/k7.ts';
    const aliases = await loadAppAliasConfig(fs, 'src/App.tsx');
    const placements = await placeTestFiles(fs, config, [], aliases, [changed], [], false, runGlobBudgets());
    const placement = placements.get(changed);
    expect(placement?.state).toBe('maybe');
    expect(placement?.state === 'maybe' ? placement.loads.map((entry) => entry.specifier) : []).toEqual(['#k7']);
  }, 120_000);

  it('charges one step for each test of a glob call with no pattern to match, and a spent budget leaves a gap', async () => {
    // 2,000 calls whose only pattern is a negative one: each is a test for each test file, with
    // nothing to match, so before, no step was charged for them at all.
    const calls = Array.from({ length: 2_000 }, (_, index) => `const g${String(index)} = import.meta.glob('!x${String(index)}');`).join('\n');
    const files: Record<string, string> = { 'src/App.tsx': `${calls}\nexport const App = 1;\n` };
    for (let index = 0; index < 50; index += 1) files[`src/__tests__/t${String(index)}.test.ts`] = 'export const t = 1;\n';
    const fs = fsOf(files);
    const changed = 'src/__tests__/t7.test.ts';
    const aliases = await loadAppAliasConfig(fs, 'src/App.tsx');

    const roomy = { ...runGlobBudgets(), placement: new GlobMatchBudget(10_000_000) };
    const placed = await placeTestFiles(fs, config, [], aliases, [changed], [], false, roomy);
    expect(placed.get(changed)).toEqual({ state: 'none' });
    // One step for each call and each test file it is tested against, at least.
    expect(roomy.placement.steps - roomy.placement.remaining).toBeGreaterThanOrEqual(2_000 * 50);

    const small = { ...runGlobBudgets(), placement: new GlobMatchBudget(1_000) };
    const spent = await placeTestFiles(fs, config, [], aliases, [changed], [], false, small);
    expect(small.placement.exhausted).toBe(true);
    expect(spent.get(changed)?.state).toBe('maybe');
  }, 120_000);
});

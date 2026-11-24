/**
 * Test-file placement tests every test file of the app against every import.meta.glob pattern, so
 * it carries a glob matching budget of its own, large enough for a normal large app. Calls written
 * in source code also have a character budget for the run. A test file a spent budget leaves
 * unplaced is a gap, never excluded.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Coverage, FsGlob, UsablConfig } from '../../src/contracts/index.js';
import { loadAppAliasConfig } from '../../src/coverage/alias-config.js';
import { runGlobBudgets } from '../../src/coverage/glob-budget.js';
import { computeCoverage } from '../../src/coverage/planner.js';
import { placeTestFiles } from '../../src/coverage/test-files.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { GlobMatchBudget } from '../../src/primitives/match-glob.js';

// Generous for a loaded machine. Before the budgets, each case took minutes.
const SMALL_TIME_MS = 20_000;

const fsOf = (files: Record<string, string>): FsGlob => makeFakeDeps({ files }).fs;

async function timed<T>(run: () => Promise<T> | T): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await run();
  return { value, ms: performance.now() - start };
}

// Each case runs a long stretch of matching. A turn of the event loop after it lets the test
// runner's messages through.
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

describe('test-file placement in a large app', () => {
  // A normal large app: many component folders, each with a test file, and one file with 40
  // import.meta.glob calls of three ordinary patterns each.
  function largeApp(folders: number): Record<string, string> {
    const calls = Array.from(
      { length: 40 },
      (_, index) =>
        `const g${String(index)} = import.meta.glob(['./**/feature${String(index)}/*.*', './**/locales${String(index)}/**', '/**/pages${String(index)}/*']);`,
    ).join('\n');
    const files: Record<string, string> = {
      'src/App.tsx': "import { ClustersPage } from './ClustersPage';\nexport function App() { return <ClustersPage />; }\n",
      'src/ClustersPage.tsx': `${calls}\nexport function ClustersPage() { return <main />; }\n`,
      'usabl.routes.json': `${JSON.stringify({ routes: [{ screenId: 'clusters', url: '/clusters', entryFile: 'src/ClustersPage.tsx' }] })}\n`,
    };
    for (let index = 0; index < folders; index += 1) {
      files[`${componentPath(index)}.tsx`] = 'export function C() { return <div />; }\n';
      files[`${componentPath(index)}.test.tsx`] = "test('c', () => {});\n";
    }
    return files;
  }
  // A component folder path of a usual depth, about 60 characters.
  const componentPath = (index: number): string =>
    `src/features/area${String(index % 50)}/components/widgets/Widget${String(index)}/Widget${String(index)}`;
  const config: UsablConfig = {
    appBaseUrl: 'http://127.0.0.1:5173',
    uiFileGlobs: ['src/**/*.tsx'],
    discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
    surfaces: [],
    guardedPaths: ['usabl.config.json', 'usabl.routes.json'],
  };

  it('excludes a changed test file no glob can load in an app of 5000 test files, with no budget gap', { timeout: 300_000 }, async () => {
    const changed = `${componentPath(0)}.test.tsx`;
    const coverage = await computeCoverage(fsOf(largeApp(5000)), config, [changed]);
    expect(coverage.gaps).toEqual([]);
    expect(coverage.nothingToCheck).toBe(true);
    expect((coverage.excludedFiles ?? []).map((entry) => entry.ref)).toEqual([changed]);
  });

  it('reads a test file as a gap once a placement budget runs out, never as excluded', { timeout: 120_000 }, async () => {
    const tree = largeApp(200);
    const fs = fsOf(tree);
    const changed = `${componentPath(0)}.test.tsx`;
    const budgets = { ...runGlobBudgets(), placement: new GlobMatchBudget(100_000) };
    const aliases = await loadAppAliasConfig(fs, 'src/App.tsx');
    const placements = await placeTestFiles(fs, config, ['src/ClustersPage.tsx'], aliases, [changed], [], false, budgets);
    expect(budgets.placement.exhausted).toBe(true);
    expect(placements.get(changed)?.state).toBe('maybe');
  });
});

describe('import.meta.glob calls in one planner run', () => {
  const BASE = 'http://127.0.0.1:5173';
  const SIDECAR = `${JSON.stringify({ routes: [{ screenId: 'clusters', url: '/clusters', entryFile: 'src/ClustersPage.tsx' }] })}\n`;
  const config: UsablConfig = {
    appBaseUrl: BASE,
    uiFileGlobs: ['src/**'],
    discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
    surfaces: [],
    guardedPaths: ['usabl.config.json', 'usabl.routes.json'],
  };
  // A changed test file 1990 folders deep, about 4000 characters.
  const DEEP_TEST = `src/tests/${'a/'.repeat(1990)}Widget.tsx`;
  const tree = (extra: Record<string, string>): Record<string, string> => ({
    'src/App.tsx': "import { ClustersPage } from './ClustersPage';\nexport function App() { return <ClustersPage />; }\n",
    'src/ClustersPage.tsx': 'export function ClustersPage() { return <main />; }\n',
    [DEEP_TEST]: 'export function Widget() { return <div />; }\n',
    'usabl.routes.json': SIDECAR,
    ...extra,
  });
  const call = (patterns: string[]): string => `const pages = import.meta.glob([${patterns.map((pattern) => `'${pattern}'`).join(', ')}]);\n`;

  function expectGapFor(coverage: Coverage, file: string, says: string): void {
    expect(coverage.nothingToCheck).toBe(false);
    const gap = coverage.gaps.find((candidate) => candidate.ref === file);
    expect(gap?.reason).toContain(says);
  }

  it('reads one call of 256 patterns of 1022 characters as one that may load the deep test file, quickly', { timeout: 300_000 }, async () => {
    const patterns = Array.from({ length: 256 }, (_, index) => `./${'**a'.repeat(338)}b${String(index)}**`);
    const fs = fsOf(tree({ 'src/ClustersPage.tsx': `${call(patterns)}export function ClustersPage() { return <main />; }\n` }));
    const { value: coverage, ms } = await timed(() => computeCoverage(fs, config, [DEEP_TEST]));
    expect(ms).toBeLessThan(SMALL_TIME_MS);
    expectGapFor(coverage, DEEP_TEST, 'budget of 65,536 characters');
  });

  it('reads 25 calls in one run against the budgets, and the deep test file is a gap, quickly', { timeout: 600_000 }, async () => {
    const pages: Record<string, string> = {};
    for (let page = 0; page < 25; page += 1) {
      // 60 patterns of about 1030 characters once resolved: the first call fits the character
      // budget and is matched against the deep file, and every call after it does not fit.
      const patterns = Array.from({ length: 60 }, (_, index) => `../${'**a'.repeat(337)}b${String(page)}x${String(index)}**`);
      pages[`src/pages/Page${String(page)}.tsx`] = `${call(patterns)}export function Page() { return <main />; }\n`;
    }
    const { value: coverage, ms } = await timed(() => computeCoverage(fsOf(tree(pages)), config, [DEEP_TEST]));
    // About 250 million placement steps, inside the placement budget.
    expect(ms).toBeLessThan(40_000);
    expectGapFor(coverage, DEEP_TEST, 'budget of 65,536 characters');
  });

  it('matches a pattern that starts with / against a file 1000 folders deep in one read, with the old answer', { timeout: 300_000 }, async () => {
    const rooted = `/${'**a'.repeat(338)}b**`;
    const deep = `src/tests/${'a/'.repeat(1000)}Widget.tsx`;
    const fs = fsOf({
      ...tree({ 'src/ClustersPage.tsx': `${call([rooted])}export function ClustersPage() { return <main />; }\n` }),
      [deep]: 'export function Widget() { return <div />; }\n',
    });
    const { value: coverage, ms } = await timed(() => computeCoverage(fs, config, [deep]));
    // Before, each tail of the path was matched on its own, which took about 17 seconds here.
    expect(ms).toBeLessThan(5_000);
    // No tail of the path holds a b, so the pattern loads nothing there, as before: the file is
    // excluded, with no budget spent past its bound.
    expect(coverage.gaps).toEqual([]);
    expect((coverage.excludedFiles ?? []).map((entry) => entry.ref)).toEqual([deep]);
  });
});

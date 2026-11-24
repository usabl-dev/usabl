/**
 * Glob matching in one planner run has a budget, so no input can make it outlast a Stop hook's
 * limit. Each match costs at most its pattern's length times its path's length, but a list inside
 * the policy bounds against long changed paths, or import.meta.glob calls written in source code,
 * could add up to minutes. A file usabl could not finish is a gap, never nothing to check.
 */
import { describe, expect, it } from 'vitest';
import type { Coverage, FsGlob, UsablConfig } from '../../src/contracts/index.js';
import type { DocsManifest } from '../../src/coverage/docs-manifest.js';
import { computeDocsCoverage } from '../../src/coverage/docs-planner.js';
import { computeCoverage } from '../../src/coverage/planner.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { checkGlobListBounds } from '../../src/intake/glob-list-bounds.js';

// Generous for a loaded machine. Before the budgets, each case took minutes.
const SMALL_TIME_MS = 20_000;

const fsOf = (files: Record<string, string>): FsGlob => makeFakeDeps({ files }).fs;

async function timed<T>(run: () => Promise<T> | T): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await run();
  return { value, ms: performance.now() - start };
}

// 256 entries of 1024 characters, inside every bound of a policy glob list. None matches a path
// of folders named a, and each costs its full length times the path's length to rule out.
const HEAVY_LIST = Array.from({ length: 256 }, (_, index) => `${'**a'.repeat(340).slice(0, 1020)}b${String(index % 10)}**`);
// 25 changed files of 3999 characters each.
const DEEP_FILES = Array.from({ length: 25 }, (_, index) => `${Array(1999).fill('a').join('/')}/${String(index % 10)}`);

function expectBudgetGaps(coverage: { nothingToCheck: boolean; gaps: { ref: string; reason: string }[] }, files: readonly string[]): void {
  expect(coverage.nothingToCheck).toBe(false);
  const refs = coverage.gaps.map((gap) => gap.ref);
  expect(refs.length).toBeGreaterThan(0);
  for (const gap of coverage.gaps) expect(gap.reason).toContain('glob matching steps');
  for (const ref of refs) expect(files).toContain(ref);
}

describe('the glob matching budget of a planner run', () => {
  it('reads changed files it could not test against a heavy uiFileGlobs list as gaps, quickly', { timeout: 120_000 }, async () => {
    expect(() => checkGlobListBounds(HEAVY_LIST, 'uiFileGlobs')).not.toThrow();
    const config: UsablConfig = {
      appBaseUrl: 'http://127.0.0.1:5173',
      uiFileGlobs: HEAVY_LIST,
      discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
      surfaces: [],
      guardedPaths: ['usabl.config.json'],
    };
    const { value: coverage, ms } = await timed(() => computeCoverage(fsOf({ 'src/App.tsx': '' }), config, DEEP_FILES));
    expect(ms).toBeLessThan(SMALL_TIME_MS);
    expectBudgetGaps(coverage, DEEP_FILES);
    // Every changed file is either tested and found outside the globs, or a gap. None is dropped.
    expect(coverage.unresolvedFiles.length).toBe(coverage.gaps.length);
  });

  it('reads changed docs files it could not test against heavy sharedGlobs as gaps, quickly', { timeout: 120_000 }, async () => {
    const manifest: DocsManifest = {
      format: 'asciidoc-modular',
      docsBaseUrl: 'http://127.0.0.1:8080',
      builtRoot: 'build',
      buildCommand: null,
      pages: [],
      sharedGlobs: HEAVY_LIST,
    };
    const { value: coverage, ms } = await timed(() => computeDocsCoverage(manifest, DEEP_FILES));
    expect(ms).toBeLessThan(SMALL_TIME_MS);
    expectBudgetGaps(coverage, DEEP_FILES);
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
      // budget, and matching it against the deep file uses up the steps.
      const patterns = Array.from({ length: 60 }, (_, index) => `../${'**a'.repeat(337)}b${String(page)}x${String(index)}**`);
      pages[`src/pages/Page${String(page)}.tsx`] = `${call(patterns)}export function Page() { return <main />; }\n`;
    }
    const { value: coverage, ms } = await timed(() => computeCoverage(fsOf(tree(pages)), config, [DEEP_TEST]));
    expect(ms).toBeLessThan(SMALL_TIME_MS);
    expectGapFor(coverage, DEEP_TEST, 'glob matching steps');
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

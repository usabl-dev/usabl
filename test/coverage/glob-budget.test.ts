/**
 * Glob matching in one planner run has a budget, so no input can make it outlast a Stop hook's
 * limit. Each match costs at most its pattern's length times its path's length, but a list inside
 * the policy bounds against long changed paths, or import.meta.glob calls written in source code,
 * could add up to minutes. A file usabl could not finish is a gap, never nothing to check.
 *
 * The cases pass a small budget and check the work by its steps, which are the same on every
 * machine, not by the clock. The real budget is the same rule at a larger size.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Coverage, FsGlob, UsablConfig } from '../../src/contracts/index.js';
import type { DocsManifest } from '../../src/coverage/docs-manifest.js';
import { computeDocsCoverage } from '../../src/coverage/docs-planner.js';
import { computeCoverage } from '../../src/coverage/planner.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { checkGlobListBounds } from '../../src/intake/glob-list-bounds.js';
import { runGlobBudgets, type RunGlobBudgets } from '../../src/coverage/glob-budget.js';
import { GlobMatchBudget } from '../../src/primitives/match-glob.js';

// A budget small enough that each case spends it in a moment.
const SMALL_STEPS = 2_000_000;

const fsOf = (files: Record<string, string>): FsGlob => makeFakeDeps({ files }).fs;

function smallBudgets(): RunGlobBudgets {
  return { ...runGlobBudgets(), steps: new GlobMatchBudget(SMALL_STEPS) };
}

// The steps a budget spent. A charge that runs a budget out can take it past its size by at most
// one match, which costs at most a pattern's length times a path's length.
function spent(budget: GlobMatchBudget): number {
  return budget.steps - budget.remaining;
}
const ONE_MATCH_AT_MOST = 1024 * 4000;

// Each case runs a long stretch of matching. A turn of the event loop after it lets the test
// runner's messages through.
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

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
    const budgets = smallBudgets();
    const coverage = await computeCoverage(fsOf({ 'src/App.tsx': '' }), config, DEEP_FILES, undefined, undefined, budgets);
    expect(budgets.steps.exhausted).toBe(true);
    expect(spent(budgets.steps)).toBeLessThanOrEqual(SMALL_STEPS + ONE_MATCH_AT_MOST);
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
    const budget = new GlobMatchBudget(SMALL_STEPS);
    const coverage = computeDocsCoverage(manifest, DEEP_FILES, budget);
    expect(budget.exhausted).toBe(true);
    expect(spent(budget)).toBeLessThanOrEqual(SMALL_STEPS + ONE_MATCH_AT_MOST);
    expectBudgetGaps(coverage, DEEP_FILES);
  });
});

// The parts of a Coverage that must not depend on the order of the changed files, each sorted.
function orderFree(coverage: Pick<Coverage, 'nothingToCheck' | 'affected' | 'unresolvedFiles' | 'gaps'>): unknown {
  return {
    nothingToCheck: coverage.nothingToCheck,
    affected: coverage.affected.map((screen) => screen.screenId).sort(),
    unresolvedFiles: [...coverage.unresolvedFiles].sort(),
    gaps: coverage.gaps.map((gap) => `${gap.ref}\u0000${gap.reason}`).sort(),
  };
}

describe('the budget gives the same answer for the same changed files in any order', () => {
  it('runs out at the same file whatever order the caller lists them in', { timeout: 120_000 }, async () => {
    const config: UsablConfig = {
      appBaseUrl: 'http://127.0.0.1:5173',
      uiFileGlobs: ['src/**', ...HEAVY_LIST.slice(0, 255)],
      discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
      surfaces: [],
      guardedPaths: ['usabl.config.json', 'usabl.routes.json'],
    };
    const files = {
      'src/App.tsx': "import { ClustersPage } from './ClustersPage';\nexport function App() { return <ClustersPage />; }\n",
      'src/ClustersPage.tsx': 'export function ClustersPage() { return <main />; }\n',
      'usabl.routes.json': `${JSON.stringify({ routes: [{ screenId: 'clusters', url: '/clusters', entryFile: 'src/ClustersPage.tsx' }] })}\n`,
    };
    const changed = [...DEEP_FILES.slice(0, 6), 'src/ClustersPage.tsx'];
    const forward = await computeCoverage(fsOf(files), config, changed, undefined, undefined, smallBudgets());
    const backward = await computeCoverage(fsOf(files), config, [...changed].reverse(), undefined, undefined, smallBudgets());
    expect(forward.nothingToCheck).toBe(false);
    expect(orderFree(backward)).toEqual(orderFree(forward));
  });

  it('runs out at the same docs file whatever order the caller lists them in', { timeout: 120_000 }, () => {
    const manifest: DocsManifest = {
      format: 'asciidoc-modular',
      docsBaseUrl: 'http://127.0.0.1:8080',
      builtRoot: 'build',
      buildCommand: null,
      pages: [{ pageId: 'guide', url: '/guide.html', assemblyFile: 'guide.adoc', sources: ['modules/guide.adoc'] }],
      sharedGlobs: HEAVY_LIST,
    };
    const docsChanged = [...DEEP_FILES.slice(0, 6), 'modules/guide.adoc'];
    const docsForward = computeDocsCoverage(manifest, docsChanged, new GlobMatchBudget(SMALL_STEPS));
    const docsBackward = computeDocsCoverage(manifest, [...docsChanged].reverse(), new GlobMatchBudget(SMALL_STEPS));
    expect(orderFree(docsBackward)).toEqual(orderFree(docsForward));
  });
});

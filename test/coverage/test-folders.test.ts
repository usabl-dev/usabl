/**
 * Files under a folder named test, tests, or __tests__.
 *
 * Such a folder usually holds test helpers, so its files are not UI files by default. But a real
 * screen component can live there too, and dropping it before the glob match read its change as
 * nothing to check. A file in a test folder now counts as a UI file when the import graph reaches
 * it from a screen. A file there that no screen reaches is disclosed as excluded: it is not a gap,
 * so a pull request that edits only test helpers still has nothing to check. Files named
 * `*.test.*` or `*.spec.*` stay excluded wherever they are.
 */
import { describe, expect, it } from 'vitest';
import type { UsablConfig } from '../../src/contracts/index.js';
import { computeCoverage } from '../../src/coverage/planner.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { formatSummary } from '../../src/output/summary.js';
import { run } from '../../src/run.js';

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: ['usabl.config.json', 'usabl.routes.json'],
};

const SCREEN_IN_TESTS = 'src/tests/Dashboard.tsx';
const HELPERS = ['src/test/setup.ts', 'src/__tests__/utils.tsx', 'src/test/mocks/handlers.ts'];

const files: Record<string, string> = {
  'usabl.config.json': `${JSON.stringify(config)}\n`,
  'usabl.routes.json': `${JSON.stringify({
    routes: [{ screenId: 'home', url: '/', entryFile: 'src/pages/Home.tsx' }],
  })}\n`,
  'src/pages/Home.tsx': "import { Dashboard } from '../tests/Dashboard'\nexport function Home() { return <Dashboard /> }\n",
  [SCREEN_IN_TESTS]: 'export function Dashboard() { return <main /> }\n',
  'src/test/setup.ts': "import '@testing-library/jest-dom'\n",
  'src/__tests__/utils.tsx': "import { render } from '@testing-library/react'\nexport const renderPage = render\n",
  'src/test/mocks/handlers.ts': "import { http } from 'msw'\nexport const handlers = [http.get('/api', () => null)]\n",
  'src/pages/Home.test.tsx': "import { Home } from './Home'\n",
  'src/tests/Dashboard.spec.tsx': "import { Dashboard } from './Dashboard'\n",
};

function deps(scanned: string[] = []) {
  const fake = makeFakeDeps({ files, headContents: files });
  return {
    ...fake,
    checkRunner: {
      scan: async (screen: { id: string; url: string }) => {
        scanned.push(screen.id);
        return fake.checkRunner.scan(screen);
      },
    },
  };
}

describe('a changed file under a test folder', () => {
  it('is a UI file when a screen imports it', async () => {
    const coverage = await computeCoverage(deps().fs, config, [SCREEN_IN_TESTS]);
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.affected.map((screen) => screen.screenId)).toEqual(['home']);
    expect(coverage.gaps).toEqual([]);
    expect(coverage.excludedFiles ?? []).toEqual([]);
  });

  it('is scanned by a run when a screen imports it', async () => {
    const scanned: string[] = [];
    const result = await run(deps(scanned), config, { changedFiles: [SCREEN_IN_TESTS] });
    expect(result.coverage.nothingToCheck).toBe(false);
    expect(scanned).toEqual(['home']);
  });

  it('is nothing to check, and disclosed as excluded, when no screen imports it', async () => {
    const coverage = await computeCoverage(deps().fs, config, HELPERS);
    expect(coverage.nothingToCheck).toBe(true);
    expect(coverage.gaps).toEqual([]);
    expect(coverage.unresolvedFiles).toEqual([]);
    expect((coverage.excludedFiles ?? []).map((entry) => entry.ref)).toEqual([...HELPERS].sort());
    for (const entry of coverage.excludedFiles ?? []) {
      expect(entry.reason).toMatch(/test folder/);
      expect(entry.reason).toMatch(/no screen imports it/);
    }
  });

  it('is disclosed by a run that has nothing to check, without blocking it', async () => {
    const scanned: string[] = [];
    const result = await run(deps(scanned), config, { changedFiles: HELPERS });
    expect(result.coverage.nothingToCheck).toBe(true);
    expect(result.verdict).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(scanned).toEqual([]);
    expect((result.coverage.excludedFiles ?? []).map((entry) => entry.ref)).toEqual([...HELPERS].sort());
    const text = formatSummary(result);
    expect(text).toContain('excluded files, not checked: 3 (disclosed, does not block)');
    expect(text).toContain('why: This file is in a test folder');
    for (const helper of HELPERS) {
      expect(text).toContain(helper);
    }
  });

  it('is disclosed beside a scan of the screen a reached file renders', async () => {
    const coverage = await computeCoverage(deps().fs, config, [SCREEN_IN_TESTS, 'src/test/setup.ts']);
    expect(coverage.affected.map((screen) => screen.screenId)).toEqual(['home']);
    expect((coverage.excludedFiles ?? []).map((entry) => entry.ref)).toEqual(['src/test/setup.ts']);
  });

  it('is a UI file when a surface lists it', async () => {
    const withSurface: UsablConfig = {
      ...config,
      surfaces: [{ id: 'mock-page', url: 'http://127.0.0.1:5173/mock', files: ['src/test/mocks/handlers.ts'] }],
    };
    const coverage = await computeCoverage(deps().fs, withSurface, ['src/test/mocks/handlers.ts']);
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.affected.map((screen) => screen.screenId)).toEqual(['mock-page']);
    expect(coverage.excludedFiles ?? []).toEqual([]);
  });
});

describe('a changed test or spec file', () => {
  it('stays excluded wherever it is, even beside a screen that imports its folder', async () => {
    const coverage = await computeCoverage(deps().fs, config, ['src/pages/Home.test.tsx', 'src/tests/Dashboard.spec.tsx']);
    expect(coverage.nothingToCheck).toBe(true);
    expect(coverage.gaps).toEqual([]);
    expect(coverage.excludedFiles ?? []).toEqual([]);
  });
});

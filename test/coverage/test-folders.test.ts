/**
 * Files under a folder named test, tests, or __tests__.
 *
 * Such a folder usually holds test helpers, so its files are not UI files by default. But a real
 * screen component can live there too, and dropping it before the glob match read its change as
 * nothing to check. A file in a test folder now counts as a UI file when the import graph reaches
 * it from a screen. A file there that no screen reaches is disclosed as excluded: it is not a gap,
 * so a pull request that edits only test helpers still has nothing to check. Files named
 * `*.test.*` or `*.spec.*` follow the same rule, in test-files.test.ts.
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
      expect(entry.reason).toMatch(/usabl found no import of it/);
      expect(entry.reason).not.toMatch(/no screen imports it/);
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
  it('is excluded and listed when only other test files import it, even beside a screen that imports its folder', async () => {
    const coverage = await computeCoverage(deps().fs, config, ['src/pages/Home.test.tsx', 'src/tests/Dashboard.spec.tsx']);
    expect(coverage.nothingToCheck).toBe(true);
    expect(coverage.gaps).toEqual([]);
    expect((coverage.excludedFiles ?? []).map((entry) => entry.ref)).toEqual(['src/pages/Home.test.tsx', 'src/tests/Dashboard.spec.tsx']);
    for (const entry of coverage.excludedFiles ?? []) {
      expect(entry.reason).toMatch(/named like a test/);
    }
  });
});

// usabl reads "no screen reaches it" from the import graph. When the graph holds an import it could
// not resolve, and that import names the file, a screen may load the file after all. That is a
// guess usabl cannot check, so the file is a gap that names the import, never excluded.
describe('a changed file under a test folder that an unresolved import may reach', () => {
  const routes = `${JSON.stringify({ routes: [{ screenId: 'home', url: '/', entryFile: 'src/pages/Home.tsx' }] })}\n`;
  const treeWith = (home: string, extra: Record<string, string>): Record<string, string> => ({
    'usabl.config.json': `${JSON.stringify(config)}\n`,
    'usabl.routes.json': routes,
    'src/pages/Home.tsx': home,
    ...extra,
  });
  const depsOf = (tree: Record<string, string>) => makeFakeDeps({ files: tree, headContents: tree });
  const aliasHome = "import { Dashboard } from '@/tests/Dashboard'\nexport function Home() { return <Dashboard /> }\n";

  it('is an unresolved gap that names the import and the file that holds it', async () => {
    const tree = treeWith(aliasHome, { [SCREEN_IN_TESTS]: 'export function Dashboard() { return <main /> }\n' });
    const coverage = await computeCoverage(depsOf(tree).fs, config, [SCREEN_IN_TESTS]);
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.excludedFiles ?? []).toEqual([]);
    expect(coverage.unresolvedFiles).toEqual([SCREEN_IN_TESTS]);
    expect(coverage.gaps).toHaveLength(1);
    expect(coverage.gaps[0]?.ref).toBe(SCREEN_IN_TESTS);
    expect(coverage.gaps[0]?.state).toBe('unresolved');
    expect(coverage.gaps[0]?.reason).toContain("'@/tests/Dashboard'");
    expect(coverage.gaps[0]?.reason).toContain('src/pages/Home.tsx');
  });

  it('is not covered in a run, never nothing to check', async () => {
    const tree = treeWith(aliasHome, { [SCREEN_IN_TESTS]: 'export function Dashboard() { return <main /> }\n' });
    const result = await run(depsOf(tree), config, { changedFiles: [SCREEN_IN_TESTS] });
    expect(result.coverage.nothingToCheck).toBe(false);
    expect(result.verdict).toBe('not_covered');
  });

  it('is a gap for an index file when the import names its folder', async () => {
    const indexFile = 'src/tests/Dashboard/index.tsx';
    const tree = treeWith(aliasHome, { [indexFile]: 'export function Dashboard() { return <main /> }\n' });
    const coverage = await computeCoverage(depsOf(tree).fs, config, [indexFile]);
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.unresolvedFiles).toEqual([indexFile]);
    expect(coverage.excludedFiles ?? []).toEqual([]);
  });

  // An import can name an index file in more than one way. Each form below loads the same file, so
  // each is read the same way: the file is a gap, and a run is not covered, never nothing to check.
  const indexFile = 'src/tests/Dashboard/index.tsx';
  const indexForms = [
    '@/tests/Dashboard',
    '@/tests/Dashboard/index',
    '@/tests/Dashboard/index.tsx',
    '@/tests/Dashboard/',
    '@/tests/Dashboard/index.js',
    '@/tests/Dashboard/index?raw',
    '@/tests/Dashboard//',
    '@/tests/Dashboard/./index',
    '@/tests/Dashboard/view/..',
    '../tests/Dashboard/',
    '#tests/Dashboard/index',
  ];
  for (const form of indexForms) {
    it(`is a gap for an index file imported as '${form}', and a run is not covered`, async () => {
      const home = `import { Dashboard } from '${form}'\nexport function Home() { return <Dashboard /> }\n`;
      const tree = treeWith(home, { [indexFile]: 'export function Dashboard() { return <main /> }\n' });
      const coverage = await computeCoverage(depsOf(tree).fs, config, [indexFile]);
      expect(coverage.nothingToCheck).toBe(false);
      expect(coverage.unresolvedFiles).toEqual([indexFile]);
      expect(coverage.excludedFiles ?? []).toEqual([]);
      const result = await run(depsOf(tree), config, { changedFiles: [indexFile] });
      expect(result.coverage.nothingToCheck).toBe(false);
      expect(result.verdict).toBe('not_covered');
    });
  }

  // A disk that ignores letter case, as on macOS and Windows, loads Dashboard.tsx for an import of
  // dashboard. usabl cannot tell which disk the build uses, so the file is a gap.
  it('is a gap when the import names the file in other letter case', async () => {
    const home = "import { Dashboard } from '@/tests/dashboard'\nexport function Home() { return <Dashboard /> }\n";
    const tree = treeWith(home, { [SCREEN_IN_TESTS]: 'export function Dashboard() { return <main /> }\n' });
    const coverage = await computeCoverage(depsOf(tree).fs, config, [SCREEN_IN_TESTS]);
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.unresolvedFiles).toEqual([SCREEN_IN_TESTS]);
  });

  for (const form of ['@/tests/Dashboard', '@/tests/Dashboard/Index']) {
    it(`is a gap for an index file named in other letter case, imported as '${form}'`, async () => {
      const upperIndex = 'src/tests/Dashboard/Index.tsx';
      const home = `import { Dashboard } from '${form}'\nexport function Home() { return <Dashboard /> }\n`;
      const tree = treeWith(home, { [upperIndex]: 'export function Dashboard() { return <main /> }\n' });
      const coverage = await computeCoverage(depsOf(tree).fs, config, [upperIndex]);
      expect(coverage.nothingToCheck).toBe(false);
      expect(coverage.unresolvedFiles).toEqual([upperIndex]);
    });
  }

  // An import of an alias root, such as '@/', names a folder usabl cannot read by name. It may load
  // any file, so a file in a test folder is a gap while it stands.
  for (const form of ['@/', '~/', '@/index']) {
    it(`is a gap when an unresolved import names only the alias root '${form}'`, async () => {
      const home = `import { Dashboard } from '${form}'\nexport function Home() { return <Dashboard /> }\n`;
      const tree = treeWith(home, { [SCREEN_IN_TESTS]: 'export function Dashboard() { return <main /> }\n' });
      const coverage = await computeCoverage(depsOf(tree).fs, config, [SCREEN_IN_TESTS]);
      expect(coverage.nothingToCheck).toBe(false);
      expect(coverage.unresolvedFiles).toEqual([SCREEN_IN_TESTS]);
    });
  }

  // A # specifier with no slash is a whole key of a package.json imports map. usabl reads it by its
  // name without the #, as it reads a bare alias key.
  it('is a gap when an unresolved whole imports key names the file', async () => {
    const home = "import { Dashboard } from '#dashboard'\nexport function Home() { return <Dashboard /> }\n";
    const tree = treeWith(home, { [SCREEN_IN_TESTS]: 'export function Dashboard() { return <main /> }\n' });
    const coverage = await computeCoverage(depsOf(tree).fs, config, [SCREEN_IN_TESTS]);
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.unresolvedFiles).toEqual([SCREEN_IN_TESTS]);
  });

  // A bundler loads a folder through the main field of a package.json in it, and that field can name
  // any file in the folder. So an import that names the folder may load each file below it.
  for (const form of ['@/tests/Dashboard', '../tests/Dashboard']) {
    it(`is a gap for a file in a folder with a package.json that '${form}' names`, async () => {
      const viewFile = 'src/tests/Dashboard/view.tsx';
      const home = `import { Dashboard } from '${form}'\nexport function Home() { return <Dashboard /> }\n`;
      const tree = treeWith(home, {
        [viewFile]: 'export function Dashboard() { return <main /> }\n',
        'src/tests/Dashboard/package.json': '{"main":"view.tsx"}\n',
      });
      const coverage = await computeCoverage(depsOf(tree).fs, config, [viewFile]);
      expect(coverage.nothingToCheck).toBe(false);
      expect(coverage.unresolvedFiles).toEqual([viewFile]);
      expect(coverage.excludedFiles ?? []).toEqual([]);
    });
  }

  // A file named Index.tsx keeps its own name, Index, as before, as well as its folder name. An
  // alias usabl cannot read, such as @dash for src/tests/Dashboard, loads it as @dash/Index.
  const screenCases: Array<[string, string]> = [
    ['src/tests/Dashboard/Index.tsx', '@dash/Index'],
    ['src/tests/Dashboard/Index.tsx', '~dash/Index'],
    ['src/tests/Index.tsx', '$t/Index'],
    // The import names an index file with an extension the resolver does not list, or in capitals.
    ['src/tests/Dashboard/index.mdx', '@/tests/Dashboard/index.mdx'],
    ['src/tests/Dashboard/index.astro', '@/tests/Dashboard/index.astro'],
    ['src/tests/Dashboard/index.cts', '@/tests/Dashboard/index.cts'],
    ['src/tests/Dashboard/index.tsx', '@/tests/Dashboard/index.TSX'],
    // An alias key with a leading sign, such as @tests for src/tests, names the folder without it.
    ['src/tests/index.tsx', '@tests/index'],
    ['src/tests/index.tsx', '@tests'],
    ['src/tests/index.tsx', '~tests/'],
    ['src/tests/index.tsx', '#tests'],
  ];
  for (const [screen, form] of screenCases) {
    it(`is a gap for ${screen} imported as '${form}'`, async () => {
      const home = `import { Dashboard } from '${form}'\nexport function Home() { return <Dashboard /> }\n`;
      const tree = treeWith(home, { [screen]: 'export function Dashboard() { return <main /> }\n' });
      const coverage = await computeCoverage(depsOf(tree).fs, config, [screen]);
      expect(coverage.nothingToCheck).toBe(false);
      expect(coverage.unresolvedFiles).toEqual([screen]);
      expect(coverage.excludedFiles ?? []).toEqual([]);
    });
  }

  // A Nuxt app imports virtual modules such as #app and #imports. Each is read by its name, so it
  // does not make every test file a gap.
  for (const [file, form] of [
    ['src/test/setup.ts', '#app'],
    ['src/test/setup.ts', '#imports'],
    ['src/pages/Home.spec.tsx', '#app'],
  ] as const) {
    it(`keeps ${file} excluded beside an unresolved import of '${form}'`, async () => {
      const home = `import { defineNuxtPlugin } from '${form}'\nexport function Home() { return <main /> }\n`;
      const tree = treeWith(home, { [file]: "import '@testing-library/jest-dom'\n" });
      const coverage = await computeCoverage(depsOf(tree).fs, config, [file]);
      expect(coverage.nothingToCheck).toBe(true);
      expect(coverage.gaps).toEqual([]);
      expect((coverage.excludedFiles ?? []).map((entry) => entry.ref)).toEqual([file]);
    });
  }

  // The main or exports field of a folder's package.json can name a file outside the folder. An
  // import that names the folder may load that file too.
  for (const main of ['../Screens/view.tsx', '../Screens/view', './../Screens']) {
    it(`is a gap for the file a folder's main field '${main}' names outside the folder`, async () => {
      const screen = main === './../Screens' ? 'src/tests/Screens/index.tsx' : 'src/tests/Screens/view.tsx';
      const tree = treeWith(aliasHome, {
        [screen]: 'export function Dashboard() { return <main /> }\n',
        'src/tests/Dashboard/package.json': `${JSON.stringify({ main })}\n`,
      });
      const coverage = await computeCoverage(depsOf(tree).fs, config, [screen]);
      expect(coverage.nothingToCheck).toBe(false);
      expect(coverage.unresolvedFiles).toEqual([screen]);
    });
  }

  it("is a gap for the file a folder's exports field names outside the folder", async () => {
    const screen = 'src/tests/Screens/view.tsx';
    const tree = treeWith(aliasHome, {
      [screen]: 'export function Dashboard() { return <main /> }\n',
      'src/tests/Dashboard/package.json': `${JSON.stringify({ exports: { '.': { import: '../Screens/view.tsx' } } })}\n`,
    });
    const coverage = await computeCoverage(depsOf(tree).fs, config, [screen]);
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.unresolvedFiles).toEqual([screen]);
  });

  // A package.json nested deeper than usabl reads is a folder that may load any file. It is a gap,
  // never a crash of the run.
  const deepExports: Array<[string, string]> = [
    ['arrays 200000 deep', `{"exports":${'['.repeat(200000)}"./x.tsx"${']'.repeat(200000)}}`],
    ['objects 50000 deep', `{"exports":${'{"a":'.repeat(50000)}"./x.tsx"${'}'.repeat(50000)}}`],
  ];
  for (const [label, manifest] of deepExports) {
    it(`is a gap, not a crash, when a folder's exports field is nested ${label}`, async () => {
      const screen = 'src/tests/Screens/view.tsx';
      const tree = treeWith(aliasHome, {
        [screen]: 'export function Dashboard() { return <main /> }\n',
        'src/tests/Dashboard/package.json': `${manifest}\n`,
      });
      const coverage = await computeCoverage(depsOf(tree).fs, config, [screen]);
      expect(coverage.nothingToCheck).toBe(false);
      expect(coverage.unresolvedFiles).toEqual([screen]);
      const result = await run(depsOf(tree), config, { changedFiles: [screen] });
      expect(result.verdict).toBe('not_covered');
    });
  }

  it("keeps a file excluded that a folder's exports map does not name", async () => {
    const helper = 'src/tests/Screens/helper.ts';
    const exportsMap = { '.': { import: './esm/index.js', require: './cjs/index.cjs' }, './view': ['../Screens/view.tsx'] };
    const tree = treeWith(aliasHome, {
      [helper]: 'export const helper = 1;\n',
      'src/tests/Screens/view.tsx': 'export function Dashboard() { return <main /> }\n',
      'src/tests/Dashboard/package.json': `${JSON.stringify({ exports: exportsMap })}\n`,
    });
    const coverage = await computeCoverage(depsOf(tree).fs, config, [helper]);
    expect(coverage.nothingToCheck).toBe(true);
    expect((coverage.excludedFiles ?? []).map((entry) => entry.ref)).toEqual([helper]);
    const named = await computeCoverage(depsOf(tree).fs, config, ['src/tests/Screens/view.tsx']);
    expect(named.unresolvedFiles).toEqual(['src/tests/Screens/view.tsx']);
  });

  it("keeps a file excluded that a folder's main field does not name", async () => {
    const helper = 'src/tests/Screens/helper.ts';
    const tree = treeWith(aliasHome, {
      [helper]: 'export const helper = 1;\n',
      'src/tests/Screens/view.tsx': 'export function Dashboard() { return <main /> }\n',
      'src/tests/Dashboard/package.json': `${JSON.stringify({ main: '../Screens/view.tsx' })}\n`,
    });
    const coverage = await computeCoverage(depsOf(tree).fs, config, [helper]);
    expect(coverage.nothingToCheck).toBe(true);
    expect((coverage.excludedFiles ?? []).map((entry) => entry.ref)).toEqual([helper]);
  });

  it('keeps a file excluded in a folder of that name with no package.json', async () => {
    const viewFile = 'src/tests/Dashboard/view.tsx';
    const tree = treeWith(aliasHome, { [viewFile]: 'export function Dashboard() { return <main /> }\n' });
    const coverage = await computeCoverage(depsOf(tree).fs, config, [viewFile]);
    expect(coverage.nothingToCheck).toBe(true);
    expect((coverage.excludedFiles ?? []).map((entry) => entry.ref)).toEqual([viewFile]);
  });

  it('keeps a helper no import names excluded beside an unresolved import of an index file', async () => {
    const home = "import { Dashboard } from '@/tests/Dashboard/index'\nexport function Home() { return <Dashboard /> }\n";
    const tree = treeWith(home, {
      [indexFile]: 'export function Dashboard() { return <main /> }\n',
      'src/test/setup.ts': "import '@testing-library/jest-dom'\n",
    });
    const coverage = await computeCoverage(depsOf(tree).fs, config, ['src/test/setup.ts']);
    expect(coverage.nothingToCheck).toBe(true);
    expect(coverage.gaps).toEqual([]);
    expect((coverage.excludedFiles ?? []).map((entry) => entry.ref)).toEqual(['src/test/setup.ts']);
  });

  it('stays excluded when the unresolved import names another file', async () => {
    const home = "import { Card } from '@/widgets/Card'\nexport function Home() { return <Card /> }\n";
    const tree = treeWith(home, { 'src/test/setup.ts': "import '@testing-library/jest-dom'\n" });
    const coverage = await computeCoverage(depsOf(tree).fs, config, ['src/test/setup.ts']);
    expect(coverage.nothingToCheck).toBe(true);
    expect(coverage.gaps).toEqual([]);
    expect((coverage.excludedFiles ?? []).map((entry) => entry.ref)).toEqual(['src/test/setup.ts']);
    expect(coverage.excludedFiles?.[0]?.reason).toMatch(/usabl found no import of it/);
  });

  // A dynamic import built from a template literal may load any file under its fixed start, here
  // src/tests/. usabl cannot tell which, so the file is a gap that names the import.
  it('is an unresolved gap when a template-literal dynamic import may load it', async () => {
    const home = 'export async function load(name: string) { return import(`../tests/${name}`) }\n';
    const tree = treeWith(home, { [SCREEN_IN_TESTS]: 'export function Dashboard() { return <main /> }\n' });
    const coverage = await computeCoverage(depsOf(tree).fs, config, [SCREEN_IN_TESTS]);
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.excludedFiles ?? []).toEqual([]);
    expect(coverage.gaps.map((gap) => [gap.ref, gap.state])).toEqual([[SCREEN_IN_TESTS, 'unresolved']]);
    expect(coverage.gaps[0]?.reason).toContain('src/pages/Home.tsx');
    expect(coverage.gaps[0]?.reason).toContain('src/tests/');
  });
});

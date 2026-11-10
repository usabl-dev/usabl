/**
 * Changed files that are named like a test (`*.test.*`, `*.spec.*`) or sit in a test folder
 * (`test`, `tests`, `__tests__`).
 *
 * Such a file is excluded only when usabl has looked at every place that could load it and found
 * none. It is a UI file when a surface lists it, a route closure reaches it, or any file outside
 * the tests imports it, directly or through other files. It is an unresolved gap when an import
 * usabl cannot follow may load it: an unresolved import that names it, an `import.meta.glob`
 * pattern that matches it, a dynamic import whose path is built at run time, or a bare import a
 * tsconfig baseUrl resolves to it. Only then is it excluded, and it is listed with a reason.
 */
import { describe, expect, it } from 'vitest';
import type { FsGlob, UsablConfig } from '../../src/contracts/index.js';
import { computeCoverage } from '../../src/coverage/planner.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { makeFsGlob } from '../../src/deps/fs.js';
import { run } from '../../src/run.js';

const BASE = 'http://127.0.0.1:5173';
const WIDGET = 'export function Widget() { return <div onClick={() => 0}>open</div>; }\n';
const ROUTER =
  "import { Route, Routes } from 'react-router-dom';\n" +
  "import { ClustersPage } from './ClustersPage';\n" +
  'export function App() { return (<Routes><Route path="/clusters" element={<ClustersPage />} /></Routes>); }\n';

const config: UsablConfig = {
  appBaseUrl: BASE,
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: ['usabl.config.json', 'usabl.routes.json'],
};

const SIDECAR = `${JSON.stringify({ routes: [{ screenId: 'clusters', url: '/clusters', entryFile: 'src/ClustersPage.tsx' }] })}\n`;

const fsOf = (files: Record<string, string>): FsGlob => makeFakeDeps({ files }).fs;

// A reader that records every path read and every glob asked for, so a test can see what the
// planner looked at.
function countingFs(files: Record<string, string>): { fs: FsGlob; reads: string[]; globs: string[][] } {
  const inner = fsOf(files);
  const reads: string[] = [];
  const globs: string[][] = [];
  return {
    reads,
    globs,
    fs: {
      readFile: async (path) => {
        reads.push(path);
        return inner.readFile(path);
      },
      glob: async (patterns) => {
        globs.push([...patterns]);
        return inner.glob(patterns);
      },
    },
  };
}

describe('a file named like a test that a screen loads', () => {
  // The screen imports a component from ./Widget.spec, and its surface lists both files.
  const files: Record<string, string> = {
    'src/App.tsx': ROUTER,
    'src/ClustersPage.tsx': "import { Widget } from './Widget.spec';\nexport function ClustersPage() { return <main><Widget /></main>; }\n",
    'src/Widget.spec.tsx': WIDGET,
  };
  const surfaceConfig: UsablConfig = {
    ...config,
    surfaces: [
      { id: 'clusters', url: `${BASE}/clusters`, files: ['src/ClustersPage.tsx', 'src/Widget.spec.tsx'], overridesDiscoveredRoute: true },
    ],
  };

  it('is planned on the surface that lists it when only that file changed', async () => {
    const coverage = await computeCoverage(fsOf(files), surfaceConfig, ['src/Widget.spec.tsx']);
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.affected.map((screen) => screen.screenId)).toEqual(['clusters']);
    expect(coverage.gaps).toEqual([]);
    expect(coverage.excludedFiles ?? []).toEqual([]);
  });

  it('is mapped by the route closure that imports it by its extensionless name', async () => {
    const tree = { ...files, 'usabl.routes.json': SIDECAR };
    const coverage = await computeCoverage(fsOf(tree), config, ['src/Widget.spec.tsx']);
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.affected.map((screen) => [screen.screenId, screen.provenance])).toEqual([['clusters', 'route-graph']]);
    expect(coverage.gaps).toEqual([]);
  });

  it('is a UI file when a screen imports it and no route has an entry file', async () => {
    const coverage = await computeCoverage(fsOf(files), config, ['src/Widget.spec.tsx']);
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.excludedFiles ?? []).toEqual([]);
    expect(coverage.unresolvedFiles).toEqual(['src/Widget.spec.tsx']);
    expect(coverage.gaps[0]?.reason).toMatch(/^This UI file is not in any route closure/);
  });
});

describe('a file in a test folder with router fallback routes', () => {
  // The router fallback finds /clusters with no entry file, so there is no route closure at all.
  const files: Record<string, string> = {
    'src/App.tsx': ROUTER,
    'src/ClustersPage.tsx': "import { Widget } from './tests/Widget';\nexport function ClustersPage() { return <main><Widget /></main>; }\n",
    'src/tests/Widget.tsx': WIDGET,
  };
  const surfaceConfig: UsablConfig = {
    ...config,
    surfaces: [{ id: 'clusters', url: `${BASE}/clusters`, files: ['src/ClustersPage.tsx'], overridesDiscoveredRoute: true }],
  };

  it('is a UI file when a screen imports it with a relative import', async () => {
    const coverage = await computeCoverage(fsOf(files), surfaceConfig, ['src/tests/Widget.tsx']);
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.excludedFiles ?? []).toEqual([]);
    expect(coverage.unresolvedFiles).toEqual(['src/tests/Widget.tsx']);
    expect(coverage.gaps.map((gap) => gap.state)).toEqual(['unresolved']);
    expect(coverage.gaps[0]?.reason).toMatch(/^This UI file is not in any route closure/);
  });

  it('is not covered in a run, never nothing to check', async () => {
    const tree = { ...files, 'usabl.config.json': `${JSON.stringify(surfaceConfig)}\n` };
    const result = await run(makeFakeDeps({ files: tree, headContents: tree }), surfaceConfig, { changedFiles: ['src/tests/Widget.tsx'] });
    expect(result.coverage.nothingToCheck).toBe(false);
    expect(result.verdict).toBe('not_covered');
  });
});

describe('a file in a test folder that a screen loads in a way usabl cannot follow', () => {
  // A routes sidecar names the entry file, and tsconfig sets baseUrl to src.
  const treeFor = (screen: string): Record<string, string> => ({
    'src/App.tsx': ROUTER,
    'src/ClustersPage.tsx': screen,
    'src/tests/Widget.tsx': WIDGET,
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: 'src' } }),
    'usabl.routes.json': SIDECAR,
  });
  const changed = ['src/tests/Widget.tsx'];

  it('is mapped by the route closure when the screen imports it with a relative import', async () => {
    const tree = treeFor("import { Widget } from './tests/Widget';\nexport function ClustersPage() { return <main><Widget /></main>; }\n");
    const coverage = await computeCoverage(fsOf(tree), config, changed);
    expect(coverage.affected.map((screen) => screen.screenId)).toEqual(['clusters']);
    expect(coverage.gaps).toEqual([]);
  });

  it('is an unresolved gap when an import.meta.glob pattern matches it', async () => {
    const tree = treeFor(
      "const mods = import.meta.glob('./tests/*.tsx', { eager: true });\nexport function ClustersPage() { return <main>{Object.keys(mods).length}</main>; }\n",
    );
    const coverage = await computeCoverage(fsOf(tree), config, changed);
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.excludedFiles ?? []).toEqual([]);
    expect(coverage.unresolvedFiles).toEqual(changed);
    expect(coverage.gaps).toHaveLength(1);
    expect(coverage.gaps[0]?.state).toBe('unresolved');
    expect(coverage.gaps[0]?.reason).toContain('src/ClustersPage.tsx');
    expect(coverage.gaps[0]?.reason).toContain('import.meta.glob');
    expect(coverage.gaps[0]?.reason).toContain('src/tests/*.tsx');
    expect(coverage.gaps[0]?.reason).toContain('list the file in the files of a surface');
    expect(coverage.gaps[0]?.reason).toContain('plain import');
  });

  it('is an unresolved gap when a template-literal dynamic import may load it', async () => {
    const tree = treeFor(
      "const name = 'Widget';\nconst W = React.lazy(() => import(`./tests/${name}`));\nexport function ClustersPage() { return <main><W /></main>; }\n",
    );
    const coverage = await computeCoverage(fsOf(tree), config, changed);
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.excludedFiles ?? []).toEqual([]);
    expect(coverage.gaps.map((gap) => gap.state)).toEqual(['unresolved']);
    expect(coverage.gaps[0]?.reason).toContain('src/ClustersPage.tsx');
    expect(coverage.gaps[0]?.reason).toContain('src/tests/');
  });

  it('is an unresolved gap when a bare import resolves to it through the tsconfig baseUrl', async () => {
    const tree = treeFor("import { Widget } from 'tests/Widget';\nexport function ClustersPage() { return <main><Widget /></main>; }\n");
    const coverage = await computeCoverage(fsOf(tree), config, changed);
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.excludedFiles ?? []).toEqual([]);
    expect(coverage.gaps.map((gap) => gap.state)).toEqual(['unresolved']);
    expect(coverage.gaps[0]?.reason).toContain("'tests/Widget'");
    expect(coverage.gaps[0]?.reason).toContain('baseUrl');
  });

  it('is an unresolved gap for each other way a path is built at run time', async () => {
    const screens = [
      "const mods = import.meta.glob(['./pages/*.tsx', './tests/*.tsx']);\nexport function ClustersPage() { return <main />; }\n",
      'const mods = import.meta.glob(PATTERN);\nexport function ClustersPage() { return <main />; }\n',
      'export async function load(name: string) { return import(name); }\nexport function ClustersPage() { return <main />; }\n',
      'export function load(name: string) { return require(`${name}/Widget`); }\nexport function ClustersPage() { return <main />; }\n',
      "export function load(name: string) { return require('./tests/' + name); }\nexport function ClustersPage() { return <main />; }\n",
    ];
    for (const screen of screens) {
      const coverage = await computeCoverage(fsOf(treeFor(screen)), config, changed);
      expect(coverage.gaps.map((gap) => gap.state), screen).toEqual(['unresolved']);
      expect(coverage.excludedFiles ?? [], screen).toEqual([]);
    }
  });

  it('is an unresolved gap when a glob loads a test file that imports it', async () => {
    const tree = {
      ...treeFor("const mods = import.meta.glob('./tests/Index.tsx');\nexport function ClustersPage() { return <main />; }\n"),
      'src/tests/Index.tsx': "export { Widget } from './Widget';\n",
    };
    const coverage = await computeCoverage(fsOf(tree), config, changed);
    expect(coverage.gaps.map((gap) => gap.state)).toEqual(['unresolved']);
    expect(coverage.gaps[0]?.reason).toContain('src/ClustersPage.tsx');
  });

  it('stays excluded when the glob pattern does not match it', async () => {
    const tree = treeFor("const mods = import.meta.glob('./pages/*.tsx');\nexport function ClustersPage() { return <main />; }\n");
    const coverage = await computeCoverage(fsOf(tree), config, changed);
    expect(coverage.nothingToCheck).toBe(true);
    expect(coverage.gaps).toEqual([]);
    expect((coverage.excludedFiles ?? []).map((entry) => entry.ref)).toEqual(changed);
  });

  it('stays excluded when the template prefix does not cover it', async () => {
    const tree = treeFor(
      'export async function load(name: string) { return import(`./pages/${name}`); }\nexport function ClustersPage() { return <main />; }\n',
    );
    const coverage = await computeCoverage(fsOf(tree), config, changed);
    expect(coverage.nothingToCheck).toBe(true);
    expect(coverage.gaps).toEqual([]);
    expect((coverage.excludedFiles ?? []).map((entry) => entry.ref)).toEqual(changed);
  });

  it('stays excluded when a dynamic import names a package path', async () => {
    const tree = treeFor(
      'export async function icon(name: string) { return import(`@patternfly/react-icons/dist/esm/icons/${name}`); }\nexport function ClustersPage() { return <main />; }\n',
    );
    const coverage = await computeCoverage(fsOf(tree), { ...config }, changed);
    expect(coverage.nothingToCheck).toBe(true);
    expect((coverage.excludedFiles ?? []).map((entry) => entry.ref)).toEqual(changed);
  });
});

describe('a test file that only other test files import', () => {
  const files: Record<string, string> = {
    'usabl.config.json': `${JSON.stringify(config)}\n`,
    'usabl.routes.json': SIDECAR,
    'src/ClustersPage.tsx': 'export function ClustersPage() { return <main />; }\n',
    'src/Widget.spec.tsx': WIDGET,
    'src/ClustersPage.test.tsx': "import { Widget } from './Widget.spec';\nimport { helper } from './tests/helper';\n",
    'src/tests/helper.ts': 'export const helper = 1;\n',
    'src/tests/setup.ts': "import { helper } from './helper';\n",
  };
  const changed = ['src/tests/helper.ts', 'src/Widget.spec.tsx'];

  it('is excluded, listed with a reason for its kind, and the run is idle', async () => {
    const coverage = await computeCoverage(fsOf(files), config, changed);
    expect(coverage.nothingToCheck).toBe(true);
    expect(coverage.gaps).toEqual([]);
    expect(coverage.unresolvedFiles).toEqual([]);
    const excluded = coverage.excludedFiles ?? [];
    expect(excluded.map((entry) => entry.ref)).toEqual(['src/Widget.spec.tsx', 'src/tests/helper.ts']);
    expect(excluded[0]?.reason).toMatch(/named like a test/);
    expect(excluded[1]?.reason).toMatch(/test folder/);
    for (const entry of excluded) {
      expect(entry.reason).toMatch(/outside the tests/);
      expect(entry.reason).toMatch(/no import usabl could not follow could load it/);
    }
  });

  it('is disclosed by an idle run that does not block', async () => {
    const result = await run(makeFakeDeps({ files, headContents: files }), config, { changedFiles: changed });
    expect(result.coverage.nothingToCheck).toBe(true);
    expect(result.verdict).toBeNull();
    expect(result.exitCode).toBe(0);
    expect((result.coverage.excludedFiles ?? []).map((entry) => entry.ref)).toEqual(['src/Widget.spec.tsx', 'src/tests/helper.ts']);
  });
});

describe('a test file that a file outside the tests imports, where no route reaches either', () => {
  const treeWith = (component: string): Record<string, string> => ({
    'usabl.routes.json': SIDECAR,
    'src/ClustersPage.tsx': 'export function ClustersPage() { return <main />; }\n',
    'src/Orphan.tsx': `import { Widget } from './${component.replace(/^src\//u, '').replace(/\.tsx$/u, '')}';\nexport function Orphan() { return <Widget />; }\n`,
    [component]: WIDGET,
  });

  it('gets the same result as a file outside the tests in that position', async () => {
    const control = await computeCoverage(fsOf(treeWith('src/widgets/Widget.tsx')), config, ['src/widgets/Widget.tsx']);
    const coverage = await computeCoverage(fsOf(treeWith('src/tests/Widget.tsx')), config, ['src/tests/Widget.tsx']);
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.excludedFiles ?? []).toEqual([]);
    expect(coverage.affected).toEqual(control.affected);
    expect(coverage.unresolvedFiles).toEqual(['src/tests/Widget.tsx']);
    expect(coverage.gaps.map((gap) => gap.state)).toEqual(control.gaps.map((gap) => gap.state));
    expect(coverage.gaps[0]?.reason).toMatch(/^This UI file is not in any route closure/);
  });
});

describe('the wider import graph', () => {
  const files: Record<string, string> = {
    'usabl.routes.json': SIDECAR,
    'src/ClustersPage.tsx': 'export function ClustersPage() { return <main />; }\n',
    'src/Orphan.tsx': 'export function Orphan() { return <aside />; }\n',
    'src/tests/setup.ts': 'export const setup = 1;\n',
  };

  it('is never built for a change with no test file', async () => {
    const counted = countingFs(files);
    const coverage = await computeCoverage(counted.fs, config, ['src/ClustersPage.tsx']);
    expect(coverage.affected.map((screen) => screen.screenId)).toEqual(['clusters']);
    expect(counted.globs).toEqual([]);
    expect(counted.reads).not.toContain('src/Orphan.tsx');
    expect(counted.reads).not.toContain('src/tests/setup.ts');
  });

  it('is built once for a change with a test file, and reads every file outside the tests', async () => {
    const counted = countingFs(files);
    const coverage = await computeCoverage(counted.fs, config, ['src/tests/setup.ts']);
    expect((coverage.excludedFiles ?? []).map((entry) => entry.ref)).toEqual(['src/tests/setup.ts']);
    expect(counted.globs).toEqual([config.uiFileGlobs]);
    expect(counted.reads.filter((path) => path === 'src/Orphan.tsx')).toHaveLength(1);
  });

  // The PatternFly seed fixture: eleven files under src, imported through the @app/* alias, with a
  // baseUrl. A change to a test file that no file imports reads every one of them, and excludes it.
  it('reads every file of the PatternFly seed fixture and excludes a test file nothing imports', async () => {
    const seed: UsablConfig = { ...config, uiFileGlobs: ['src/**'], discovery: { routerFile: 'src/app/routes.tsx', wideBlastGlobs: [] } };
    const measure = async (changed: string): Promise<{ reads: string[]; excluded: string[] }> => {
      const real = makeFsGlob({ cwd: 'fixtures/init/pf-seed' });
      const reads: string[] = [];
      const fs: FsGlob = {
        readFile: async (path) => {
          reads.push(path);
          return real.readFile(path);
        },
        glob: (patterns) => real.glob(patterns),
      };
      const coverage = await computeCoverage(fs, seed, [changed]);
      return { reads, excluded: (coverage.excludedFiles ?? []).map((entry) => entry.ref) };
    };
    const test = await measure('src/app/__tests__/Dashboard.test.tsx');
    expect(test.excluded).toEqual(['src/app/__tests__/Dashboard.test.tsx']);
    const sources = (await makeFsGlob({ cwd: 'fixtures/init/pf-seed' }).glob(['src/**'])).sort();
    expect(sources).toHaveLength(11);
    for (const source of sources) {
      expect(test.reads, source).toContain(source);
    }
  });

  it('is not built when a surface lists the changed test file', async () => {
    const counted = countingFs(files);
    const listed: UsablConfig = {
      ...config,
      surfaces: [{ id: 'setup-page', url: `${BASE}/setup`, files: ['src/tests/setup.ts'] }],
    };
    const coverage = await computeCoverage(counted.fs, listed, ['src/tests/setup.ts']);
    expect(coverage.affected.map((screen) => screen.screenId)).toEqual(['setup-page']);
    expect(counted.globs).toEqual([]);
    expect(counted.reads).not.toContain('src/Orphan.tsx');
  });
});

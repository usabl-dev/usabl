/**
 * More ways a screen can load a changed test file, and the loads usabl reads more narrowly so honest
 * test-only changes stay quiet. See test-files.test.ts for the rule itself.
 */
import { describe, expect, it } from 'vitest';
import type { Coverage, FsGlob, UsablConfig } from '../../src/contracts/index.js';
import { computeCoverage } from '../../src/coverage/planner.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';

const BASE = 'http://127.0.0.1:5173';
const WIDGET = 'export function Widget() { return <div onClick={() => 0}>open</div>; }\n';
const SIDECAR = `${JSON.stringify({ routes: [{ screenId: 'clusters', url: '/clusters', entryFile: 'src/ClustersPage.tsx' }] })}\n`;
const CHANGED = 'src/tests/Widget.tsx';

const config: UsablConfig = {
  appBaseUrl: BASE,
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: ['usabl.config.json', 'usabl.routes.json'],
};

const fsOf = (files: Record<string, string>): FsGlob => makeFakeDeps({ files }).fs;

// The screen file holds `body`, and the tree holds the changed test file and `extra`.
function treeWith(body: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'src/App.tsx': "import { ClustersPage } from './ClustersPage';\nexport function App() { return <ClustersPage />; }\n",
    'src/ClustersPage.tsx': `${body}\nexport function ClustersPage() { return <main />; }\n`,
    [CHANGED]: WIDGET,
    'usabl.routes.json': SIDECAR,
    ...extra,
  };
}

async function coverageOf(body: string, extra: Record<string, string> = {}, changed = CHANGED, cfg = config): Promise<Coverage> {
  return computeCoverage(fsOf(treeWith(body, extra)), cfg, [changed]);
}

function expectGap(coverage: Coverage, file = CHANGED): void {
  expect(coverage.nothingToCheck).toBe(false);
  expect(coverage.excludedFiles ?? []).toEqual([]);
  expect(coverage.gaps.map((gap) => gap.ref)).toContain(file);
}

function expectExcluded(coverage: Coverage, file = CHANGED): void {
  expect(coverage.nothingToCheck).toBe(true);
  expect(coverage.gaps).toEqual([]);
  expect((coverage.excludedFiles ?? []).map((entry) => entry.ref)).toEqual([file]);
}

const PACKAGE_JSON = JSON.stringify({ name: 'app', dependencies: { react: '^18.3.0', '@patternfly/react-icons': '^6.0.0' } });

describe('an importer outside uiFileGlobs that the config names', () => {
  // The UI globs cover src/features only. The router file and src/main.tsx sit outside them.
  const featureConfig: UsablConfig = {
    ...config,
    uiFileGlobs: ['src/features/**'],
    discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: ['src/main.tsx'] },
  };
  const changed = 'src/features/tests/Widget.tsx';
  const tree = (extra: Record<string, string>): Record<string, string> => ({
    'src/App.tsx': 'export function App() { return <main />; }\n',
    'src/features/Home.tsx': 'export function Home() { return <main />; }\n',
    [changed]: WIDGET,
    ...extra,
  });

  it('loads the test file when the router file imports it, with router fallback routes', async () => {
    const coverage = await computeCoverage(
      fsOf(tree({ 'src/App.tsx': "import { Widget } from './features/tests/Widget';\nexport function App() { return <Widget />; }\n" })),
      featureConfig,
      [changed],
    );
    expectGap(coverage, changed);
    expect(coverage.gaps[0]?.reason).toMatch(/^This UI file is not in any route closure/);
  });

  it('loads the test file when a file the wide-blast globs name imports it', async () => {
    const coverage = await computeCoverage(
      fsOf(tree({ 'src/main.tsx': "import { Widget } from './features/tests/Widget';\n", 'usabl.routes.json': SIDECAR })),
      featureConfig,
      [changed],
    );
    expectGap(coverage, changed);
  });

  it('is a gap when a glob in a file the wide-blast globs name may load it', async () => {
    const coverage = await computeCoverage(
      fsOf(tree({ 'src/main.tsx': "const m = import.meta.glob('./features/tests/*.tsx', { eager: true });\n", 'usabl.routes.json': SIDECAR })),
      featureConfig,
      [changed],
    );
    expectGap(coverage, changed);
    expect(coverage.gaps[0]?.reason).toContain('src/main.tsx');
  });

  it('loads the test file when a surface file outside the globs imports it', async () => {
    const withSurface: UsablConfig = {
      ...featureConfig,
      surfaces: [{ id: 'shell', url: `${BASE}/shell`, files: ['src/Shell.tsx'] }],
    };
    const coverage = await computeCoverage(
      fsOf(tree({ 'src/Shell.tsx': "import { Widget } from './features/tests/Widget';\n" })),
      withSurface,
      [changed],
    );
    expectGap(coverage, changed);
  });

  it('stays excluded when an importer outside the globs that the config does not name imports it', async () => {
    const coverage = await computeCoverage(
      fsOf(tree({ 'src/other.tsx': "import { Widget } from './features/tests/Widget';\n", 'usabl.routes.json': SIDECAR })),
      featureConfig,
      [changed],
    );
    expectExcluded(coverage, changed);
  });
});

describe('a test file that only files no route reaches import', () => {
  it('is a gap whose reason names those importers', async () => {
    const fixture = 'src/tests/fixtures/data.ts';
    const coverage = await coverageOf(
      '',
      {
        'package.json': PACKAGE_JSON,
        [fixture]: 'export const rows = [];\n',
        'src/Button.stories.tsx': "import { rows } from './tests/fixtures/data';\n",
        'src/mocks/handlers.ts': "import { rows } from '../tests/fixtures/data';\n",
      },
      fixture,
    );
    expectGap(coverage, fixture);
    const reason = coverage.gaps[0]?.reason ?? '';
    expect(reason).toMatch(/^This UI file is not in any route closure/);
    expect(reason).toContain('src/Button.stories.tsx, src/mocks/handlers.ts');
    expect(reason).toContain('no route closure reaches');
  });

  it('names the file outside the tests at the start of a chain through a test helper', async () => {
    const coverage = await coverageOf(
      '',
      { 'package.json': PACKAGE_JSON, 'src/Orphan.tsx': "import { helper } from './tests/helper';\n", 'src/tests/helper.ts': "export * from './Widget';\n" },
    );
    expect(coverage.gaps[0]?.reason).toContain('src/Orphan.tsx');
    expect(coverage.gaps[0]?.reason).not.toContain('src/tests/helper.ts import');
  });
});

describe('a load read as narrowly as its text allows', () => {
  const helper = 'src/tests/helper.ts';
  const helperTree = { 'package.json': PACKAGE_JSON, [helper]: 'export const helper = 1;\n' };
  const of = (body: string, extra: Record<string, string> = {}): Promise<Coverage> => coverageOf(body, { ...helperTree, ...extra }, helper);

  it('resolves a rooted glob from the Vite root, so a glob of pages does not cover a test helper', async () => {
    expectExcluded(await of("const pages = import.meta.glob('/src/pages/**/*.tsx');"), helper);
    expectExcluded(await of("const pages = import.meta.glob('/pages/**/*.tsx');", { 'src/vite.config.ts': 'export default {};' }), helper);
  });

  it('is a gap when a rooted glob covers the test file', async () => {
    const coverage = await of("const all = import.meta.glob('/src/tests/*.ts');", { 'vite.config.ts': 'export default {};' });
    expectGap(coverage, helper);
    expect(coverage.gaps[0]?.reason).toContain('src/tests/*.ts');
  });

  it('reads a pattern it cannot evaluate as the folder above that syntax', async () => {
    expectExcluded(await of("const pages = import.meta.glob('./pages/[id]/*.tsx');"), helper);
    const coverage = await of("const all = import.meta.glob('./tests/[a-z]*.ts');");
    expectGap(coverage, helper);
    expect(coverage.gaps[0]?.reason).toContain('src/tests/');
  });

  it('skips a load inside a comment', async () => {
    expectExcluded(await of("// const all = import.meta.glob('./tests/*.ts');\n/* require(name) */"), helper);
  });

  it('still reads a load after a string that holds comment marks', async () => {
    expectGap(await of('const url = "http://example.test/a/*b";\nconst all = import.meta.glob(PATTERN);'), helper);
  });

  it('still makes every test file a gap for require of a variable, and says where to change it', async () => {
    const coverage = await of('export const load = (name: string) => require(name);');
    expectGap(coverage, helper);
    expect(coverage.gaps[0]?.reason).toContain('change the load in src/ClustersPage.tsx');
  });
});

describe('a webpack require.context call', () => {
  it('is a gap when its folder holds the test file', async () => {
    const coverage = await coverageOf("const ctx = require.context('./tests', true, /\\.tsx$/);", { 'package.json': PACKAGE_JSON });
    expectGap(coverage);
    expect(coverage.gaps[0]?.reason).toContain('src/tests/');
  });

  it('is a gap when its first argument is not a literal', async () => {
    expectGap(await coverageOf('const ctx = require.context(folder, true);', { 'package.json': PACKAGE_JSON }));
  });

  it('stays excluded when its folder does not hold the test file', async () => {
    expectExcluded(await coverageOf("const ctx = require.context('./pages', true, /\\.tsx$/);", { 'package.json': PACKAGE_JSON }));
  });
});

describe('a test file in a workspace package the app depends on', () => {
  const workspace: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'app', workspaces: ['packages/*'], dependencies: { '@acme/ui': '*', react: '^18.3.0' } }),
    'packages/ui/package.json': JSON.stringify({ name: '@acme/ui', main: 'src/index.ts' }),
    'packages/ui/src/index.ts': "export * from './Widget.spec';\nexport * from './Button';\n",
    'packages/ui/src/Button.tsx': 'export const Button = () => <button />;\n',
    'packages/ui/src/Widget.spec.tsx': WIDGET,
    'packages/ui/src/Button.test.tsx': "import { Button } from './Button';\n",
    'packages/ui/src/tests/helpers.ts': 'export const helper = 1;\n',
  };
  const screen = "import { Widget } from '@acme/ui';";

  it('is a workspace gap when a file of the package outside the tests loads it', async () => {
    const coverage = await coverageOf(screen, workspace, 'packages/ui/src/Widget.spec.tsx');
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.excludedFiles ?? []).toEqual([]);
    expect(coverage.gaps.map((gap) => [gap.ref, gap.state])).toEqual([['packages/ui/src/Widget.spec.tsx', 'not-covered']]);
    expect(coverage.gaps[0]?.reason).toContain('@acme/ui');
  });

  it('gives the same gap as a file of the package that is not a test file', async () => {
    const coverage = await coverageOf(screen, workspace, 'packages/ui/src/Button.tsx');
    expect(coverage.gaps.map((gap) => [gap.ref, gap.state])).toEqual([['packages/ui/src/Button.tsx', 'not-covered']]);
  });

  it('is excluded and listed, and the run is idle, when only tests import it', async () => {
    for (const file of ['packages/ui/src/Button.test.tsx', 'packages/ui/src/tests/helpers.ts']) {
      expectExcluded(await coverageOf(screen, workspace, file), file);
    }
  });

  it('is a workspace gap when a load usabl cannot follow in the package may reach it', async () => {
    const tree = { ...workspace, 'packages/ui/src/Button.tsx': "const all = import.meta.glob('./tests/*.ts');\nexport const Button = () => <button />;\n" };
    const coverage = await coverageOf(screen, tree, 'packages/ui/src/tests/helpers.ts');
    expect(coverage.gaps.map((gap) => [gap.ref, gap.state])).toEqual([['packages/ui/src/tests/helpers.ts', 'not-covered']]);
  });
});

describe('a bare import that no package explains', () => {
  it('is a gap through a Vite alias whose key is not quoted', async () => {
    expectGap(
      await coverageOf("import { Widget } from 'tests/Widget';", {
        'package.json': PACKAGE_JSON,
        'vite.config.ts': "export default { resolve: { alias: { tests: './src/tests' } } };",
      }),
    );
  });

  it('is a gap through a package.json imports entry', async () => {
    expectGap(
      await coverageOf("import { Widget } from '#tests/Widget';", {
        'package.json': JSON.stringify({ name: 'app', imports: { '#tests/*': './src/tests/*.tsx' }, dependencies: { react: '^18.3.0' } }),
      }),
    );
  });

  it('is a gap through a jsconfig.json baseUrl', async () => {
    const coverage = await coverageOf("import { Widget } from 'tests/Widget';", {
      'package.json': PACKAGE_JSON,
      'jsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: 'src' } }),
    });
    expectGap(coverage);
    expect(coverage.gaps[0]?.reason).toContain('baseUrl');
  });

  it('is a gap when no config at all explains it', async () => {
    const coverage = await coverageOf("import { Widget } from 'tests/Widget';", { 'package.json': PACKAGE_JSON });
    expectGap(coverage);
    expect(coverage.gaps[0]?.reason).toContain("'tests/Widget'");
  });

  it('is a gap through a Vite alias written as code usabl cannot read', async () => {
    expectGap(
      await coverageOf("import { Widget } from 'tests/Widget';", {
        'package.json': PACKAGE_JSON,
        'vite.config.ts':
          "import { fileURLToPath } from 'node:url';\nexport default { resolve: { alias: { tests: fileURLToPath(new URL('./src/tests', import.meta.url)) } } };",
      }),
    );
  });

  it('is a gap for a bare template prefix that no package explains', async () => {
    expectGap(await coverageOf("const W = React.lazy(() => import(`tests/${name}`));", { 'package.json': PACKAGE_JSON }));
  });

  it('stays excluded beside imports of declared packages and Node.js built-in modules', async () => {
    const body =
      "import React from 'react';\nimport path from 'node:path';\nimport { readFile } from 'fs';\n" +
      'const icon = (name: string) => import(`@patternfly/react-icons/dist/esm/icons/${name}`);';
    expectExcluded(await coverageOf(body, { 'package.json': PACKAGE_JSON }));
  });

  it('stays excluded when the unknown bare import names another file', async () => {
    expectExcluded(await coverageOf("import { thing } from 'lodash-es/thing';", { 'package.json': PACKAGE_JSON }));
  });
});

/**
 * More ways a screen can load a changed test file, and the loads usabl reads more narrowly so honest
 * test-only changes stay quiet. See test-files.test.ts for the rule itself.
 */
import { describe, expect, it } from 'vitest';
import type { Coverage, FsGlob, UsablConfig } from '../../src/contracts/index.js';
import type { ImportGraphView } from '../../src/coverage/import-graph.js';
import { computeCoverage } from '../../src/coverage/planner.js';
import { importersOutsideTests } from '../../src/coverage/test-files.js';
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

  it('reads a rooted glob of pages under every folder, so it does not cover a test helper', async () => {
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

describe('a glob pattern that starts with /, read under every folder', () => {
  const glob = "const all = import.meta.glob('/tests/**/*.tsx', { eager: true });";
  const PLAIN = "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });";

  it('is a gap when the Vite config is a factory or a config from a package', async () => {
    const workspace = {
      'package.json': JSON.stringify({ name: 'app', workspaces: ['packages/*'], dependencies: { '@acme/vite-config': '*', react: '^18.3.0' } }),
      'packages/vite-config/package.json': JSON.stringify({ name: '@acme/vite-config', main: 'index.ts' }),
      'packages/vite-config/index.ts': "export const make = (d: string) => ({ root: d + '/src' });\nexport default { root: 'src' };\n",
    };
    for (const text of [
      "import { make } from '@acme/vite-config';\nexport default make(__dirname);",
      "import config from '@acme/vite-config';\nexport default config;",
    ]) {
      expectGap(await coverageOf(glob, { ...workspace, 'vite.config.ts': text }));
    }
  });

  it('is a gap for every config shape that can move the root', async () => {
    const base = { 'vite.base.ts': "export default { root: 'src' };", 'tools/vite.ts': "export const make = () => ({ root: 'src' });", 'config/vite.ts': "export default { root: 'src' };" };
    for (const text of [
      "export default { root: 'src' };",
      "import { defineConfig } from 'vite';\nexport default defineConfig({ root: './src' });",
      "import base from './vite.base';\nexport default { ...base };",
      "import { mergeConfig } from 'vite';\nimport base from './vite.base';\nexport default mergeConfig(base, {});",
      "import { make } from './tools/vite';\nexport default make(__dirname);",
      "export { default } from './config/vite';",
    ]) {
      expectGap(await coverageOf(glob, { ...base, 'vite.config.ts': text }));
    }
  });

  it('is a gap when more than one Vite config sits on the climb from the router file, and says why', async () => {
    const coverage = await coverageOf(glob, { 'vite.config.ts': 'export default {};', 'src/vite.config.ts': 'export default {};' });
    expectGap(coverage);
    const reason = coverage.gaps[0]?.reason ?? '';
    expect(reason).toContain('src/ClustersPage.tsx');
    expect(reason).toContain('usabl reads a pattern that starts with / under every folder, because it cannot know the folder Vite runs from');
    expect(reason).toContain('so its pattern or path start does not cover test folders');
    expect(reason).toContain('list the file in the files of a surface');
  });

  it('is a gap with no Vite config at all, so a root given on the command line is covered', async () => {
    expectGap(await coverageOf(glob, { 'package.json': PACKAGE_JSON }));
  });

  it('reads a leading .. as the folder above, which is also read', async () => {
    expectGap(await coverageOf("const all = import.meta.glob('/../tests/*.tsx');", { 'package.json': PACKAGE_JSON }));
    expectExcluded(await coverageOf("const all = import.meta.glob('/../mytests/*.tsx');", { 'package.json': PACKAGE_JSON }));
  });

  it('stays idle for a test helper the pattern does not cover, whatever the config holds', async () => {
    const helper = 'src/tests/helper.ts';
    const fileRoutes = "const pages = import.meta.glob('/src/pages/**/*.tsx');";
    const generouted = "const pages = import.meta.glob('/src/pages/**/[\\\\w[-]*.{jsx,tsx,mdx}', { eager: true });";
    const configs = [
      'export default {};',
      PLAIN,
      "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react(), ...extra] });",
      "export default { root: 'src' };",
    ];
    for (const body of [fileRoutes, generouted]) {
      for (const text of configs) {
        const tree = { 'package.json': PACKAGE_JSON, [helper]: 'export const helper = 1;\n', 'vite.config.ts': text };
        expectExcluded(await coverageOf(body, tree, helper), helper);
      }
    }
  });

  it('is a gap in a second app when only the first app has the glob', async () => {
    const changed = 'apps/admin/src/pages/x.test.tsx';
    const monorepo: UsablConfig = { ...config, uiFileGlobs: ['apps/**'], discovery: { routerFile: 'apps/web/src/App.tsx', wideBlastGlobs: [] } };
    const routes = { routes: [{ screenId: 'home', url: '/home', entryFile: 'apps/web/src/Home.tsx' }] };
    const coverage = await computeCoverage(
      fsOf({
        'package.json': PACKAGE_JSON,
        'apps/web/vite.config.ts': PLAIN,
        'apps/web/src/App.tsx': "import { Home } from './Home';\nexport function App() { return <Home />; }\n",
        'apps/web/src/Home.tsx': "const pages = import.meta.glob('/src/pages/**/*.tsx');\nexport function Home() { return <main />; }\n",
        'apps/admin/src/pages/Index.tsx': 'export const Index = () => <main />;\n',
        [changed]: WIDGET,
        'usabl.routes.json': `${JSON.stringify(routes)}\n`,
      }),
      monorepo,
      [changed],
    );
    expectGap(coverage, changed);
    expect(coverage.gaps[0]?.reason).toContain('apps/web/src/Home.tsx');
  });
});

describe('the options of an import.meta.glob call', () => {
  const tree = { 'package.json': PACKAGE_JSON };

  it.each(["{ base: './tests' }", "{ 'base': './tests' }", '{ "base": "./tests" }', "{ ['base']: './tests' }", "{ ['ba' + 'se']: './tests' }"])(
    'is a gap when the options may set base: %s',
    async (options) => {
      const coverage = await coverageOf(`const all = import.meta.glob('./pages/*.tsx', ${options});`, tree);
      expectGap(coverage);
      expect(coverage.gaps[0]?.reason).toContain('may load any file');
    },
  );

  it.each(['{ eager: true }', "{ eager: true, import: 'default' }", "{ query: '?raw', import: 'default' }", "{ 'eager': true, query: { url: true } }"])(
    'still reads the patterns when the options are plain values with no base: %s',
    async (options) => {
      expectExcluded(await coverageOf(`const all = import.meta.glob('./pages/*.tsx', ${options});`, tree));
    },
  );
});

describe('a glob with brace alternatives', () => {
  const pages = (body: string): Record<string, string> => ({ 'src/pages/index.tsx': `${body}\nexport const Index = () => <main />;\n` });

  it('resolves a .. inside an alternative, for a pattern it cannot evaluate', async () => {
    expectGap(await coverageOf('', pages("const all = import.meta.glob('./{../tests,x}/[A-Z]*.tsx');")));
  });

  it('resolves a .. inside an alternative, for a pattern it can read, from either importer', async () => {
    expectGap(await coverageOf('', pages("const all = import.meta.glob('./{../tests,x}/*.tsx');")));
    expectGap(await coverageOf("const all = import.meta.glob('./pages/{../tests,x}/*.tsx');"));
  });

  it('is a gap when a .. follows a glob segment', async () => {
    expectGap(await coverageOf("const all = import.meta.glob('./*/../tests/*.tsx');"));
  });

  it('is a gap for a nested brace, and says the pattern has a part usabl cannot evaluate', async () => {
    const coverage = await coverageOf("const all = import.meta.glob('./{pages,{a,b}}/*.tsx');");
    expectGap(coverage);
    expect(coverage.gaps[0]?.reason).toContain('cannot evaluate');
  });

  it('is a gap when the braces expand to more alternatives than usabl reads', async () => {
    const many = Array.from({ length: 70 }, (_, index) => `p${index}`).join(',');
    expectGap(await coverageOf(`const all = import.meta.glob('./{${many}}/*.tsx');`));
  });

  it('is a gap for an escaped brace, which usabl does not read as a group', async () => {
    // The source holds './\\{x,tests\\}/*.tsx', so the string holds a backslash before each brace.
    const changed = 'src/{x,tests}/Widget.spec.tsx';
    const coverage = await coverageOf("const all = import.meta.glob('./\\\\{x,tests\\\\}/*.tsx');", { [changed]: WIDGET }, changed);
    expectGap(coverage, changed);
    expect(coverage.gaps[0]?.reason).toContain('cannot evaluate');
  });

  it('stays excluded when no alternative covers the test file', async () => {
    expectExcluded(await coverageOf('', pages("const all = import.meta.glob('./{../widgets,x}/[A-Z]*.tsx');")));
    expectExcluded(await coverageOf("const all = import.meta.glob('./{pages,widgets}/*.tsx');"));
  });
});

describe('reasons that say what is true', () => {
  it('says a changed test file matched wideBlastGlobs and was still not checked', async () => {
    const wide: UsablConfig = { ...config, discovery: { ...config.discovery, wideBlastGlobs: ['src/tests/**'] } };
    const coverage = await coverageOf('', { 'package.json': PACKAGE_JSON }, CHANGED, wide);
    expectExcluded(coverage);
    const reason = coverage.excludedFiles?.[0]?.reason ?? '';
    expect(reason).toContain('It matches wideBlastGlobs, but it was still not checked, because nothing outside the tests loads it.');
    expect(reason).toContain('usabl found no import of it');
  });

  it('does not name wideBlastGlobs when the file does not match one', async () => {
    const coverage = await coverageOf('', { 'package.json': PACKAGE_JSON });
    expect(coverage.excludedFiles?.[0]?.reason).not.toContain('wideBlastGlobs');
  });

  it('says "imports it" for one importer', async () => {
    const coverage = await coverageOf('', { 'package.json': PACKAGE_JSON, 'src/Orphan.tsx': "import { Widget } from './tests/Widget';\n" });
    expect(coverage.gaps[0]?.reason).toContain('because src/Orphan.tsx imports it');
  });

  it('reads a glob string with a backslash escape as the string it is', async () => {
    // The pattern generouted uses for file routes, as it is written in source.
    const body = "const pages = import.meta.glob('/src/pages/**/[\\\\w[-]*.{jsx,tsx,mdx}', { eager: true });";
    const tree = { 'package.json': PACKAGE_JSON, 'vite.config.ts': 'export default {};' };
    expectExcluded(await coverageOf(body, tree));
    const inPages = 'src/pages/tests/helper.ts';
    const coverage = await coverageOf(body, { ...tree, [inPages]: 'export const helper = 1;\n' }, inPages);
    expectGap(coverage, inPages);
    expect(coverage.gaps[0]?.reason).toContain('usabl does not evaluate the syntax in /src/pages/**/[\\w[-]*.{jsx,tsx,mdx}');
    expect(coverage.gaps[0]?.reason).not.toContain('is not a string');
  });
});

describe('the importers of loaded test files', () => {
  it('reads each edge of the graph once for many test files', () => {
    let reads = 0;
    const app = Array.from({ length: 50 }, (_, index) => `src/Page${index}.tsx`);
    const tests = ['src/tests/a.ts', 'src/tests/b.ts', 'src/tests/c.ts'];
    const edges = new Map<string, string[]>([...app.map((file): [string, string[]] => [file, ['src/util.ts', ...tests]]), ['src/tests/c.ts', ['src/tests/a.ts']]]);
    const graph: ImportGraphView = {
      get: (file) => {
        reads += 1;
        return edges.get(file) ?? [];
      },
      unresolvable: [],
      visited: new Set([...app, 'src/util.ts', ...tests]),
    };
    const importers = importersOutsideTests(graph, tests);
    expect(reads).toBe(graph.visited.size);
    expect(importers.get('src/tests/a.ts')).toEqual([...app].sort());
    expect([...importers.keys()]).toEqual(tests);
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

  const helpers = 'packages/ui/src/tests/helpers.ts';
  const expectWorkspaceGap = (coverage: Coverage, file = helpers): void => {
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.excludedFiles ?? []).toEqual([]);
    expect(coverage.gaps.map((gap) => [gap.ref, gap.state])).toEqual([[file, 'not-covered']]);
  };

  it('is a workspace gap when a screen imports it by a path inside the package', async () => {
    expectWorkspaceGap(await coverageOf("import { helper } from '@acme/ui/src/tests/helpers';", workspace, helpers));
  });

  it('is a workspace gap when a screen imports a package subpath that usabl cannot find as a file', async () => {
    const tree = {
      ...workspace,
      'packages/ui/package.json': JSON.stringify({ name: '@acme/ui', exports: { '.': './src/index.ts', './testing': './src/tests/index.ts' } }),
      'packages/ui/src/tests/index.ts': "export * from './helpers';\n",
    };
    expectWorkspaceGap(await coverageOf("import { helper } from '@acme/ui/testing';", tree, helpers));
  });

  it('does not follow a subpath by path when the package has an exports field', async () => {
    const tree = {
      ...workspace,
      'packages/ui/package.json': JSON.stringify({ name: '@acme/ui', exports: { '.': './src/index.ts', './testing': './src/tests/helpers.ts' } }),
      'packages/ui/testing.ts': 'export const stub = 1;\n',
    };
    const coverage = await coverageOf("import { helper } from '@acme/ui/testing';", tree, helpers);
    expectWorkspaceGap(coverage);
  });

  describe('a plain string entry in exports', () => {
    const withExports = (exports: Record<string, unknown>, extra: Record<string, string> = {}): Record<string, string> => ({
      ...workspace,
      'packages/ui/package.json': JSON.stringify({ name: '@acme/ui', exports }),
      'packages/ui/styles.css': 'a{}\n',
      ...extra,
    });
    const css = "import '@acme/ui/styles.css';";

    it('is followed to its one file, so a test-only change in the package stays idle', async () => {
      const tree = withExports({ '.': './src/index.ts', './styles.css': './styles.css' });
      expectExcluded(await coverageOf(css, tree, helpers), helpers);
    });

    it('wins over a pattern key, as in Node.js', async () => {
      const tree = withExports({ '.': './src/index.ts', './*': './src/tests/*.ts', './styles.css': './styles.css' });
      expectExcluded(await coverageOf(css, tree, helpers), helpers);
    });

    it('is still a gap for a conditions object under the same key', async () => {
      const tree = withExports({ '.': './src/index.ts', './styles.css': { import: './styles.css', default: './styles.css' } });
      expectWorkspaceGap(await coverageOf(css, tree, helpers));
    });

    it('is still a gap when the entry leaves the package', async () => {
      const tree = withExports({ '.': './src/index.ts', './styles.css': './../other/styles.css' }, { 'packages/other/styles.css': 'a{}\n' });
      expectWorkspaceGap(await coverageOf(css, tree, helpers));
    });

    it('is still a gap when the entry names no file', async () => {
      const tree = withExports({ '.': './src/index.ts', './styles.css': './dist/styles.css' });
      expectWorkspaceGap(await coverageOf(css, tree, helpers));
    });

    it('makes the test file it names a UI file with a gap, and leaves other test files excluded', async () => {
      const tree = withExports({ '.': './src/index.ts', './testing': './src/tests/helpers.ts' });
      const screen = "import { helper } from '@acme/ui/testing';";
      const coverage = await coverageOf(screen, tree, helpers);
      expectWorkspaceGap(coverage);
      expect(coverage.gaps[0]?.reason).not.toContain('cannot follow by path');
      expectExcluded(await coverageOf(screen, tree, 'packages/ui/src/Button.test.tsx'), 'packages/ui/src/Button.test.tsx');
    });
  });

  it('is a gap when a subpath leaves the package folder', async () => {
    const other = 'packages/other/src/tests/helpers.ts';
    const tree = {
      ...workspace,
      'package.json': JSON.stringify({ name: 'app', workspaces: ['packages/*'], dependencies: { '@acme/ui': '*', '@acme/other': '*' } }),
      'packages/other/package.json': JSON.stringify({ name: '@acme/other', main: 'src/index.ts' }),
      'packages/other/src/index.ts': 'export const other = 1;\n',
      [other]: 'export const helper = 1;\n',
    };
    const coverage = await coverageOf("import { helper } from '@acme/ui/../other/src/tests/helpers';", tree, other);
    expectWorkspaceGap(coverage, other);
  });

  it('is a workspace gap when another workspace package the app depends on imports it', async () => {
    const tree = {
      ...workspace,
      'package.json': JSON.stringify({ name: 'app', workspaces: ['packages/*'], dependencies: { '@acme/shell': '*', react: '^18.3.0' } }),
      'packages/shell/package.json': JSON.stringify({ name: '@acme/shell', main: 'src/index.ts', dependencies: { '@acme/ui': '*' } }),
      'packages/shell/src/index.ts': "import { helper } from '@acme/ui/src/tests/helpers';\nexport const Shell = () => helper;\n",
    };
    expectWorkspaceGap(await coverageOf("import { Shell } from '@acme/shell';", tree, helpers));
  });

  it('gives the same gap for a file of the package that is not a test file, imported by a path inside it', async () => {
    const tree = { ...workspace, 'packages/ui/src/Other.tsx': 'export const Other = () => <i />;\n' };
    expectWorkspaceGap(await coverageOf("import { Other } from '@acme/ui/src/Other';", tree, 'packages/ui/src/Other.tsx'), 'packages/ui/src/Other.tsx');
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

  it('is a gap when the first segment names a Node.js built-in module but the whole name does not', async () => {
    const changed = 'src/util/tests/Widget.tsx';
    const coverage = await coverageOf("import { Widget } from 'util/tests/Widget';", { 'package.json': PACKAGE_JSON, [changed]: WIDGET }, changed);
    expectGap(coverage, changed);
    expect(coverage.gaps[0]?.reason).toContain("'util/tests/Widget'");
  });

  it('stays excluded beside built-in subpaths that Node.js lists', async () => {
    const body = "import { readFile } from 'fs/promises';\nimport { types } from 'util/types';\nimport { join } from 'node:path/posix';";
    const changed = 'src/util/tests/promises.ts';
    expectExcluded(await coverageOf(body, { 'package.json': PACKAGE_JSON, [changed]: 'export const p = 1;\n' }, changed), changed);
  });

  it('stays excluded when the unknown bare import names another file', async () => {
    expectExcluded(await coverageOf("import { thing } from 'lodash-es/thing';", { 'package.json': PACKAGE_JSON }));
  });
});

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

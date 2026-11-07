/**
 * `usabl brief` lists the screens a change reaches from the same planners the gate uses, so the
 * acceptance test here is parity: for the same changed files, the brief names every screen run()
 * scans, in the same order, and nothing else. The brief never opens a page and never decides a
 * verdict, so these tests also check what it says about each check and about done.
 */
import { describe, expect, it, vi } from 'vitest';
import type { UsablConfig } from '../../src/contracts/index.js';
import { makeFakeDeps, type FakeDepsSpec } from '../../src/deps/fakes.js';
import { makeBrief, PER_FILE_REACH_LIMIT, type Brief } from '../../src/brief/index.js';
import { DONE_CONDITIONS } from '../../src/coverage/completeness.js';
import { formatBrief } from '../../src/output/brief.js';
import { run } from '../../src/run.js';

const config: UsablConfig = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'src/App.tsx', wideBlastGlobs: ['src/App.tsx'] },
  surfaces: [],
  guardedPaths: [],
};

const routes = JSON.stringify({
  routes: [
    { screenId: 'clusters', url: '/clusters', entryFile: 'src/ClustersPage.tsx' },
    { screenId: 'alerts', url: '/alerts', entryFile: 'src/AlertsPage.tsx' },
    { screenId: 'settings', url: '/settings', entryFile: 'src/SettingsPage.tsx' },
  ],
});

const docsManifest = JSON.stringify({
  format: 'asciidoc-modular',
  docsBaseUrl: 'http://localhost:8080/docs',
  builtRoot: 'build/html',
  buildCommand: 'npm run build:docs',
  pages: [
    {
      pageId: 'getting-started',
      url: '/getting-started.html',
      assemblyFile: 'modules/getting-started.adoc',
      sources: ['modules/getting-started.adoc'],
    },
  ],
  sharedGlobs: ['modules/_attributes.adoc'],
});

const appFiles: Record<string, string> = {
  // The guard reads its scope from the committed config, so the fixture repository has one.
  'usabl.config.json': JSON.stringify(config),
  'usabl.routes.json': routes,
  'src/App.tsx': 'export default function App() {}',
  'src/ClustersPage.tsx': "import { Table } from './shared/Table';\nexport default function ClustersPage() {}",
  'src/AlertsPage.tsx': "import { Table } from './shared/Table';\nexport default function AlertsPage() {}",
  'src/SettingsPage.tsx': 'export default function SettingsPage() {}',
  'src/shared/Table.tsx': 'export function Table() {}',
  'src/util.ts': 'export const x = 1;',
};

function depsFor(overrides: Partial<FakeDepsSpec> = {}) {
  const files = { ...appFiles, ...(overrides.files ?? {}) };
  return makeFakeDeps({ ...overrides, files, headContents: overrides.headContents ?? files });
}

// The screen ids run() handed to the check runner, in the order it handed them.
async function scannedByRun(deps: ReturnType<typeof makeFakeDeps>, cfg: UsablConfig, changedFiles?: string[]) {
  const scan = vi.spyOn(deps.checkRunner, 'scan');
  await run(deps, cfg, changedFiles === undefined ? {} : { changedFiles });
  return scan.mock.calls.map(([screen]) => screen.id);
}

async function briefFor(deps: ReturnType<typeof makeFakeDeps>, cfg: UsablConfig, changedFiles?: string[]): Promise<Brief> {
  return makeBrief({ fs: deps.fs, git: deps.git, config: cfg, ...(changedFiles === undefined ? {} : { changedFiles }) });
}

describe('makeBrief screens match the gate', () => {
  it('lists every screen the gate scans for a change to a shared file, in the same order', async () => {
    const deps = depsFor();
    const changed = ['src/shared/Table.tsx'];
    const scanned = await scannedByRun(deps, config, changed);
    const brief = await briefFor(deps, config, changed);

    expect(scanned).toEqual(['clusters', 'alerts']);
    expect(brief.screens.map((screen) => screen.id)).toEqual(scanned);
    expect(brief.screens[0]?.reachedBy).toEqual([
      { file: 'src/shared/Table.tsx', via: 'imported by the route entry src/ClustersPage.tsx' },
    ]);
    expect(brief.screens[1]?.reachedBy).toEqual([
      { file: 'src/shared/Table.tsx', via: 'imported by the route entry src/AlertsPage.tsx' },
    ]);
    expect(brief.screens[0]?.url).toBe('http://127.0.0.1:5173/clusters');
  });

  it('uses the changed files from git when no files are given, the same way check does', async () => {
    const deps = depsFor({
      changed: [
        { code: 'M', path: 'src/SettingsPage.tsx' },
        { code: 'M', path: 'src/shared/Table.tsx' },
        { code: '??', path: 'src/util.ts' },
      ],
    });
    const scanned = await scannedByRun(deps, config);
    const result = await run(deps, config);
    const brief = await briefFor(deps, config);

    expect(brief.files).toEqual(['src/SettingsPage.tsx', 'src/shared/Table.tsx', 'src/util.ts']);
    expect(brief.screens.map((screen) => screen.id)).toEqual(scanned);
    expect(brief.unresolved.map((entry) => entry.file)).toEqual(result.coverage.unresolvedFiles);
    expect(brief.unresolved[0]?.why).toBe(result.coverage.gaps.find((gap) => gap.ref === 'src/util.ts')?.reason);
  });

  it('lists every file that reaches a screen, not only the first', async () => {
    const deps = depsFor();
    const brief = await briefFor(deps, config, ['src/ClustersPage.tsx', 'src/shared/Table.tsx']);
    expect(brief.screens.find((screen) => screen.id === 'clusters')?.reachedBy.map((reach) => reach.file)).toEqual([
      'src/ClustersPage.tsx',
      'src/shared/Table.tsx',
    ]);
  });

  it('matches the gate on a wide blast change with docs pages, app screens first', async () => {
    const deps = depsFor({ files: { 'usabl.docs.json': docsManifest } });
    const changed = ['src/App.tsx', 'modules/_attributes.adoc'];
    const scanned = await scannedByRun(deps, config, changed);
    const brief = await briefFor(deps, config, changed);

    expect(scanned).toEqual(['clusters', 'alerts', 'settings', 'getting-started']);
    expect(brief.screens.map((screen) => screen.id)).toEqual(scanned);
    expect(brief.screens[0]?.reachedBy).toEqual([{ file: 'src/App.tsx', via: 'wide blast glob' }]);
    expect(brief.screens[3]?.reachedBy).toEqual([{ file: 'modules/_attributes.adoc', via: 'docs shared glob' }]);
  });

  it('lists the screens of configured surfaces with the surface files as the path', async () => {
    const cfg: UsablConfig = {
      ...config,
      surfaces: [{ id: 'reports', url: 'http://127.0.0.1:5173/reports', files: ['src/util.ts'] }],
    };
    const deps = depsFor();
    const scanned = await scannedByRun(deps, cfg, ['src/util.ts']);
    const brief = await briefFor(deps, cfg, ['src/util.ts']);
    expect(brief.screens.map((screen) => screen.id)).toEqual(scanned);
    expect(brief.screens[0]?.reachedBy).toEqual([{ file: 'src/util.ts', via: 'surface files' }]);
    expect(brief.unresolved).toEqual([]);
  });
});

describe('makeBrief reads the manifests the way a local run does', () => {
  // The working tree adds a route the committed manifest does not have.
  const dirtyRoutes = JSON.stringify({
    routes: [
      ...JSON.parse(routes).routes,
      { screenId: 'reports', url: '/reports', entryFile: 'src/ReportsPage.tsx' },
    ],
  });
  const reports = { 'src/ReportsPage.tsx': 'export default function ReportsPage() {}' };

  it('plans with a routes manifest that differs from HEAD read as missing, as run() does', async () => {
    const deps = depsFor({
      files: { ...reports, 'usabl.routes.json': dirtyRoutes },
      headContents: { ...appFiles, ...reports },
    });
    const changed = ['src/ReportsPage.tsx', 'src/shared/Table.tsx'];
    const scanned = await scannedByRun(deps, config, changed);
    const brief = await briefFor(deps, config, changed);

    expect(scanned).not.toContain('reports');
    expect(brief.screens.map((screen) => screen.id)).toEqual(scanned);
    expect(brief.disclosures).toEqual([
      'usabl.routes.json differs from HEAD; a local check reads it as missing until it is committed, and CI needs approval for it.',
    ]);
  });

  it('discloses a docs manifest that differs from HEAD and plans no docs page from it', async () => {
    const deps = depsFor({ files: { 'usabl.docs.json': docsManifest }, headContents: appFiles });
    const changed = ['modules/getting-started.adoc'];
    const scanned = await scannedByRun(deps, config, changed);
    const brief = await briefFor(deps, config, changed);
    expect(scanned).toEqual([]);
    expect(brief.screens.map((screen) => screen.id)).toEqual(scanned);
    expect(brief.disclosures).toEqual([
      'usabl.docs.json differs from HEAD; a local check reads it as missing until it is committed, and CI needs approval for it.',
    ]);
  });

  it('has no disclosure when the manifests match HEAD', async () => {
    const brief = await briefFor(depsFor(), config, ['src/shared/Table.tsx']);
    expect(brief.disclosures).toEqual([]);
  });

  it('prints each disclosure in the text', async () => {
    const deps = depsFor({
      files: { ...reports, 'usabl.routes.json': dirtyRoutes },
      headContents: { ...appFiles, ...reports },
    });
    const text = formatBrief(await briefFor(deps, config, ['src/ReportsPage.tsx']));
    expect(text).toContain('note: usabl.routes.json differs from HEAD; a local check reads it as missing');
  });
});

describe('makeBrief bounds the cost of reachedBy', () => {
  it('plans a single changed file once, since its reach is the joined plan', async () => {
    const deps = depsFor();
    const read = vi.spyOn(deps.fs, 'readFile');
    const brief = await briefFor(deps, config, ['src/shared/Table.tsx']);
    // Once each for the guard, the joined plan, and the requirement screen check. A second plan of
    // the same file would read the routes manifest a fourth time.
    expect(read.mock.calls.filter(([path]) => path === 'usabl.routes.json')).toHaveLength(3);
    expect(brief.screens[0]?.reachedBy).toEqual([
      { file: 'src/shared/Table.tsx', via: 'imported by the route entry src/ClustersPage.tsx' },
    ]);
    expect(brief.disclosures).toEqual([]);
  });

  const generated = (count: number) => Array.from({ length: count }, (_, index) => `src/gen/File${index}.tsx`);

  it(`lists every reaching file up to ${PER_FILE_REACH_LIMIT} changed files`, async () => {
    const changed = ['src/ClustersPage.tsx', 'src/shared/Table.tsx', ...generated(PER_FILE_REACH_LIMIT - 2)];
    const brief = await briefFor(depsFor(), config, changed);
    expect(brief.screens.find((screen) => screen.id === 'clusters')?.reachedBy).toHaveLength(2);
    expect(brief.disclosures).toEqual([]);
  });

  it(`lists one file per screen above ${PER_FILE_REACH_LIMIT} changed files and says so`, async () => {
    const deps = depsFor();
    const changed = ['src/ClustersPage.tsx', 'src/shared/Table.tsx', ...generated(PER_FILE_REACH_LIMIT - 1)];
    const scanned = await scannedByRun(deps, config, changed);
    const brief = await briefFor(deps, config, changed);
    expect(brief.screens.map((screen) => screen.id)).toEqual(scanned);
    expect(brief.screens.find((screen) => screen.id === 'clusters')?.reachedBy).toEqual([
      { file: 'src/ClustersPage.tsx', via: 'imported by the route entry src/ClustersPage.tsx' },
    ]);
    expect(brief.disclosures).toEqual([
      `reachedBy lists at most one file per screen because the change has ${PER_FILE_REACH_LIMIT + 1} files.`,
    ]);
  });
});

describe('makeBrief checks', () => {
  const requirementsYaml = `
version: 1
requirements:
  - id: delete-row
    kind: flow
    surface: clusters
    description: deleting a row is announced
    assertion:
      type: flow
      steps:
        - do: tab
      expectedAnnouncement: Cluster deleted
    approved: true
`;

  it('has one entry per provider id the check runner gets, in its order, plus the engines that are off', async () => {
    const cfg: UsablConfig = { ...config, requirements: 'requirements/', engines: { deque: { enabled: true } } };
    const deps = depsFor({ files: { 'requirements/flows.yaml': requirementsYaml } });
    const brief = await briefFor(deps, cfg, ['src/shared/Table.tsx']);
    const clusters = brief.screens.find((screen) => screen.id === 'clusters');
    const alerts = brief.screens.find((screen) => screen.id === 'alerts');

    expect(clusters?.checks.map((check) => check.id)).toEqual([
      'axe-core',
      'pf-rulepack',
      'rhds-rulepack',
      'docs-rulepack',
      'keyboard-walk',
      'intake:delete-row',
      'deque',
      'evinced',
    ]);
    const byId = (id: string) => clusters?.checks.find((check) => check.id === id);
    expect(byId('axe-core')).toMatchObject({ applies: true });
    expect(byId('axe-core')?.why).toBeUndefined();
    expect(byId('pf-rulepack')).toMatchObject({ applies: true, why: 'decided on the page' });
    expect(byId('docs-rulepack')).toMatchObject({ applies: false, why: 'runs on docs pages only' });
    expect(byId('intake:delete-row')).toMatchObject({ applies: true, proves: expect.stringMatching(/^flow requirement: /u) });
    expect(byId('deque')).toMatchObject({ applies: true, why: expect.stringMatching(/preview/u) });
    expect(byId('evinced')).toMatchObject({ applies: false, why: 'not enabled in config' });
    for (const check of clusters?.checks ?? []) {
      expect(check.proves.length, check.id).toBeGreaterThan(10);
    }
    expect(clusters?.needsLiveScan).toBe(true);

    expect(alerts?.checks.find((check) => check.id === 'intake:delete-row')).toMatchObject({
      applies: false,
      why: 'the requirement names another screen',
    });
  });

  it('turns the docs rulepack on and the PatternFly rulepack off on a docs page', async () => {
    const deps = depsFor({ files: { 'usabl.docs.json': docsManifest } });
    const brief = await briefFor(deps, config, ['modules/getting-started.adoc']);
    const page = brief.screens[0];
    expect(page?.id).toBe('getting-started');
    expect(page?.reachedBy).toEqual([{ file: 'modules/getting-started.adoc', via: 'docs page sources' }]);
    expect(page?.checks.find((check) => check.id === 'docs-rulepack')).toMatchObject({ applies: true });
    expect(page?.checks.find((check) => check.id === 'pf-rulepack')).toMatchObject({ applies: false });
  });

  it('refuses when the requirements cannot be loaded', async () => {
    const cfg: UsablConfig = { ...config, requirements: 'requirements/' };
    const deps = depsFor();
    await expect(briefFor(deps, cfg, ['src/shared/Table.tsx'])).rejects.toThrow(/could not load the design requirements/u);
  });

  it('reports a requirement whose screen no source declares, as the gate does', async () => {
    const cfg: UsablConfig = { ...config, requirements: 'requirements/' };
    const deps = depsFor({ files: { 'requirements/flows.yaml': requirementsYaml.replace('surface: clusters', 'surface: nowhere') } });
    const result = await run(deps, cfg, { changedFiles: ['src/shared/Table.tsx'] });
    const brief = await briefFor(deps, cfg, ['src/shared/Table.tsx']);
    const runGap = result.coverage.gaps.find((gap) => gap.reason.includes('nowhere'));
    expect(runGap).toBeDefined();
    expect(brief.gaps).toContainEqual({ ref: runGap?.ref, why: runGap?.reason });
  });
});

describe('makeBrief done', () => {
  it('lists the conditions the gate needs when there is something to check', async () => {
    const brief = await briefFor(depsFor(), config, ['src/shared/Table.tsx']);
    expect(brief.nothingToCheck).toBe(false);
    expect(brief.done).toEqual([
      DONE_CONDITIONS.noBlockingFailure,
      DONE_CONDITIONS.noUnconfirmedFinding,
      DONE_CONDITIONS.coverageComplete,
      DONE_CONDITIONS.approvals,
      DONE_CONDITIONS.liveScan,
    ]);
  });

  it('says there is nothing to check when no changed file is UI, the same way the gate does', async () => {
    const deps = depsFor();
    const result = await run(deps, config, { changedFiles: ['README.md'] });
    const brief = await briefFor(deps, config, ['README.md']);
    expect(result.coverage.nothingToCheck).toBe(true);
    expect(brief.nothingToCheck).toBe(true);
    expect(brief.screens).toEqual([]);
    expect(brief.done).toEqual([DONE_CONDITIONS.nothingToCheck, DONE_CONDITIONS.approvals]);
  });

  it('names a finding usabl could not confirm, which makes the result not_covered', () => {
    expect(DONE_CONDITIONS.noUnconfirmedFinding).toMatch(/unverified/u);
    expect(DONE_CONDITIONS.noUnconfirmedFinding).toMatch(/not_covered/u);
  });

  it('says nothing to check truthfully when a policy file is dirty and the result needs approval', async () => {
    const deps = depsFor({
      files: { 'usabl.config.json': JSON.stringify({ ...config, guardedPaths: ['src/gate/'] }) },
      headContents: appFiles,
    });
    const result = await run(deps, config, { changedFiles: ['README.md', 'usabl.config.json'] });
    const brief = await briefFor(deps, config, ['README.md', 'usabl.config.json']);
    expect(result.verdict).toBe('approval_required');
    expect(result.coverage.nothingToCheck).toBe(true);
    expect(brief.nothingToCheck).toBe(true);
    expect(brief.done).toEqual([DONE_CONDITIONS.nothingToCheck, DONE_CONDITIONS.approvals]);
    // The overall result is approval_required with exit 2, so the line must not claim exit 0.
    expect(DONE_CONDITIONS.nothingToCheck).not.toMatch(/exits 0/u);
    expect(DONE_CONDITIONS.nothingToCheck).toMatch(/^No verdict from the scan/u);
    expect(DONE_CONDITIONS.nothingToCheck).toMatch(/approvals/u);
  });

  it('keeps the done lines plain: no "X, never Y" turn', () => {
    expect(DONE_CONDITIONS.coverageComplete.endsWith('A gap makes the result not_covered.')).toBe(true);
    for (const line of Object.values(DONE_CONDITIONS)) {
      expect(line).not.toMatch(/, never /u);
    }
  });

  it('carries the version, the policy source, and the files', async () => {
    const brief = await briefFor(depsFor(), config, ['src/shared/Table.tsx']);
    expect(brief.version).toBe(1);
    expect(brief.policySource).toBe('working tree');
    expect(brief.files).toEqual(['src/shared/Table.tsx']);
  });
});

describe('makeBrief output is scrubbed', () => {
  it('drops a query string and credentials from a configured url', async () => {
    const cfg: UsablConfig = {
      ...config,
      surfaces: [{ id: 'reports', url: 'http://127.0.0.1:5173/reports?preview_token=abc123', files: ['src/util.ts'] }],
    };
    const brief = await briefFor(depsFor(), cfg, ['src/util.ts']);
    expect(brief.screens[0]?.url).toBe('http://127.0.0.1:5173/reports');
    expect(JSON.stringify(brief)).not.toContain('abc123');
  });
});

describe('formatBrief', () => {
  it('prints each screen, its checks, and the done list in the brief words', async () => {
    const brief = await briefFor(depsFor(), config, ['src/shared/Table.tsx', 'src/util.ts']);
    const text = formatBrief(brief);
    expect(text).toContain('The brief is a plan. Only the gate decides a verdict.');
    expect(text).toContain('screen clusters: http://127.0.0.1:5173/clusters');
    expect(text).toContain('reached by: src/shared/Table.tsx (imported by the route entry src/ClustersPage.tsx)');
    expect(text).toContain('pf-rulepack (decided on the page)');
    expect(text).toContain('not applying: docs-rulepack (runs on docs pages only)');
    expect(text).toContain('unresolved: src/util.ts: ');
    for (const line of brief.done) {
      expect(text).toContain(`  - ${line}`);
    }
    expect(text).not.toMatch(/\u2014/u);
  });
});

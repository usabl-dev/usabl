import { describe, expect, it } from 'vitest';
import type { FsGlob, UsablConfig } from '../../src/contracts/index.js';
import { computeCoverage } from '../../src/coverage/planner.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import { run } from '../../src/run.js';

const fsOf = (files: Record<string, string>): FsGlob => makeFakeDeps({ files }).fs;
const trustedOf = (files: Record<string, string>) => async (file: string): Promise<string | null> => files[file] ?? null;

const ROUTES = JSON.stringify({
  routes: [
    { screenId: 'clusters', url: '/clusters', entryFile: 'src/ClustersPage.tsx' },
    { screenId: 'deployments', url: '/deployments', entryFile: 'src/DeploymentsPage.tsx' },
  ],
});

const appConfig: UsablConfig = {
  appBaseUrl: 'http://localhost:3000',
  uiFileGlobs: ['src/**/*.tsx'],
  discovery: { routerFile: 'src/router.tsx', wideBlastGlobs: ['src/App.tsx'] },
  surfaces: [{ id: 'settings', url: 'http://localhost:3000/settings', files: ['src/SettingsPage.tsx'] }],
  guardedPaths: ['usabl.config.json'],
};

const pkg = (fields: Record<string, unknown>): string => JSON.stringify({ name: 'app', version: '1.0.0', ...fields }, null, 2);
const BASE_PKG = pkg({ scripts: { build: 'vite build' }, dependencies: { '@patternfly/react-core': '6.1.0', react: '18.3.1' }, devDependencies: { vite: '6.0.0' } });

// A single-package app at the repository root, as the trusted ref has it.
function appTree(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'usabl.routes.json': ROUTES,
    'src/router.tsx': '',
    'src/ClustersPage.tsx': 'export default function ClustersPage() {}',
    'src/DeploymentsPage.tsx': 'export default function DeploymentsPage() {}',
    'package.json': BASE_PKG,
    ...overrides,
  };
}

const EVERY_SCREEN = [
  { screenId: 'clusters', url: 'http://localhost:3000/clusters' },
  { screenId: 'deployments', url: 'http://localhost:3000/deployments' },
  { screenId: 'settings', url: 'http://localhost:3000/settings' },
];

function expectEveryScreenFor(coverage: Awaited<ReturnType<typeof computeCoverage>>, file: string): void {
  expect(coverage.nothingToCheck).toBe(false);
  expect(coverage.gaps).toEqual([]);
  expect(coverage.unresolvedFiles).toEqual([]);
  expect(coverage.affected.map(({ screenId, url, provenance }) => ({ screenId, url, provenance }))).toEqual(
    EVERY_SCREEN.map((screen) => ({ ...screen, provenance: 'wide-blast' })),
  );
  for (const screen of coverage.affected) expect(screen.reason).toContain(file);
}

// A pull request that bumps the UI component library touches package.json and the lockfile and
// nothing in uiFileGlobs. The planner read it as nothing to check and the run exited 0, although a
// new version of the library can change every screen.
describe('dependency changes of the app', () => {
  it('checks every screen when the app package.json bumps a dependency and the lockfile changes', async () => {
    const bumped = pkg({ scripts: { build: 'vite build' }, dependencies: { '@patternfly/react-core': '6.2.0', react: '18.3.1' }, devDependencies: { vite: '6.0.0' } });
    const coverage = await computeCoverage(
      fsOf(appTree({ 'package.json': bumped, 'package-lock.json': '{"lockfileVersion":3}' })),
      appConfig,
      ['package.json', 'package-lock.json'],
      undefined,
      trustedOf(appTree({ 'package-lock.json': '{"lockfileVersion":2}' })),
    );
    expectEveryScreenFor(coverage, 'package-lock.json');
    expect(coverage.affected[0]?.reason).toBe(
      'package-lock.json is a lockfile, and a change to it can change the version of any installed package. ' +
        'package.json changed the dependency fields of the app\'s package.json. ' +
        'A dependency upgrade, such as a new version of the UI component library, can change every screen, so usabl checks every screen.',
    );
  });

  it('checks every screen when only the dependencies of the app package.json change', async () => {
    const bumped = pkg({ scripts: { build: 'vite build' }, dependencies: { '@patternfly/react-core': '6.2.0', react: '18.3.1' }, devDependencies: { vite: '6.0.0' } });
    const coverage = await computeCoverage(fsOf(appTree({ 'package.json': bumped })), appConfig, ['package.json'], undefined, trustedOf(appTree()));
    expectEveryScreenFor(coverage, 'package.json');
    expect(coverage.affected[0]?.reason).toContain('package.json changed the dependency fields of the app\'s package.json.');
  });

  it('checks every screen when only the devDependencies change', async () => {
    const bumped = pkg({ scripts: { build: 'vite build' }, dependencies: { '@patternfly/react-core': '6.1.0', react: '18.3.1' }, devDependencies: { vite: '6.1.0' } });
    const coverage = await computeCoverage(fsOf(appTree({ 'package.json': bumped })), appConfig, ['package.json'], undefined, trustedOf(appTree()));
    expectEveryScreenFor(coverage, 'package.json');
  });

  it('checks every screen when a dependency is added in a package.json that had none', async () => {
    const before = pkg({ scripts: { build: 'vite build' } });
    const after = pkg({ scripts: { build: 'vite build' }, dependencies: { '@patternfly/react-core': '6.2.0' } });
    const coverage = await computeCoverage(
      fsOf(appTree({ 'package.json': after })),
      appConfig,
      ['package.json'],
      undefined,
      trustedOf(appTree({ 'package.json': before })),
    );
    expectEveryScreenFor(coverage, 'package.json');
  });

  for (const lockfile of ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb']) {
    it(`checks every screen when the root lockfile ${lockfile} changes alone`, async () => {
      const coverage = await computeCoverage(fsOf(appTree({ [lockfile]: 'changed' })), appConfig, [lockfile], undefined, trustedOf(appTree()));
      expectEveryScreenFor(coverage, lockfile);
    });
  }

  it('reads a package.json change to scripts and metadata only as nothing to check', async () => {
    const edited = pkg({
      version: '1.1.0',
      description: 'The admin console',
      scripts: { build: 'vite build', lint: 'eslint .' },
      dependencies: { '@patternfly/react-core': '6.1.0', react: '18.3.1' },
      devDependencies: { vite: '6.0.0' },
    });
    const coverage = await computeCoverage(fsOf(appTree({ 'package.json': edited })), appConfig, ['package.json'], undefined, trustedOf(appTree()));
    expect(coverage).toEqual({ changedFiles: ['package.json'], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: true });
  });

  // Each of these fields can change which version of a package is installed. Counting one that
  // does not can only add checks.
  for (const [field, value] of [
    ['peerDependencies', { peerDependencies: { react: '>=18' } }],
    ['optionalDependencies', { optionalDependencies: { fsevents: '2.3.3' } }],
    ['overrides', { overrides: { '@patternfly/react-core': '6.2.0' } }],
    ['resolutions', { resolutions: { '@patternfly/react-core': '6.2.0' } }],
    ['pnpm.overrides', { pnpm: { overrides: { '@patternfly/react-core': '6.2.0' } } }],
  ] as const) {
    it(`checks every screen when only ${field} changes`, async () => {
      const edited = pkg({
        scripts: { build: 'vite build' },
        dependencies: { '@patternfly/react-core': '6.1.0', react: '18.3.1' },
        devDependencies: { vite: '6.0.0' },
        ...value,
      });
      const coverage = await computeCoverage(fsOf(appTree({ 'package.json': edited })), appConfig, ['package.json'], undefined, trustedOf(appTree()));
      expectEveryScreenFor(coverage, 'package.json');
    });
  }

  it('reads a change to other pnpm settings as nothing to check', async () => {
    const edited = pkg({
      scripts: { build: 'vite build' },
      dependencies: { '@patternfly/react-core': '6.1.0', react: '18.3.1' },
      devDependencies: { vite: '6.0.0' },
      pnpm: { onlyBuiltDependencies: ['esbuild'] },
    });
    const coverage = await computeCoverage(fsOf(appTree({ 'package.json': edited })), appConfig, ['package.json'], undefined, trustedOf(appTree()));
    expect(coverage.nothingToCheck).toBe(true);
  });

  it('reads a reordered and reformatted dependency list as the same dependencies', async () => {
    const reordered = JSON.stringify({
      devDependencies: { vite: '6.0.0' },
      dependencies: { react: '18.3.1', '@patternfly/react-core': '6.1.0' },
      scripts: { build: 'vite build' },
      version: '1.0.0',
      name: 'app',
    });
    const coverage = await computeCoverage(fsOf(appTree({ 'package.json': reordered })), appConfig, ['package.json'], undefined, trustedOf(appTree()));
    expect(coverage.nothingToCheck).toBe(true);
  });

  it('checks every screen when the app package.json does not parse, and says why', async () => {
    const coverage = await computeCoverage(fsOf(appTree({ 'package.json': '{ "dependencies": ' })), appConfig, ['package.json'], undefined, trustedOf(appTree()));
    expect(coverage.affected.map((screen) => [screen.screenId, screen.provenance])).toEqual(EVERY_SCREEN.map((screen) => [screen.screenId, 'wide-blast']));
    expect(coverage.affected[0]?.reason).toContain('could not read it as JSON');
    // The workspace rule cannot read the root manifest either, and says so in its own gap.
    expect(coverage.gaps.map((gap) => [gap.ref, gap.state])).toEqual([['package.json', 'not-covered']]);
  });

  it('checks every screen when the app package.json does not parse at the trusted ref', async () => {
    const coverage = await computeCoverage(fsOf(appTree()), appConfig, ['package.json'], undefined, trustedOf(appTree({ 'package.json': 'not json' })));
    expect(coverage.affected.map((screen) => [screen.screenId, screen.provenance])).toEqual(EVERY_SCREEN.map((screen) => [screen.screenId, 'wide-blast']));
    expect(coverage.affected[0]?.reason).toContain('could not read it as JSON at the trusted ref');
    expect(coverage.gaps.map((gap) => [gap.ref, gap.state])).toEqual([['package.json', 'not-covered']]);
  });

  it('checks every screen when there is no trusted version of package.json to compare with', async () => {
    const coverage = await computeCoverage(fsOf(appTree()), appConfig, ['package.json']);
    expectEveryScreenFor(coverage, 'package.json');
    expect(coverage.affected[0]?.reason).toContain('no trusted version to compare it with');
  });

  it('records a gap, not nothing to check, when there is no screen to check', async () => {
    const config: UsablConfig = { ...appConfig, surfaces: [] };
    const tree = { 'src/router.tsx': '', 'package.json': BASE_PKG, 'yarn.lock': 'changed' };
    const coverage = await computeCoverage(fsOf(tree), config, ['yarn.lock'], undefined, trustedOf({ 'package.json': BASE_PKG }));
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.affected).toEqual([]);
    expect(coverage.unresolvedFiles).toEqual(['yarn.lock']);
    expect(coverage.gaps).toEqual([
      {
        ref: 'yarn.lock',
        state: 'unresolved',
        reason: expect.stringContaining('usabl found no screen to check'),
      },
    ]);
  });

  it('keeps the reason when a dependency change and a wide-blast file change together', async () => {
    const coverage = await computeCoverage(
      fsOf(appTree({ 'yarn.lock': 'changed', 'src/App.tsx': '' })),
      appConfig,
      ['src/App.tsx', 'yarn.lock'],
      undefined,
      trustedOf(appTree()),
    );
    expectEveryScreenFor(coverage, 'yarn.lock');
  });

  it('gives the same plan whatever order the changed files come in', async () => {
    const tree = appTree({ 'yarn.lock': 'changed', 'package-lock.json': 'changed' });
    const first = await computeCoverage(fsOf(tree), appConfig, ['yarn.lock', 'package-lock.json'], undefined, trustedOf(appTree()));
    const second = await computeCoverage(fsOf(tree), appConfig, ['package-lock.json', 'yarn.lock'], undefined, trustedOf(appTree()));
    expect(second.affected).toEqual(first.affected);
  });
});

// The app lives in packages/admin of a workspace. Its own package.json and lockfile, and the
// repository root lockfile, are its dependency files. Another package's are not.
describe('dependency changes of an app in a monorepo', () => {
  const adminConfig: UsablConfig = {
    appBaseUrl: 'http://localhost:5173',
    uiFileGlobs: ['packages/admin/src/**/*.tsx'],
    discovery: { routerFile: 'packages/admin/src/App.tsx', wideBlastGlobs: ['packages/admin/src/main.tsx'] },
    surfaces: [],
    guardedPaths: ['usabl.config.json'],
  };
  const tree = (overrides: Record<string, string> = {}): Record<string, string> => ({
    'package.json': JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    'usabl.routes.json': JSON.stringify({ routes: [{ screenId: 'home', url: '/', entryFile: 'packages/admin/src/Home.tsx' }] }),
    'packages/admin/package.json': JSON.stringify({ name: '@mono/admin', dependencies: { '@patternfly/react-core': '6.1.0' } }),
    'packages/admin/src/App.tsx': '',
    'packages/admin/src/Home.tsx': 'export default function Home() {}',
    'packages/web/package.json': JSON.stringify({ name: '@mono/web', dependencies: { lodash: '4.0.0' } }),
    ...overrides,
  });

  it('checks every screen when the app package bumps a dependency', async () => {
    const bumped = JSON.stringify({ name: '@mono/admin', dependencies: { '@patternfly/react-core': '6.2.0' } });
    const coverage = await computeCoverage(
      fsOf(tree({ 'packages/admin/package.json': bumped })),
      adminConfig,
      ['packages/admin/package.json'],
      undefined,
      trustedOf(tree()),
    );
    expect(coverage.nothingToCheck).toBe(false);
    expect(coverage.gaps).toEqual([]);
    expect(coverage.affected).toEqual([
      expect.objectContaining({ screenId: 'home', provenance: 'wide-blast', reason: expect.stringContaining('packages/admin/package.json') }),
    ]);
  });

  for (const lockfile of ['pnpm-lock.yaml', 'packages/admin/package-lock.json']) {
    it(`checks every screen when ${lockfile} changes`, async () => {
      const coverage = await computeCoverage(fsOf(tree({ [lockfile]: 'changed' })), adminConfig, [lockfile], undefined, trustedOf(tree()));
      expect(coverage.affected).toEqual([expect.objectContaining({ screenId: 'home', provenance: 'wide-blast', reason: expect.stringContaining(lockfile) })]);
    });
  }

  it('reads a dependency change in another package of the workspace, which the app does not depend on, as nothing to check', async () => {
    const bumped = JSON.stringify({ name: '@mono/web', dependencies: { lodash: '4.1.0' } });
    const coverage = await computeCoverage(
      fsOf(tree({ 'packages/web/package.json': bumped, 'packages/web/yarn.lock': 'changed' })),
      adminConfig,
      ['packages/web/package.json', 'packages/web/yarn.lock'],
      undefined,
      trustedOf(tree()),
    );
    expect(coverage.nothingToCheck).toBe(true);
  });
});

// Where the app's package.json files are found: every folder on the climb from each place the
// config points into, up to the repository root.
describe('the folders of the app', () => {
  const tree = (overrides: Record<string, string> = {}): Record<string, string> => ({
    'package.json': JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    'usabl.routes.json': JSON.stringify({ routes: [{ screenId: 'home', url: '/', entryFile: 'packages/admin/src/Home.tsx' }] }),
    'packages/admin/package.json': JSON.stringify({ name: '@mono/admin', dependencies: { '@patternfly/react-core': '6.1.0' } }),
    'packages/admin/src/App.tsx': '',
    'packages/admin/src/Home.tsx': 'export default function Home() {}',
    ...overrides,
  });
  const config: UsablConfig = {
    appBaseUrl: 'http://localhost:5173',
    uiFileGlobs: ['packages/admin/src/**/*.tsx'],
    discovery: { routerFile: 'packages/admin/src/App.tsx', wideBlastGlobs: [] },
    surfaces: [],
    guardedPaths: ['usabl.config.json'],
  };
  const BUMPED = JSON.stringify({ name: '@mono/admin', dependencies: { '@patternfly/react-core': '6.2.0' } });

  // A pull request that adds a package.json below the real manifest. The nearest manifest to the
  // anchors is then the added one, and a bump of the real manifest read as nothing to check.
  it('still counts a bump of the real manifest when the pull request adds a package.json below it', async () => {
    const added = JSON.stringify({ name: 'decoy', private: true });
    const coverage = await computeCoverage(
      fsOf(tree({ 'packages/admin/package.json': BUMPED, 'packages/admin/src/package.json': added })),
      config,
      ['packages/admin/package.json', 'packages/admin/src/package.json'],
      undefined,
      trustedOf(tree()),
    );
    expect(coverage.affected).toEqual([
      expect.objectContaining({ screenId: 'home', provenance: 'wide-blast', reason: expect.stringContaining('packages/admin/package.json changed') }),
    ]);
    // The added file declares no dependency fields, the same as the missing file it replaces.
    expect(coverage.affected[0]?.reason).not.toContain('packages/admin/src/package.json');
  });

  it('reads an added package.json with no dependency fields as nothing to check', async () => {
    const coverage = await computeCoverage(
      fsOf(tree({ 'packages/admin/src/package.json': JSON.stringify({ name: 'decoy' }) })),
      config,
      ['packages/admin/src/package.json'],
      undefined,
      trustedOf(tree()),
    );
    expect(coverage.nothingToCheck).toBe(true);
  });

  it('counts a deleted package.json that declared dependencies', async () => {
    const files = tree();
    delete files['packages/admin/package.json'];
    const coverage = await computeCoverage(fsOf(files), config, ['packages/admin/package.json'], undefined, trustedOf(tree()));
    expect(coverage.affected).toEqual([expect.objectContaining({ screenId: 'home', provenance: 'wide-blast' })]);
  });

  it('counts the root package.json of a monorepo, which is on the climb from the app', async () => {
    const root = JSON.stringify({ private: true, workspaces: ['packages/*'], devDependencies: { '@patternfly/react-core': '6.2.0' } });
    const coverage = await computeCoverage(fsOf(tree({ 'package.json': root })), config, ['package.json'], undefined, trustedOf(tree()));
    expect(coverage.affected).toEqual([expect.objectContaining({ screenId: 'home', provenance: 'wide-blast', reason: expect.stringContaining('package.json changed') })]);
  });

  it('reads an anchor with a leading slash from the repository root', async () => {
    const slashed: UsablConfig = { ...config, uiFileGlobs: ['/packages/admin/src/**/*.tsx'], discovery: { routerFile: '/packages/admin/src/App.tsx', wideBlastGlobs: [] } };
    const coverage = await computeCoverage(fsOf(tree({ 'packages/admin/package.json': BUMPED })), slashed, ['packages/admin/package.json'], undefined, trustedOf(tree()));
    expect(coverage.affected).toEqual([expect.objectContaining({ screenId: 'home', provenance: 'wide-blast' })]);
  });

  it('follows an anchor with ../ inside the repository, and never reads one that leaves it', async () => {
    const reads: string[] = [];
    const base = fsOf(tree({ 'packages/admin/package.json': BUMPED }));
    const recording: FsGlob = {
      readFile: async (file) => {
        reads.push(file);
        return base.readFile(file);
      },
      glob: (patterns) => base.glob(patterns),
    };
    const dotted: UsablConfig = {
      ...config,
      uiFileGlobs: ['packages/web/../admin/src/**/*.tsx', '../elsewhere/src/**/*.tsx'],
      discovery: { routerFile: '../elsewhere/src/App.tsx', wideBlastGlobs: [] },
    };
    const coverage = await computeCoverage(recording, dotted, ['packages/admin/package.json'], undefined, trustedOf(tree()));
    expect(coverage.affected).toEqual([expect.objectContaining({ screenId: 'home', provenance: 'wide-blast' })]);
    expect(reads.filter((file) => file.includes('elsewhere') && file.endsWith('package.json'))).toEqual([]);
  });
});

// A configured surface carries its own readiness signal and requirements, which the scan looks up
// by its screen id. Queuing surfaces by url dropped a surface whose url a route or another surface
// already had, so it was never checked on a dependency change, while every other surface was.
describe('surfaces that share a url on a dependency change', () => {
  const lockChange = async (config: UsablConfig) =>
    computeCoverage(
      fsOf(appTree({ 'package-lock.json': '{"lockfileVersion":3}' })),
      config,
      ['package-lock.json'],
      undefined,
      trustedOf(appTree({ 'package-lock.json': '{"lockfileVersion":2}' })),
    );

  it('queues two surfaces that share one url, each under its own id', async () => {
    const config: UsablConfig = {
      ...appConfig,
      surfaces: [
        { id: 'settings', url: 'http://localhost:3000/settings', files: ['src/SettingsPage.tsx'] },
        { id: 'settings-dialog', url: 'http://localhost:3000/settings', files: ['src/SettingsDialog.tsx'], reachedWhen: '[role="dialog"]' },
      ],
    };
    const coverage = await lockChange(config);
    expect(coverage.affected.map(({ screenId, url }) => ({ screenId, url }))).toEqual([
      { screenId: 'clusters', url: 'http://localhost:3000/clusters' },
      { screenId: 'deployments', url: 'http://localhost:3000/deployments' },
      { screenId: 'settings', url: 'http://localhost:3000/settings' },
      { screenId: 'settings-dialog', url: 'http://localhost:3000/settings' },
    ]);
    for (const screen of coverage.affected) expect(screen.provenance).toBe('wide-blast');
  });

  it('queues a surface that shares a url with a discovered route, under its own id', async () => {
    const config: UsablConfig = {
      ...appConfig,
      surfaces: [{ id: 'clusters-empty', url: 'http://localhost:3000/clusters', files: ['src/ClustersEmpty.tsx'] }],
    };
    const coverage = await lockChange(config);
    expect(coverage.affected.map(({ screenId, url }) => ({ screenId, url }))).toEqual([
      { screenId: 'clusters', url: 'http://localhost:3000/clusters' },
      { screenId: 'deployments', url: 'http://localhost:3000/deployments' },
      { screenId: 'clusters-empty', url: 'http://localhost:3000/clusters' },
    ]);
  });

  it('still queues a surface that overrides a discovered route once, under the shared id', async () => {
    const config: UsablConfig = {
      ...appConfig,
      surfaces: [{ id: 'clusters', url: 'http://localhost:3000/clusters', files: [], overridesDiscoveredRoute: true }],
    };
    const coverage = await lockChange(config);
    expect(coverage.affected.map((screen) => screen.screenId)).toEqual(['clusters', 'deployments']);
  });

  it('is scanned by a run under each id', async () => {
    const config: UsablConfig = {
      ...appConfig,
      surfaces: [
        { id: 'settings', url: 'http://localhost:3000/settings', files: ['src/SettingsPage.tsx'] },
        { id: 'settings-dialog', url: 'http://localhost:3000/settings', files: ['src/SettingsDialog.tsx'] },
        { id: 'clusters-empty', url: 'http://localhost:3000/clusters', files: ['src/ClustersEmpty.tsx'] },
      ],
    };
    const files = appTree({ 'package-lock.json': '{"lockfileVersion":3}' });
    const head = appTree({ 'package-lock.json': '{"lockfileVersion":2}' });
    const fake = makeFakeDeps({ files, headContents: head });
    const scanned: string[] = [];
    const deps = {
      ...fake,
      checkRunner: {
        scan: async (screen: { id: string; url: string }) => {
          scanned.push(screen.id);
          return fake.checkRunner.scan(screen);
        },
      },
    };
    await run(deps, config, { changedFiles: ['package-lock.json'] });
    expect([...scanned].sort()).toEqual(['clusters', 'clusters-empty', 'deployments', 'settings', 'settings-dialog']);
  });
});

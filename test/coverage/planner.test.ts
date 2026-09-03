import { describe, it, expect } from 'vitest';
import { computeCoverage } from '../../src/coverage/planner.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import type { UsablConfig } from '../../src/contracts/index.js';

const fsOf = (files: Record<string, string>) => makeFakeDeps({ files }).fs;

const baseConfig: UsablConfig = {
  appBaseUrl: 'http://localhost:3000',
  uiFileGlobs: ['src/**/*.tsx'],
  discovery: { routerFile: 'src/router.tsx', wideBlastGlobs: ['src/App.tsx'] },
  surfaces: [],
  guardedPaths: ['usabl.config.json'],
};

describe('computeCoverage', () => {
  it('ignores co-located test and spec files that match a broad UI glob', async () => {
    const cov = await computeCoverage(fsOf({ 'src/router.tsx': '' }), baseConfig, [
      'src/pages/Deployments.test.tsx',
      'src/pages/Clusters.spec.tsx',
    ]);

    expect(cov.nothingToCheck).toBe(true);
    expect(cov.unresolvedFiles).toEqual([]);
    expect(cov.gaps).toEqual([]);
  });

  it('ignores UI files under a test directory', async () => {
    const cov = await computeCoverage(fsOf({ 'src/router.tsx': '' }), baseConfig, [
      'src/pages/__tests__/Deployments.tsx',
      'src/test/fixture.tsx',
      'test/browser/demo.tsx',
    ]);

    expect(cov.nothingToCheck).toBe(true);
  });

  it('returns nothingToCheck when no UI files changed', async () => {
    const cov = await computeCoverage(fsOf({ 'src/router.tsx': '' }), baseConfig, ['docs/README.md']);
    expect(cov.nothingToCheck).toBe(true);
    expect(cov.gaps).toHaveLength(0);
  });

  it('classifies a changed .tsx file as UI under a {ts,tsx} brace glob rather than a false green', async () => {
    // The common React glob src/**/*.{ts,tsx} must agree with discovery. If matchGlob
    // could not expand the brace group, App.tsx would be dropped from uiFiles, the run
    // would report nothingToCheck, and the exit code would be a silent green.
    const braceConfig: UsablConfig = {
      ...baseConfig,
      uiFileGlobs: ['src/**/*.{ts,tsx}'],
      discovery: { routerFile: 'src/router.tsx', wideBlastGlobs: ['src/**/*.{ts,tsx}'] },
    };
    const cov = await computeCoverage(fsOf({ 'src/router.tsx': '' }), braceConfig, ['src/App.tsx']);
    expect(cov.nothingToCheck).toBe(false);
  });

  it('maps a changed UI file to an affected screen via the sidecar route manifest', async () => {
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [{ screenId: 'clusters', url: '/clusters', entryFile: 'src/ClustersPage.tsx' }],
      }),
      'src/ClustersPage.tsx': `export default function ClustersPage() {}`,
    });
    const cov = await computeCoverage(fs, baseConfig, ['src/ClustersPage.tsx']);
    expect(cov.nothingToCheck).toBe(false);
    expect(cov.affected.some((s) => s.screenId === 'clusters' && s.provenance === 'route-graph')).toBe(true);
    expect(cov.unresolvedFiles).toHaveLength(0);
    expect(cov.gaps).toHaveLength(0);
  });

  it('uses manual surface url override for route-mapped screen variants', async () => {
    const cfg: UsablConfig = {
      ...baseConfig,
      surfaces: [
        {
          id: 'clusters',
          url: 'http://localhost:3000/clusters?variant=fixed',
          files: ['src/ClustersPage.tsx'],
        },
      ],
    };
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [{ screenId: 'clusters', url: '/clusters', entryFile: 'src/ClustersPage.tsx' }],
      }),
      'src/ClustersPage.tsx': `export default function ClustersPage() {}`,
    });
    const cov = await computeCoverage(fs, cfg, ['src/ClustersPage.tsx']);
    expect(cov.affected).toContainEqual(
      expect.objectContaining({
        screenId: 'clusters',
        url: 'http://localhost:3000/clusters?variant=fixed',
        provenance: 'route-graph',
      }),
    );
  });

  it('rejects sidecar routes that point at a different origin', async () => {
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [{ screenId: 'clusters', url: 'https://evil.example/p', entryFile: 'src/ClustersPage.tsx' }],
      }),
      'src/ClustersPage.tsx': `export default function ClustersPage() {}`,
    });

    await expect(computeCoverage(fs, baseConfig, ['src/ClustersPage.tsx'])).rejects.toThrow(/url/i);
  });

  it('populates a gap with a reason for a UI file that maps to no screen', async () => {
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({ routes: [] }),
      'src/Orphan.tsx': `export default function Orphan() {}`,
    });
    const cov = await computeCoverage(fs, baseConfig, ['src/Orphan.tsx']);
    expect(cov.unresolvedFiles).toContain('src/Orphan.tsx');
    expect(cov.gaps).toHaveLength(1);
    expect(cov.gaps[0]!.state).toBe('unresolved');
    expect(cov.gaps[0]!.reason).not.toBe('');
  });

  it('wide-blast: a changed global file touches every known route', async () => {
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [
          { screenId: 'clusters', url: '/clusters', entryFile: 'src/ClustersPage.tsx' },
          { screenId: 'alerts', url: '/alerts', entryFile: null },
        ],
      }),
      'src/App.tsx': `export default function App() {}`,
    });
    const cov = await computeCoverage(fs, baseConfig, ['src/App.tsx']);
    expect(cov.affected).toHaveLength(2);
    expect(cov.affected.every((s) => s.provenance === 'wide-blast')).toBe(true);
  });

  it('keeps manual surfaces additive when wide-blast already queued discovered routes', async () => {
    const cfg: UsablConfig = {
      ...baseConfig,
      surfaces: [{ id: 'admin', url: '/admin', files: ['src/App.tsx'] }],
    };
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [{ screenId: 'home', url: '/home', entryFile: 'src/Home.tsx' }],
      }),
      'src/App.tsx': `export default function App() {}`,
      'src/Home.tsx': `export default function Home() {}`,
    });
    const cov = await computeCoverage(fs, cfg, ['src/App.tsx']);
    expect(cov.affected).toHaveLength(2);
    expect(cov.affected.some((s) => s.screenId === 'home' && s.provenance === 'wide-blast')).toBe(true);
    expect(cov.affected.some((s) => s.screenId === 'admin' && s.provenance === 'manual')).toBe(true);
    expect(cov.unresolvedFiles).toEqual([]);
    expect(cov.gaps).toEqual([]);
  });

  it('records unresolved coverage when wide-blast matches and no routes exist', async () => {
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({ routes: [] }),
      'src/App.tsx': `export default function App() {}`,
    });
    const cov = await computeCoverage(fs, baseConfig, ['src/App.tsx']);
    expect(cov.nothingToCheck).toBe(false);
    expect(cov.affected).toEqual([]);
    expect(cov.unresolvedFiles).toEqual(['src/App.tsx']);
    expect(cov.gaps).toHaveLength(1);
    expect(cov.gaps[0]!.state).toBe('unresolved');
    expect(cov.gaps[0]!.reason).not.toBe('');
  });

  it('uses manual surfaces when wide-blast matches and no routes exist', async () => {
    const cfg: UsablConfig = {
      ...baseConfig,
      surfaces: [{ id: 'login', url: '/login', files: ['src/App.tsx'] }],
    };
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({ routes: [] }),
      'src/App.tsx': `export default function App() {}`,
    });
    const cov = await computeCoverage(fs, cfg, ['src/App.tsx']);
    expect(cov.affected.some((s) => s.screenId === 'login' && s.provenance === 'manual')).toBe(true);
    expect(cov.unresolvedFiles).toEqual([]);
    expect(cov.gaps).toEqual([]);
  });

  it('manual surface config is an additive fallback', async () => {
    const cfg: UsablConfig = {
      ...baseConfig,
      surfaces: [{ id: 'login', url: '/login', files: ['src/LoginPage.tsx'] }],
    };
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({ routes: [] }),
      'src/LoginPage.tsx': `export default function LoginPage() {}`,
    });
    const cov = await computeCoverage(fs, cfg, ['src/LoginPage.tsx']);
    expect(cov.affected.some((s) => s.screenId === 'login' && s.provenance === 'manual')).toBe(true);
  });

  it('does not infer route-graph attribution from regex-fallback routes', async () => {
    const fs = fsOf({
      'src/router.tsx': `<Route path="/clusters" element={<ClustersPage />} />`,
      'src/Child.tsx': `export default function Child() {}`,
    });
    const cov = await computeCoverage(fs, baseConfig, ['src/Child.tsx']);
    expect(cov.affected).toEqual([]);
    expect(cov.unresolvedFiles).toEqual(['src/Child.tsx']);
    expect(cov.gaps).toHaveLength(1);
    expect(cov.gaps[0]!.state).toBe('unresolved');
    expect(cov.gaps[0]!.reason).not.toBe('');
  });
});

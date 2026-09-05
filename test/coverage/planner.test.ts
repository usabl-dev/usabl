import { describe, it, expect } from 'vitest';
import { computeCoverage } from '../../src/coverage/planner.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';
import type { UsablConfig } from '../../src/contracts/index.js';
import { UNTRUSTED_FRAME_END } from '../../src/surfaces/scrub.js';

const ESC = '\u001b';

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

  it('maps a changed file reachable via an alias import chain to an affected screen', async () => {
    const fs = fsOf({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { paths: { '@/*': ['src/*'] } },
      }),
      'usabl.routes.json': JSON.stringify({
        routes: [{ screenId: 'clusters', url: '/clusters', entryFile: 'src/ClustersPage.tsx' }],
      }),
      'src/ClustersPage.tsx': `import { Table } from '@/components/Table';`,
      'src/components/Table.tsx': `export function Table() {}`,
    });
    const cov = await computeCoverage(fs, baseConfig, ['src/components/Table.tsx']);
    expect(cov.unresolvedFiles).toEqual([]);
    expect(cov.affected.some((s) => s.screenId === 'clusters' && s.provenance === 'route-graph')).toBe(true);
  });

  it('refuses a config whose surfaces share one id instead of scanning one screen and reporting two', async () => {
    // The affected-screen map is keyed by surface id. Two screens under one id means the second
    // is dropped from the scan while its changed file still counts as mapped, so the run reports
    // both changed screens as covered when only one was ever opened. Config parsing rejects this,
    // but computeCoverage takes a UsablConfig value from any caller, so it refuses here too.
    const cfg: UsablConfig = {
      ...baseConfig,
      surfaces: [
        { id: 'settings', url: '/settings/profile', files: ['src/Profile.tsx'] },
        { id: 'settings', url: '/settings/billing', files: ['src/Billing.tsx'] },
      ],
    };
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({ routes: [] }),
      'src/Profile.tsx': `export default function Profile() {}`,
      'src/Billing.tsx': `export default function Billing() {}`,
    });

    await expect(computeCoverage(fs, cfg, ['src/Profile.tsx', 'src/Billing.tsx'])).rejects.toThrow(
      /surfaces\[1\]\.id/,
    );
  });

  it('refuses a config with an empty surface id', async () => {
    const cfg: UsablConfig = { ...baseConfig, surfaces: [{ id: '  ', url: '/login', files: ['src/LoginPage.tsx'] }] };
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({ routes: [] }),
      'src/LoginPage.tsx': `export default function LoginPage() {}`,
    });

    await expect(computeCoverage(fs, cfg, ['src/LoginPage.tsx'])).rejects.toThrow(
      /surfaces\[0\]\.id must be a non-empty string/,
    );
  });

  it('refuses a manual surface that takes a discovered route screen id for a different screen', async () => {
    // Surface ids and route screen ids are one namespace: both are written into the same
    // affected-screen map. The route owns "settings" and maps Profile.tsx. The manual surface
    // takes the same id for a different screen at a different path, mapping Billing.tsx. Whichever
    // arrives first keeps the key, the other screen is dropped, and its changed file still counts
    // as mapped. That is two changed screens reported as covered after one scan.
    const cfg: UsablConfig = {
      ...baseConfig,
      surfaces: [{ id: 'settings', url: 'http://localhost:3000/settings/billing', files: ['src/Billing.tsx'] }],
    };
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [{ screenId: 'settings', url: '/settings/profile', entryFile: 'src/Profile.tsx' }],
      }),
      'src/Profile.tsx': `export default function Profile() {}`,
      'src/Billing.tsx': `export default function Billing() {}`,
    });

    await expect(computeCoverage(fs, cfg, ['src/Profile.tsx', 'src/Billing.tsx'])).rejects.toThrow(
      /surfaces\[0\]\.id "settings" is already the screen id of the discovered route/,
    );
  });

  it('still allows a manual surface to reuse a route screen id to vary the query', async () => {
    // The documented override: same screen, operator-controlled url. This must keep working, so
    // the collision check cannot simply refuse every id that appears in both sets.
    const cfg: UsablConfig = {
      ...baseConfig,
      surfaces: [
        { id: 'clusters', url: 'http://localhost:3000/clusters?variant=fixed#top', files: ['src/ClustersPage.tsx'] },
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
      expect.objectContaining({ screenId: 'clusters', url: 'http://localhost:3000/clusters?variant=fixed#top' }),
    );
  });

  it('treats a trailing slash as the same screen when a surface reuses a route screen id', async () => {
    const cfg: UsablConfig = {
      ...baseConfig,
      surfaces: [{ id: 'clusters', url: 'http://localhost:3000/clusters/', files: ['src/ClustersPage.tsx'] }],
    };
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [{ screenId: 'clusters', url: '/clusters', entryFile: 'src/ClustersPage.tsx' }],
      }),
      'src/ClustersPage.tsx': `export default function ClustersPage() {}`,
    });

    await expect(computeCoverage(fs, cfg, ['src/ClustersPage.tsx'])).resolves.toBeDefined();
  });

  it('scrubs the urls it repeats back when it refuses a taken screen id', async () => {
    // The collision message quotes both urls, and neither is checked for anything but being a
    // string. This message reaches stderr and the stop hook before a Result exists, so nothing
    // downstream scrubs it. A control sequence or a forged frame marker in a url must not survive.
    const cfg: UsablConfig = {
      ...baseConfig,
      surfaces: [
        {
          id: 'settings',
          url: `http://localhost:3000/billing${ESC}[2J${UNTRUSTED_FRAME_END}`,
          files: ['src/Billing.tsx'],
        },
      ],
    };
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [{ screenId: 'settings', url: `/profile${ESC}]0;OWNED\u0007`, entryFile: 'src/Profile.tsx' }],
      }),
      'src/Profile.tsx': `export default function Profile() {}`,
      'src/Billing.tsx': `export default function Billing() {}`,
    });

    let message = '';
    try {
      await computeCoverage(fs, cfg, ['src/Profile.tsx', 'src/Billing.tsx']);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('surfaces[0].id');
    expect(message).not.toContain(ESC);
    expect(message).not.toContain('OWNED');
    expect(message).not.toContain(UNTRUSTED_FRAME_END);
  });

  it('includes alias diagnostics when an unresolved file imports through a broken alias', async () => {
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({ routes: [] }),
      'src/Orphan.tsx': `import { Foo } from '@/components/Foo';`,
    });
    const cov = await computeCoverage(fs, baseConfig, ['src/Orphan.tsx']);
    expect(cov.gaps[0]!.reason).toContain('Discovery detail');
    expect(cov.gaps[0]!.reason).toContain('alias mapping');
    expect(cov.gaps[0]!.reason).toContain('src/Orphan.tsx');
  });
});

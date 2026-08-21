import { describe, it, expect } from 'vitest';
import { parseRouteManifest } from '../../src/coverage/route-manifest.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';

const fsOf = (files: Record<string, string>) => makeFakeDeps({ files }).fs;

describe('parseRouteManifest', () => {
  it('loads a JSON sidecar when present', async () => {
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [{ screenId: 'clusters', url: '/clusters', entryFile: 'src/ClustersPage.tsx' }],
      }),
    });
    const manifest = await parseRouteManifest(fs, { routerFile: 'src/router.tsx', wideBlastGlobs: [] });
    expect(manifest.routes).toHaveLength(1);
    expect(manifest.routes[0]!.screenId).toBe('clusters');
    expect(manifest.routes[0]!.entryFile).toBe('src/ClustersPage.tsx');
  });

  it('falls back to regex extraction with entryFile null (no attribution invented)', async () => {
    const fs = fsOf({
      'src/router.tsx': `
        <Route path="/alerts" element={<AlertsPage />} />
        <Route path="/hosts"  element={<HostsPage />} />
      `,
    });
    const manifest = await parseRouteManifest(fs, { routerFile: 'src/router.tsx', wideBlastGlobs: [] });
    expect(manifest.routes.map((r) => r.screenId).sort()).toEqual(['alerts', 'hosts']);
    expect(manifest.routes.every((r) => r.entryFile === null)).toBe(true);
  });

  it('maps nested fallback URLs to dash-joined screen ids', async () => {
    const fs = fsOf({
      'src/router.tsx': `
        <Route path="/settings/profile" element={<ProfilePage />} />
      `,
    });
    const manifest = await parseRouteManifest(fs, { routerFile: 'src/router.tsx', wideBlastGlobs: [] });
    expect(manifest.routes).toEqual([{ screenId: 'settings-profile', url: '/settings/profile', entryFile: null }]);
  });

  it('maps fallback root path to screen id root', async () => {
    const fs = fsOf({
      'src/router.tsx': `
        <Route path="/" element={<HomePage />} />
      `,
    });
    const manifest = await parseRouteManifest(fs, { routerFile: 'src/router.tsx', wideBlastGlobs: [] });
    expect(manifest.routes).toEqual([{ screenId: 'root', url: '/', entryFile: null }]);
  });

  it('returns an empty manifest when neither source exists', async () => {
    const manifest = await parseRouteManifest(fsOf({}), { routerFile: 'src/router.tsx', wideBlastGlobs: [] });
    expect(manifest.routes).toHaveLength(0);
  });

  it('keeps sidecar null entryFile values as null', async () => {
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [{ screenId: 'root', url: '/', entryFile: null }],
      }),
    });
    const manifest = await parseRouteManifest(fs, { routerFile: 'src/router.tsx', wideBlastGlobs: [] });
    expect(manifest.routes).toEqual([{ screenId: 'root', url: '/', entryFile: null }]);
  });

  it('throws when sidecar routes is not an array', async () => {
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: { screenId: 'clusters', url: '/clusters', entryFile: 'src/ClustersPage.tsx' },
      }),
    });
    await expect(parseRouteManifest(fs, { routerFile: 'src/router.tsx', wideBlastGlobs: [] })).rejects.toThrow(
      /routes/,
    );
  });
});

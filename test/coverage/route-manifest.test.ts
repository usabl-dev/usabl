import { describe, it, expect } from 'vitest';
import { parseRouteManifest } from '../../src/coverage/route-manifest.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';

const fsOf = (files: Record<string, string>) => makeFakeDeps({ files }).fs;

describe('parseRouteManifest', () => {
  it('rejects sidecar routes whose url contains @', async () => {
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [{ screenId: 'x', url: '@169.254.169.254/latest', entryFile: 'src/X.tsx' }],
      }),
    });

    await expect(parseRouteManifest(fs, { routerFile: 'src/router.tsx', wideBlastGlobs: [] })).rejects.toThrow(/url/i);
  });

  it('rejects sidecar routes that reuse a screenId for different URLs', async () => {
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [
          { screenId: 'main', url: '/decoy', entryFile: 'src/Decoy.tsx' },
          { screenId: 'main', url: '/real', entryFile: 'src/Real.tsx' },
        ],
      }),
    });

    await expect(parseRouteManifest(fs, { routerFile: 'src/router.tsx', wideBlastGlobs: [] })).rejects.toThrow(
      /screenId/i,
    );
  });

  it('refuses a sidecar screenId that carries a bidi control, by position and code point', async () => {
    // screenId keys the floor, findings, waivers, and the receipt, so it follows the shared id
    // grammar. The message names where the character is and never repeats the id.
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [{ screenId: 'clusters\u202e', url: '/clusters', entryFile: 'src/Clusters.tsx' }],
      }),
    });

    await expect(parseRouteManifest(fs, { routerFile: 'src/router.tsx', wideBlastGlobs: [] })).rejects.toThrow(
      /routes\[0\]\.screenId contains a character that is not allowed, at position 9: U\+202E/,
    );
    await expect(parseRouteManifest(fs, { routerFile: 'src/router.tsx', wideBlastGlobs: [] })).rejects.not.toThrow(
      /\u202e/,
    );
  });

  it('refuses an empty sidecar screenId', async () => {
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [{ screenId: '', url: '/clusters', entryFile: 'src/Clusters.tsx' }],
      }),
    });

    await expect(parseRouteManifest(fs, { routerFile: 'src/router.tsx', wideBlastGlobs: [] })).rejects.toThrow(
      /routes\[0\]\.screenId must be a non-empty string/,
    );
  });

  it('accepts sidecar routes when each screenId is unique', async () => {
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [
          { screenId: 'decoy', url: '/decoy', entryFile: 'src/Decoy.tsx' },
          { screenId: 'real', url: '/real', entryFile: 'src/Real.tsx' },
        ],
      }),
    });

    const manifest = await parseRouteManifest(fs, { routerFile: 'src/router.tsx', wideBlastGlobs: [] });
    expect(manifest.routes).toHaveLength(2);
    expect(manifest.routes.map((route) => route.screenId).sort()).toEqual(['decoy', 'real']);
  });

  it('loads a JSON sidecar when present', async () => {
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [{ screenId: 'clusters', url: '/clusters', entryFile: 'src/ClustersPage.tsx' }],
      }),
    });
    const manifest = await parseRouteManifest(fs, { routerFile: 'src/router.tsx', wideBlastGlobs: [] });
    expect(manifest.routes).toHaveLength(1);
    expect(manifest.routes[0]!.screenId).toBe('clusters');
    expect(manifest.routes[0]!.url).toBe('/clusters');
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

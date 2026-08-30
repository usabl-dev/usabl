import { describe, it, expect } from 'vitest';
import { parseConfiguredManifest, parseDiscoveredManifest } from '../../src/coverage/route-manifest.js';
import { computeRoutesDrift, formatDriftReport } from '../../src/drift/routes.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';

const fsOf = (files: Record<string, string>) => makeFakeDeps({ files }).fs;

describe('drift routes integration', () => {
  it('refuses when usabl.routes.json is absent', async () => {
    const fs = fsOf({
      'src/router.tsx': '<Route path="/home" />',
    });

    const configured = await parseConfiguredManifest(fs);
    expect(configured).toBeNull();
  });

  it('refuses when router file is missing', async () => {
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [{ screenId: 'home', url: '/home', entryFile: 'src/Home.tsx' }],
      }),
    });

    const discovered = await parseDiscoveredManifest(fs, 'src/router.tsx');
    expect(discovered).toBeNull();
  });

  it('detects added routes and reports drift', async () => {
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [{ screenId: 'home', url: '/home', entryFile: 'src/Home.tsx' }],
      }),
      'src/router.tsx': `
        <Route path="/home" element={<Home />} />
        <Route path="/about" element={<About />} />
      `,
    });

    const configured = await parseConfiguredManifest(fs);
    const discovered = await parseDiscoveredManifest(fs, 'src/router.tsx');

    expect(configured).not.toBeNull();
    expect(discovered).not.toBeNull();

    const drift = computeRoutesDrift(configured!, discovered!);
    expect(drift.hasDrift).toBe(true);
    expect(drift.added).toEqual(['/about']);
    expect(drift.removed).toEqual([]);

    const report = formatDriftReport(drift);
    expect(report).toContain('Route drift detected');
    expect(report).toContain('/about');
  });

  it('detects removed routes and reports drift', async () => {
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [
          { screenId: 'home', url: '/home', entryFile: 'src/Home.tsx' },
          { screenId: 'about', url: '/about', entryFile: 'src/About.tsx' },
        ],
      }),
      'src/router.tsx': `
        <Route path="/home" element={<Home />} />
      `,
    });

    const configured = await parseConfiguredManifest(fs);
    const discovered = await parseDiscoveredManifest(fs, 'src/router.tsx');

    expect(configured).not.toBeNull();
    expect(discovered).not.toBeNull();

    const drift = computeRoutesDrift(configured!, discovered!);
    expect(drift.hasDrift).toBe(true);
    expect(drift.added).toEqual([]);
    expect(drift.removed).toEqual(['/about']);

    const report = formatDriftReport(drift);
    expect(report).toContain('Route drift detected');
    expect(report).toContain('/about');
  });

  it('reports no drift when routes match', async () => {
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [
          { screenId: 'home', url: '/home', entryFile: 'src/Home.tsx' },
          { screenId: 'about', url: '/about', entryFile: 'src/About.tsx' },
        ],
      }),
      'src/router.tsx': `
        <Route path="/home" element={<Home />} />
        <Route path="/about" element={<About />} />
      `,
    });

    const configured = await parseConfiguredManifest(fs);
    const discovered = await parseDiscoveredManifest(fs, 'src/router.tsx');

    expect(configured).not.toBeNull();
    expect(discovered).not.toBeNull();

    const drift = computeRoutesDrift(configured!, discovered!);
    expect(drift.hasDrift).toBe(false);
    expect(drift.added).toEqual([]);
    expect(drift.removed).toEqual([]);

    const report = formatDriftReport(drift);
    expect(report).toContain('No drift detected');
  });
});

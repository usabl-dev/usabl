import { describe, it, expect } from 'vitest';
import { computeRoutesDrift } from '../../src/drift/routes.js';
import type { RouteManifest } from '../../src/coverage/route-manifest.js';

describe('computeRoutesDrift', () => {
  it('reports added routes when discovered route is absent from configured', () => {
    const configured: RouteManifest = {
      routes: [{ screenId: 'home', url: '/home', entryFile: 'src/Home.tsx' }],
    };
    const discovered: RouteManifest = {
      routes: [
        { screenId: 'home', url: '/home', entryFile: null },
        { screenId: 'about', url: '/about', entryFile: null },
      ],
    };

    const drift = computeRoutesDrift(configured, discovered);

    expect(drift.added).toEqual(['/about']);
    expect(drift.removed).toEqual([]);
    expect(drift.hasDrift).toBe(true);
  });

  it('reports removed routes when configured route is absent from discovered', () => {
    const configured: RouteManifest = {
      routes: [
        { screenId: 'home', url: '/home', entryFile: 'src/Home.tsx' },
        { screenId: 'about', url: '/about', entryFile: 'src/About.tsx' },
      ],
    };
    const discovered: RouteManifest = {
      routes: [{ screenId: 'home', url: '/home', entryFile: null }],
    };

    const drift = computeRoutesDrift(configured, discovered);

    expect(drift.added).toEqual([]);
    expect(drift.removed).toEqual(['/about']);
    expect(drift.hasDrift).toBe(true);
  });

  it('reports no drift when URL sets match', () => {
    const configured: RouteManifest = {
      routes: [
        { screenId: 'home', url: '/home', entryFile: 'src/Home.tsx' },
        { screenId: 'about', url: '/about', entryFile: 'src/About.tsx' },
      ],
    };
    const discovered: RouteManifest = {
      routes: [
        { screenId: 'home', url: '/home', entryFile: null },
        { screenId: 'about', url: '/about', entryFile: null },
      ],
    };

    const drift = computeRoutesDrift(configured, discovered);

    expect(drift.added).toEqual([]);
    expect(drift.removed).toEqual([]);
    expect(drift.hasDrift).toBe(false);
  });

  it('reports both added and removed routes when there is partial overlap', () => {
    const configured: RouteManifest = {
      routes: [
        { screenId: 'home', url: '/home', entryFile: 'src/Home.tsx' },
        { screenId: 'old-feature', url: '/old', entryFile: 'src/Old.tsx' },
      ],
    };
    const discovered: RouteManifest = {
      routes: [
        { screenId: 'home', url: '/home', entryFile: null },
        { screenId: 'new-feature', url: '/new', entryFile: null },
      ],
    };

    const drift = computeRoutesDrift(configured, discovered);

    expect(drift.added).toEqual(['/new']);
    expect(drift.removed).toEqual(['/old']);
    expect(drift.hasDrift).toBe(true);
  });

  it('ignores entryFile differences for the same URL', () => {
    const configured: RouteManifest = {
      routes: [{ screenId: 'home', url: '/home', entryFile: 'src/Home.tsx' }],
    };
    const discovered: RouteManifest = {
      routes: [{ screenId: 'home', url: '/home', entryFile: null }],
    };

    const drift = computeRoutesDrift(configured, discovered);

    expect(drift.hasDrift).toBe(false);
  });

  it('ignores screenId differences for the same URL', () => {
    const configured: RouteManifest = {
      routes: [{ screenId: 'homepage', url: '/home', entryFile: 'src/Home.tsx' }],
    };
    const discovered: RouteManifest = {
      routes: [{ screenId: 'home', url: '/home', entryFile: null }],
    };

    const drift = computeRoutesDrift(configured, discovered);

    expect(drift.hasDrift).toBe(false);
  });

  it('sorts added and removed URLs for stable output', () => {
    const configured: RouteManifest = {
      routes: [
        { screenId: 'z', url: '/z', entryFile: 'src/Z.tsx' },
        { screenId: 'a', url: '/a', entryFile: 'src/A.tsx' },
      ],
    };
    const discovered: RouteManifest = {
      routes: [
        { screenId: 'x', url: '/x', entryFile: null },
        { screenId: 'y', url: '/y', entryFile: null },
      ],
    };

    const drift = computeRoutesDrift(configured, discovered);

    expect(drift.added).toEqual(['/x', '/y']);
    expect(drift.removed).toEqual(['/a', '/z']);
  });
});

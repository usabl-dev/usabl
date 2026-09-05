import { describe, it, expect, vi } from 'vitest';
import { computeRoutesDrift, runRoutesDrift } from '../../src/drift/routes.js';
import { main } from '../../src/cli.js';
import { parseCliArgs } from '../../src/surfaces/cli.js';
import type { RouteManifest } from '../../src/coverage/route-manifest.js';
import { makeFakeDeps } from '../../src/deps/fakes.js';

const fsOf = (files: Record<string, string>) => makeFakeDeps({ files }).fs;

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

describe('runRoutesDrift', () => {
  it('returns exit 0 and no drift message when routes match', async () => {
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

    const outcome = await runRoutesDrift(fs, 'src/router.tsx');

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('No drift detected');
    expect(outcome.stderr).toBeUndefined();
  });

  it('returns exit 1 and reports added routes when drift is detected', async () => {
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [{ screenId: 'home', url: '/home', entryFile: 'src/Home.tsx' }],
      }),
      'src/router.tsx': `
        <Route path="/home" element={<Home />} />
        <Route path="/about" element={<About />} />
      `,
    });

    const outcome = await runRoutesDrift(fs, 'src/router.tsx');

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain('Route drift detected');
    expect(outcome.stdout).toContain('/about');
    expect(outcome.stderr).toBeUndefined();
  });

  it('returns exit 1 and reports removed routes when drift is detected', async () => {
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

    const outcome = await runRoutesDrift(fs, 'src/router.tsx');

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain('Route drift detected');
    expect(outcome.stdout).toContain('/about');
    expect(outcome.stderr).toBeUndefined();
  });

  it('returns exit 2 when usabl.routes.json is absent', async () => {
    const fs = fsOf({
      'src/router.tsx': '<Route path="/home" />',
    });

    const outcome = await runRoutesDrift(fs, 'src/router.tsx');

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain('usabl init');
    expect(outcome.stdout).toBeUndefined();
  });

  it('returns exit 2 when router file is missing', async () => {
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [{ screenId: 'home', url: '/home', entryFile: 'src/Home.tsx' }],
      }),
    });

    const outcome = await runRoutesDrift(fs, 'src/router.tsx');

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain('router file');
    expect(outcome.stderr).toContain('src/router.tsx');
    expect(outcome.stdout).toBeUndefined();
  });

  it('returns exit 2 when discovery finds no routes in a readable router file', async () => {
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [
          { screenId: 'home', url: '/home', entryFile: 'src/Home.tsx' },
          { screenId: 'about', url: '/about', entryFile: 'src/About.tsx' },
        ],
      }),
      'src/router.tsx': `
        const routes = buildRoutes();
        const router = createBrowserRouter(routes);
      `,
    });

    const outcome = await runRoutesDrift(fs, 'src/router.tsx');

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain('discovered no routes');
    expect(outcome.stderr).toContain('src/router.tsx');
    expect(outcome.stderr).toContain('Verify');
    expect(outcome.stdout).toBeUndefined();
    expect(outcome.stdout ?? '').not.toContain('Route drift detected');
  });

  it('returns exit 2 when router file is unreadable', async () => {
    const throwingFs = {
      async readFile(path: string): Promise<string | null> {
        if (path === 'usabl.routes.json') {
          return JSON.stringify({
            routes: [{ screenId: 'home', url: '/home', entryFile: 'src/Home.tsx' }],
          });
        }
        if (path === 'src/router.tsx') {
          throw new Error('EACCES: permission denied');
        }
        return null;
      },
      async glob(): Promise<string[]> {
        return [];
      },
    };

    const outcome = await runRoutesDrift(throwingFs, 'src/router.tsx');

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain('router file');
    expect(outcome.stderr).toContain('not found or unreadable');
    expect(outcome.stdout).toBeUndefined();
  });

  it('neutralizes URLs containing control sequences in the drift report', async () => {
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [
          { screenId: 'home', url: '/home', entryFile: 'src/Home.tsx' },
          { screenId: 'spoof', url: '/x\x1b[2Kspoof', entryFile: 'src/Spoof.tsx' },
        ],
      }),
      'src/router.tsx': `
        <Route path="/home" element={<Home />} />
        <Route path="/y\x1b[2Kspoof" element={<Y />} />
      `,
    });

    const outcome = await runRoutesDrift(fs, 'src/router.tsx');

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain('Route drift detected');
    expect(outcome.stdout).not.toContain('\x1b');
    expect(outcome.stdout).toContain('spoof');
  });

  it('neutralizes router file name in refusal messages', async () => {
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [{ screenId: 'home', url: '/home', entryFile: 'src/Home.tsx' }],
      }),
    });

    const outcome = await runRoutesDrift(fs, 'src/\x1b[2Krouter.tsx');

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).not.toContain('\x1b');
    expect(outcome.stderr).toContain('router');
  });

  it('parses React Router data-router API object-literal routes', async () => {
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [
          { screenId: 'home', url: '/home', entryFile: 'src/Home.tsx' },
          { screenId: 'about', url: '/about', entryFile: 'src/About.tsx' },
        ],
      }),
      'src/router.tsx': `
        const router = createBrowserRouter([
          { path: '/home', element: <Home /> },
          { path: '/about', element: <About /> },
        ]);
      `,
    });

    const outcome = await runRoutesDrift(fs, 'src/router.tsx');

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('No drift detected');
  });

  it('detects drift in data-router API routes', async () => {
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [{ screenId: 'home', url: '/home', entryFile: 'src/Home.tsx' }],
      }),
      'src/router.tsx': `
        const router = createBrowserRouter([
          { path: '/home', element: <Home /> },
          { path: '/settings', element: <Settings /> },
        ]);
      `,
    });

    const outcome = await runRoutesDrift(fs, 'src/router.tsx');

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain('/settings');
  });

  it('includes caveat about unparseable routes in removed routes section', async () => {
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [
          { screenId: 'home', url: '/home', entryFile: 'src/Home.tsx' },
          { screenId: 'removed', url: '/removed', entryFile: 'src/Removed.tsx' },
        ],
      }),
      'src/router.tsx': `
        <Route path="/home" element={<Home />} />
      `,
    });

    const outcome = await runRoutesDrift(fs, 'src/router.tsx');

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain('Removed routes');
    expect(outcome.stdout).toMatch(/computed|variable|parse/i);
  });

  it('includes a symmetric caveat about false additions in the added routes section', async () => {
    // The added side over-reports the same way the removed side does: a stray object
    // property named "path" can look like a route. The report must say so, mirroring
    // the removed-routes caveat, so an operator verifies before acting.
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [{ screenId: 'home', url: '/home', entryFile: 'src/Home.tsx' }],
      }),
      'src/router.tsx': `
        <Route path="/home" element={<Home />} />
        <Route path="/added" element={<Added />} />
      `,
    });

    const outcome = await runRoutesDrift(fs, 'src/router.tsx');

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain('Added routes');
    expect(outcome.stdout).toMatch(/false addition/i);
    expect(outcome.stdout).toMatch(/verify before acting/i);
  });

  it('handles duplicate literal paths without crashing', async () => {
    const fs = fsOf({
      'usabl.routes.json': JSON.stringify({
        routes: [
          { screenId: 'home', url: '/home', entryFile: 'src/Home.tsx' },
          { screenId: 'profile', url: '/profile', entryFile: 'src/Profile.tsx' },
        ],
      }),
      'src/router.tsx': `
        <Route path="/home" element={<Home />} />
        <Route path="/home" element={<HomeDuplicate />} />
        <Route path="/about" element={<About />} />
      `,
    });

    const outcome = await runRoutesDrift(fs, 'src/router.tsx');

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain('/about');
    expect(outcome.stdout).toContain('/profile');
  });
});

describe('drift command parsing', () => {
  it('parses drift routes and refuses drift without routes', async () => {
    const parsed = parseCliArgs(['drift', 'routes']);
    expect(parsed.command).toBe('drift');
    expect(parsed.driftSubcommand).toBe('routes');

    const stderr: string[] = [];
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(
      ((chunk: string | Uint8Array) => {
        stderr.push(String(chunk));
        return true;
      }) as typeof process.stderr.write,
    );

    try {
      const exitCode = await main(['drift']);
      expect(exitCode).toBe(2);
      expect(stderr.join('')).toContain('drift supports only the routes subcommand');
    } finally {
      writeSpy.mockRestore();
    }
  });
});

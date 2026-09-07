/**
 * Init drafts must be proven from an in-memory app fixture, not from a
 * checked-in usabl.config.json. Wrong attribution is a product failure.
 */
import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../../src/surfaces/cli.js';
import { inferInit, writeInitDrafts, type InitFs } from '../../src/init/index.js';
import { matchGlob } from '../../src/primitives/match-glob.js';
import { parseUsablConfig } from '../../src/intake/config.js';
import { computeCoverage } from '../../src/coverage/planner.js';
import { parseRouteManifest } from '../../src/coverage/route-manifest.js';

function memoryFs(files: Record<string, string>): InitFs & { store: Record<string, string> } {
  const store = { ...files };
  return {
    readFile: async (path) => store[path] ?? null,
    glob: async (patterns) => Object.keys(store).filter((f) => patterns.some((p) => matchGlob(p, f))),
    writeFile: async (path, contents) => {
      store[path] = contents;
    },
    store,
  };
}

const router = `import { Route, Routes } from 'react-router-dom'
import { Overview } from './pages/Overview'
import { Clusters } from './pages/Clusters'

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Overview />} />
      <Route path="/clusters" element={<Clusters />} />
      <Route path="*" element={<Overview />} />
    </Routes>
  )
}
`;

function fixtureFiles(over: Record<string, string> = {}): Record<string, string> {
  return {
    'vite.config.ts': `import { defineConfig } from 'vite'\nexport default defineConfig({ server: { port: 5173 } })\n`,
    'src/App.tsx': router,
    'src/pages/Overview.tsx': 'export function Overview() { return null }\n',
    'src/pages/Clusters.tsx': 'export function Clusters() { return null }\n',
    'src/main.tsx': 'import "./App"\n',
    'src/index.css': 'body { margin: 0 }\n',
    'index.html': '<div id="root"></div>\n',
    ...over,
  };
}

describe('parseCliArgs init', () => {
  it('accepts the init command and --force', () => {
    expect(parseCliArgs(['init']).command).toBe('init');
    expect(parseCliArgs(['init', '--force']).force).toBe(true);
    expect(parseCliArgs(['init']).force).toBe(false);
  });
});

describe('inferInit', () => {
  it('infers vite origin, proven React Router entry files, and skips catch-all routes', async () => {
    const fs = memoryFs(fixtureFiles());
    const draft = await inferInit(fs);

    expect(draft.config.appBaseUrl).toBe('http://127.0.0.1:5173');
    expect(draft.config.discovery.routerFile).toBe('src/App.tsx');
    expect(draft.routes.routes).toEqual([
      { screenId: 'root', url: '/', entryFile: 'src/pages/Overview.tsx' },
      { screenId: 'clusters', url: '/clusters', entryFile: 'src/pages/Clusters.tsx' },
    ]);
    expect(draft.config.surfaces.map((s) => s.id)).toEqual(['root', 'clusters']);
    expect(draft.notes.some((note) => note.toLowerCase().includes('review'))).toBe(true);
  });

  it('sets entryFile null when a route component is not a local import', async () => {
    const fs = memoryFs(
      fixtureFiles({
        'src/App.tsx': `import { Route, Routes } from 'react-router-dom'
import { Lazy } from 'some-package'

export function App() {
  return (
    <Routes>
      <Route path="/lazy" element={<Lazy />} />
    </Routes>
  )
}
`,
      }),
    );

    const draft = await inferInit(fs);
    expect(draft.routes.routes).toEqual([{ screenId: 'lazy', url: '/lazy', entryFile: null }]);
    expect(draft.notes.some((note) => note.includes('/lazy'))).toBe(true);
  });

  it('skips nested relative route paths instead of inventing a root-absolute URL', async () => {
    const fs = memoryFs(
      fixtureFiles({
        'src/App.tsx': `import { Route, Routes } from 'react-router-dom'
import { SettingsLayout } from './pages/SettingsLayout'
import { Profile } from './pages/Profile'

export function App() {
  return (
    <Routes>
      <Route path="/settings" element={<SettingsLayout />}>
        <Route path="profile" element={<Profile />} />
      </Route>
    </Routes>
  )
}
`,
        'src/pages/SettingsLayout.tsx': 'export function SettingsLayout() { return null }\n',
        'src/pages/Profile.tsx': 'export function Profile() { return null }\n',
      }),
    );

    const draft = await inferInit(fs);
    expect(draft.routes.routes.find((route) => route.url.includes('profile'))).toBeUndefined();
    expect(draft.routes.routes).not.toContainEqual(
      expect.objectContaining({ url: '/profile' }),
    );
    expect(draft.notes.some((note) => note.includes('profile') && note.toLowerCase().includes('review'))).toBe(
      true,
    );
  });

  it('discovers createBrowserRouter route urls without inventing entry files', async () => {
    const fs = memoryFs(
      fixtureFiles({
        'src/App.tsx': `export function App() { return null }\n`,
        'src/router.tsx': `import { createBrowserRouter } from 'react-router-dom'
import { Home } from './pages/Home'
import { About } from './pages/About'

const router = createBrowserRouter([
  { path: '/home', element: <Home /> },
  { path: '/about', element: <About /> },
])
`,
        'src/pages/Home.tsx': 'export function Home() { return null }\n',
        'src/pages/About.tsx': 'export function About() { return null }\n',
      }),
    );

    const draft = await inferInit(fs);
    expect(draft.config.discovery.routerFile).toBe('src/router.tsx');
    // Data-router URLs are discovered, but entry files are NOT invented from inline elements.
    // Attributing them by brace-slicing bound nested children to the wrong route (false coverage).
    expect(draft.routes.routes).toEqual([
      { screenId: 'home', url: '/home', entryFile: null },
      { screenId: 'about', url: '/about', entryFile: null },
    ]);
    expect(draft.notes.some((note) => note.includes('data-router'))).toBe(true);
    expect(draft.notes.some((note) => note.includes('no proven entry file'))).toBe(true);
  });

  it('detects a router file that only uses createBrowserRouter path literals', async () => {
    const fs = memoryFs({
      'vite.config.ts': `export default defineConfig({ server: { port: 3000 } })\n`,
      'src/router.tsx': `import { createBrowserRouter } from 'react-router-dom'
export const router = createBrowserRouter([{ path: '/only', element: <Page /> }])
`,
      'src/pages/Page.tsx': 'export function Page() { return null }\n',
    });

    const draft = await inferInit(fs);
    expect(draft.config.discovery.routerFile).toBe('src/router.tsx');
    expect(draft.routes.routes.some((route) => route.url === '/only')).toBe(true);
  });
});

describe('writeInitDrafts', () => {
  it('refuses to overwrite existing policy files without force', async () => {
    const fs = memoryFs(fixtureFiles({ 'usabl.config.json': '{}', 'usabl.routes.json': '{"routes":[]}' }));
    const draft = await inferInit(fs);
    const result = await writeInitDrafts(fs, draft, { force: false });

    expect(result.ok).toBe(false);
    expect(result.refused).toEqual(['usabl.config.json', 'usabl.routes.json']);
    expect(fs.store['usabl.config.json']).toBe('{}');
  });

  it('writes config and routes drafts when the files are absent', async () => {
    const fs = memoryFs(fixtureFiles());
    const draft = await inferInit(fs);
    const result = await writeInitDrafts(fs, draft, { force: false });

    expect(result.ok).toBe(true);
    expect(result.written).toEqual(['usabl.config.json', 'usabl.routes.json']);
    const config = JSON.parse(fs.store['usabl.config.json'] ?? '{}') as { appBaseUrl: string };
    const routes = JSON.parse(fs.store['usabl.routes.json'] ?? '{}') as { routes: unknown[] };
    expect(config.appBaseUrl).toBe('http://127.0.0.1:5173');
    expect(routes.routes).toHaveLength(2);
  });
});

describe('what init writes is what usabl accepts', () => {
  // A tool that generates configs it then refuses to read is a defect whichever rule is right.
  // These pin both directions of that agreement.
  it('round trips: the drafted config parses and its coverage plan is accepted', async () => {
    const fs = memoryFs(fixtureFiles());
    const draft = await inferInit(fs);
    await writeInitDrafts(fs, draft, { force: true });

    const config = parseUsablConfig(fs.store['usabl.config.json'] as string);
    expect(config.surfaces.length).toBeGreaterThan(0);

    const planFs = {
      readFile: async (path: string) => fs.store[path] ?? null,
      glob: async (patterns: string[]) =>
        Object.keys(fs.store).filter((f) => patterns.some((pattern) => matchGlob(pattern, f))),
    };
    await expect(computeCoverage(planFs, config, ['src/pages/Clusters.tsx'])).resolves.toBeDefined();
  });

  it('declares the override on every surface it takes from a discovered route', async () => {
    const draft = await inferInit(memoryFs(fixtureFiles()));
    expect(draft.config.surfaces.length).toBeGreaterThan(0);
    for (const surface of draft.config.surfaces) {
      expect(surface.overridesDiscoveredRoute).toBe(true);
    }
  });

  it('skips a route whose derived screen id the parser would refuse, and says so', async () => {
    // A raw space in a route path rides straight through screenIdFromUrl into the id. The route
    // is skipped where the id is derived, so it reaches neither the sidecar nor the surfaces.
    const withSpace = router.replace('path="/clusters"', 'path="/user settings"');
    const draft = await inferInit(memoryFs(fixtureFiles({ 'src/App.tsx': withSpace })));

    expect(draft.routes.routes.map((route) => route.screenId)).not.toContain('user settings');
    expect(draft.config.surfaces.map((surface) => surface.id)).not.toContain('user settings');
    expect(draft.notes.some((note) => note.includes('skipped route') && note.includes('U+0020'))).toBe(true);
  });

  it.each([
    ['a bidi control', '/acct\u202eadmin', 'U+202E'],
    ['the empty braille pattern', '/docs\u2800private', 'U+2800'],
  ])('never writes a sidecar the parser refuses: a route path with %s', async (_label, hostilePath, point) => {
    // The whole path: infer from a router that carries the hostile literal, write the drafts,
    // then read them back through the same parsers usabl runs with. The hostile route must be
    // absent from what was written, the note must say why by code point, and planning must
    // succeed on the written files.
    const hostileRouter = router.replace(
      '<Route path="/clusters" element={<Clusters />} />',
      `<Route path="/clusters" element={<Clusters />} />\n      <Route path="${hostilePath}" element={<Clusters />} />`,
    );
    const fs = memoryFs(fixtureFiles({ 'src/App.tsx': hostileRouter }));
    const draft = await inferInit(fs);
    await writeInitDrafts(fs, draft, { force: true });

    const note = draft.notes.find((entry) => entry.includes('skipped route'));
    expect(note).toBeDefined();
    expect(note).toContain(point);

    const planFs = {
      readFile: async (path: string) => fs.store[path] ?? null,
      glob: async (patterns: string[]) =>
        Object.keys(fs.store).filter((f) => patterns.some((pattern) => matchGlob(pattern, f))),
    };
    const sidecar = await parseRouteManifest(planFs, { routerFile: 'src/App.tsx', wideBlastGlobs: [] });
    expect(sidecar.source).toBe('sidecar');
    expect(sidecar.routes.map((route) => route.url)).toEqual(['/', '/clusters']);
    expect(fs.store['usabl.routes.json']).not.toContain(hostilePath);

    const config = parseUsablConfig(fs.store['usabl.config.json'] as string);
    expect(config.surfaces.map((surface) => surface.id).sort()).toEqual(['clusters', 'root']);
    const coverage = await computeCoverage(planFs, config, ['src/App.tsx']);
    expect(coverage.affected.map((screen) => screen.screenId).sort()).toEqual(['clusters', 'root']);
    expect(coverage.gaps).toEqual([]);
  });
});

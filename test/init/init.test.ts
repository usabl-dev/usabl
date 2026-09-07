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

describe('the route tag scanner reads a whole tag', () => {
  // Attribute order carries no meaning in JSX, and a route the scanner cannot see is a route the
  // sidecar never lists. The planner records no gap for a route that is not in the sidecar, so a
  // dropped route reads as fully checked while its screen is never scanned. Reading the tag to the
  // first `/>` ended it at a nested `element={<Page />}` and lost every attribute after it.
  async function routesFrom(routerSource: string): Promise<Array<{ screenId: string; url: string }>> {
    const fs = memoryFs(fixtureFiles({ 'src/App.tsx': routerSource }));
    const draft = await inferInit(fs);
    return draft.routes.routes.map((route) => ({ screenId: route.screenId, url: route.url }));
  }

  function app(body: string): string {
    return `import { Route, Routes } from 'react-router-dom'
import { Overview } from './pages/Overview'

export function App() {
  return (
    <Routes>
${body}
    </Routes>
  )
}
`;
  }

  it('reads a route whose element attribute comes before its path, on one line', async () => {
    expect(await routesFrom(app('      <Route element={<Overview />} path="/clusters" />'))).toEqual([
      { screenId: 'clusters', url: '/clusters' },
    ]);
  });

  it('reads a route whose element attribute comes before its path, across several lines', async () => {
    const body = `      <Route
        element={<Overview />}
        path="/clusters"
      />`;
    expect(await routesFrom(app(body))).toEqual([{ screenId: 'clusters', url: '/clusters' }]);
  });

  it('reads four routes from a file that writes every element before its path', async () => {
    const body = `      <Route
        element={<Overview />}
        path="/"
      />
      <Route element={<Overview />} path="/clusters" />
      <Route
        element={<Overview />}
        path="/settings"
      />
      <Route element={<Overview />} path="/about" />`;
    expect(await routesFrom(app(body))).toEqual([
      { screenId: 'root', url: '/' },
      { screenId: 'clusters', url: '/clusters' },
      { screenId: 'settings', url: '/settings' },
      { screenId: 'about', url: '/about' },
    ]);
  });

  it('does not read a path attribute that belongs to a nested element as the route path', async () => {
    // The nested element is inside braces, so its attributes are masked out before the route's own
    // path is matched. Taking the nested one would point the scan at a URL the route never serves.
    const body = `      <Route element={<Overview path="/nested" />} path="/clusters" />`;
    expect(await routesFrom(app(body))).toEqual([{ screenId: 'clusters', url: '/clusters' }]);
  });

  it('passes over an index route, which has no path and is not a screen with a URL', async () => {
    const body = `      <Route index element={<Overview />} />
      <Route element={<Overview />} path="/clusters" />`;
    expect(await routesFrom(app(body))).toEqual([{ screenId: 'clusters', url: '/clusters' }]);
  });

  it('ends the tag at its own closing bracket when an attribute string holds one', async () => {
    // A `>` or a `/>` inside a string is text, not the end of the tag. Ending there would drop
    // every attribute after it, which is the same silent omission by a different route.
    const body = `      <Route path="/a>b" element={<Overview />} />
      <Route element={<Overview />} title="x/>y" path="/clusters" />`;
    expect(await routesFrom(app(body))).toEqual([
      { screenId: 'a>b', url: '/a>b' },
      { screenId: 'clusters', url: '/clusters' },
    ]);
  });

  it('ignores a commented-out route and keeps the real one', async () => {
    const body = `      {/* <Route element={<Overview />} path="/decoy" /> */}
      <Route element={<Overview />} path="/clusters" />
      // <Route element={<Overview />} path="/later" />`;
    expect(await routesFrom(app(body))).toEqual([{ screenId: 'clusters', url: '/clusters' }]);
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

  // The fixture router with one more route after /clusters, on line 10, sharing the Clusters
  // entry file. Two urls on one entry file is the case a skipped route would have hidden.
  function routerWithExtraRoute(path: string): string {
    return router.replace(
      '<Route path="/clusters" element={<Clusters />} />',
      `<Route path="/clusters" element={<Clusters />} />\n      <Route path="${path}" element={<Clusters />} />`,
    );
  }

  async function refusalOf(fs: InitFs): Promise<string> {
    try {
      await inferInit(fs);
    } catch (error: unknown) {
      return error instanceof Error ? error.message : String(error);
    }
    return '';
  }

  it('refuses the whole draft when a route path holds a raw space, and names the file and line', async () => {
    // A raw space in a route path rides straight through screenIdFromUrl into the id. The route
    // cannot be written, and it cannot be left out either, so nothing is written at all. The
    // refusal locates the route by file and line and never prints the path.
    const withSpace = router.replace('path="/clusters"', 'path="/user settings"');
    const fs = memoryFs(fixtureFiles({ 'src/App.tsx': withSpace }));

    const message = await refusalOf(fs);
    expect(message).toContain('usabl init refused to write usabl.config.json and usabl.routes.json');
    expect(message).toContain('src/App.tsx line 9: the screen id derived from the route path there');
    expect(message).toContain('at position 5: U+0020');
    expect(message).not.toContain('user settings');
    expect(fs.store['usabl.config.json']).toBeUndefined();
    expect(fs.store['usabl.routes.json']).toBeUndefined();
  });

  it.each([
    ['a bidi control', '/acct\u202eadmin', 'at position 5: U+202E', '\u202e'],
    ['the empty braille pattern', '/docs\u2800private', 'at position 5: U+2800', '\u2800'],
  ])(
    'refuses the whole draft rather than write sidecars without the route: a route path with %s',
    async (_label, hostilePath, expectedPoint, rawCharacter) => {
      // A written sidecar takes precedence over router fallback, and the planner records no gap
      // for a route that is not in it, so sidecars written without this route would let a change
      // to the shared Clusters entry file, or a wide-blast file, read as fully checked while the
      // route is never scanned. The only honest draft is none. The refusal names the file and
      // line, the position and code point, and the fix, and never the path or the id.
      const fs = memoryFs(fixtureFiles({ 'src/App.tsx': routerWithExtraRoute(hostilePath) }));

      const message = await refusalOf(fs);
      expect(message).toContain('usabl init refused to write usabl.config.json and usabl.routes.json');
      expect(message).toContain('src/App.tsx line 10: the screen id derived from the route path there');
      expect(message).toContain(expectedPoint);
      expect(message).toContain('change the route path in the router file');
      expect(message).not.toContain(rawCharacter);
      expect(message).not.toContain(hostilePath);
      expect(fs.store['usabl.config.json']).toBeUndefined();
      expect(fs.store['usabl.routes.json']).toBeUndefined();

      // Once the path is fixed the same router drafts, writes, reparses, and plans with every
      // route, and a change to the shared entry file queues both routes that use it.
      const fixedFs = memoryFs(fixtureFiles({ 'src/App.tsx': routerWithExtraRoute('/acct-admin') }));
      const draft = await inferInit(fixedFs);
      const result = await writeInitDrafts(fixedFs, draft, { force: false });
      expect(result.ok).toBe(true);

      const planFs = {
        readFile: async (path: string) => fixedFs.store[path] ?? null,
        glob: async (patterns: string[]) =>
          Object.keys(fixedFs.store).filter((f) => patterns.some((pattern) => matchGlob(pattern, f))),
      };
      const sidecar = await parseRouteManifest(planFs, { routerFile: 'src/App.tsx', wideBlastGlobs: [] });
      expect(sidecar.source).toBe('sidecar');
      expect(sidecar.routes.map((route) => route.url)).toEqual(['/', '/clusters', '/acct-admin']);

      const config = parseUsablConfig(fixedFs.store['usabl.config.json'] as string);
      expect(config.surfaces.map((surface) => surface.id).sort()).toEqual(['acct-admin', 'clusters', 'root']);

      const sharedEntryFile = await computeCoverage(planFs, config, ['src/pages/Clusters.tsx']);
      expect(sharedEntryFile.affected.map((screen) => screen.screenId).sort()).toEqual(['acct-admin', 'clusters']);
      expect(sharedEntryFile.gaps).toEqual([]);

      const wideBlast = await computeCoverage(planFs, config, ['src/App.tsx']);
      expect(wideBlast.affected.map((screen) => screen.screenId).sort()).toEqual(['acct-admin', 'clusters', 'root']);
      expect(wideBlast.gaps).toEqual([]);
    },
  );

  // A comment on line 2 that names the same route path, with the real declaration on line 7.
  const jsxRouterWithComment = `import { Route, Routes } from 'react-router-dom'
// Example route: /only bad route
import { Overview } from './pages/Overview'

export function App() {
  return (
    <Routes><Route path="/only bad route" element={<Overview />} /></Routes>
  )
}
`;

  const dataRouterWithComment = `import { createBrowserRouter } from 'react-router-dom'
// Example route: /only bad route
import { Overview } from './pages/Overview'

export const router =
  createBrowserRouter([
    { path: '/only bad route', element: <Overview /> },
  ])
`;

  it.each([
    ['a jsx route tag', jsxRouterWithComment],
    ['a data router entry', dataRouterWithComment],
  ])('names the line the route is declared on, not a comment that mentions the same path: %s', async (
    _label,
    routerSource,
  ) => {
    // The line comes from the offset the parser recorded for the path literal. A search of the
    // file for the path text would have found the comment on line 2 first and sent the operator
    // to a line that declares nothing.
    const fs = memoryFs(fixtureFiles({ 'src/App.tsx': routerSource }));

    const message = await refusalOf(fs);
    expect(message).toContain('src/App.tsx line 7: the screen id derived from the route path there');
    expect(message).not.toContain('src/App.tsx line 2');
    expect(message).toContain('at position 5: U+0020');
    expect(message).not.toContain('only bad route');
    expect(fs.store['usabl.config.json']).toBeUndefined();
    expect(fs.store['usabl.routes.json']).toBeUndefined();
  });

  it('names every unusable route in one refusal, so one run shows the whole fix', async () => {
    const twoBad = router.replace(
      '<Route path="/clusters" element={<Clusters />} />',
      `<Route path="/a\u2800a" element={<Clusters />} />\n      <Route path="/b\u200bb" element={<Clusters />} />`,
    );
    const message = await refusalOf(memoryFs(fixtureFiles({ 'src/App.tsx': twoBad })));
    expect(message).toContain('2 routes have ids');
    expect(message).toContain('src/App.tsx line 9:');
    expect(message).toContain('at position 2: U+2800');
    expect(message).toContain('src/App.tsx line 10:');
    expect(message).toContain('at position 2: U+200B');
  });
});

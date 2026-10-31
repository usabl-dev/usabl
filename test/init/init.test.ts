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

  it('leaves the entry file empty and names every candidate when several files match one import', async () => {
    const fs = memoryFs(
      fixtureFiles({
        'src/pages/Clusters.ts': 'export function Clusters() { return null }\n',
        'src/pages/Clusters.jsx': 'export function Clusters() { return null }\n',
      }),
    );

    const draft = await inferInit(fs);
    expect(draft.routes.routes).toEqual([
      { screenId: 'root', url: '/', entryFile: 'src/pages/Overview.tsx' },
      { screenId: 'clusters', url: '/clusters', entryFile: null },
    ]);
    const note = draft.notes.find((entry) => entry.includes('/clusters'));
    expect(note).toBeDefined();
    expect(note).toMatch(/^Review: /);
    for (const candidate of ['src/pages/Clusters.jsx', 'src/pages/Clusters.ts', 'src/pages/Clusters.tsx']) {
      expect(note).toContain(candidate);
    }
    // Sorted, so the note reads the same on every run.
    expect(note!.indexOf('src/pages/Clusters.jsx')).toBeLessThan(note!.indexOf('src/pages/Clusters.ts,'));
    expect(draft.notes.some((entry) => entry.includes('Attributed 1 of 2 routes'))).toBe(true);
  });

  it('still attributes an entry file when exactly one candidate exists', async () => {
    const files = fixtureFiles({ 'src/pages/Clusters.js': 'export function Clusters() { return null }\n' });
    delete files['src/pages/Clusters.tsx'];
    const fs = memoryFs(files);

    const draft = await inferInit(fs);
    expect(draft.routes.routes).toContainEqual({
      screenId: 'clusters',
      url: '/clusters',
      entryFile: 'src/pages/Clusters.js',
    });
  });

  it('joins a nested relative route path to its parent instead of inventing a root-absolute URL', async () => {
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
    // The router nests profile under /settings, so React Router serves it at /settings/profile.
    // The layout route has a child, and its component also renders on the child's URL, so it is
    // not attributed: a change to the layout must not read as covered by one screen.
    expect(draft.routes.routes).toEqual([
      { screenId: 'settings', url: '/settings', entryFile: null },
      { screenId: 'settings-profile', url: '/settings/profile', entryFile: 'src/pages/Profile.tsx' },
    ]);
    expect(draft.routes.routes).not.toContainEqual(
      expect.objectContaining({ url: '/profile' }),
    );
    expect(draft.notes.some((note) => note.includes('/settings') && note.includes('no proven entry file'))).toBe(
      true,
    );
  });

  it('discovers createBrowserRouter route urls and attributes each leaf route to its element', async () => {
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
    // The router is parsed, so each route object's element is read from that object alone. Brace
    // slicing once bound nested children to the wrong route; a syntax tree cannot.
    expect(draft.routes.routes).toEqual([
      { screenId: 'home', url: '/home', entryFile: 'src/pages/Home.tsx' },
      { screenId: 'about', url: '/about', entryFile: 'src/pages/About.tsx' },
    ]);
    expect(draft.notes.some((note) => note.includes('data-router'))).toBe(true);
    expect(draft.notes.some((note) => note.includes('no proven entry file'))).toBe(false);
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

describe('inferInit reads routes from the parsed router', () => {
  const routerFiles = (app: string): Record<string, string> =>
    fixtureFiles({
      'src/App.tsx': app,
      'src/pages/Home.tsx': 'export function Home() { return null }\n',
      'src/pages/Account.tsx': 'export function Account() { return null }\n',
      'src/pages/Decoy.tsx': 'export function Decoy() { return null }\n',
    });

  it('does not attribute a stray <Route> outside the router to the real route with the same path', async () => {
    // The stray tag's component used to win the merge over the data-router entry, so init wrote
    // the decoy's file into the sidecar as the entry file for /account.
    const app = `import { createBrowserRouter } from 'react-router-dom'
import { Route } from 'react-router-dom'
import { Decoy } from './pages/Decoy'

export const example = <Route path="/account" element={<Decoy />} />

export const router = createBrowserRouter([
  { path: '/account', element: <div /> },
])
`;
    const draft = await inferInit(memoryFs(routerFiles(app)));
    expect(draft.routes.routes).toEqual([{ screenId: 'account', url: '/account', entryFile: null }]);
  });

  it('names a route outside the router in a Review note, with its line', async () => {
    const app = `import { Route, Routes } from 'react-router-dom'
import { Home } from './pages/Home'
import { Account } from './pages/Account'

export const Modal = () => <Route path="/account" element={<Account />} />

export function App() {
  return (
    <Routes>
      <Route path="/home" element={<Home />} />
    </Routes>
  )
}
`;
    const draft = await inferInit(memoryFs(routerFiles(app)));
    expect(draft.routes.routes).toEqual([{ screenId: 'home', url: '/home', entryFile: 'src/pages/Home.tsx' }]);
    expect(draft.notes.some((note) => note.startsWith('Review: src/App.tsx line 5:'))).toBe(true);
  });

  it('writes no route and names the file when it has routes but no router', async () => {
    // With no router in the file, usabl cannot tell which routes are real, so it reads none of
    // them and says so once for the file, instead of guessing.
    const app = `import { Route } from 'react-router-dom'
import { Account } from './pages/Account'

export const AccountRoute = () => <Route path="/account" element={<Account />} />
`;
    const draft = await inferInit(memoryFs(routerFiles(app)));
    expect(draft.routes.routes).toEqual([]);
    expect(draft.notes.some((note) => note.startsWith('Review: src/App.tsx:') && note.includes('no router'))).toBe(true);
  });

  it('reads a route whose element comes before its path, and one with ">" in an attribute string', async () => {
    const app = `import { Route, Routes } from 'react-router-dom'
import { Home } from './pages/Home'
import { Account } from './pages/Account'

export function App() {
  return (
    <Routes>
      <Route element={<Home />} path="/home" />
      <Route title="a > b" path="/account" element={<Account />} />
    </Routes>
  )
}
`;
    const draft = await inferInit(memoryFs(routerFiles(app)));
    expect(draft.routes.routes).toEqual([
      { screenId: 'home', url: '/home', entryFile: 'src/pages/Home.tsx' },
      { screenId: 'account', url: '/account', entryFile: 'src/pages/Account.tsx' },
    ]);
  });

  it('ignores a commented-out route and a commented-out import', async () => {
    const app = `import { Route, Routes } from 'react-router-dom'
// import { Home } from './pages/Decoy'
import { Home } from './pages/Home'

export function App() {
  return (
    <Routes>
      {/* <Route path="/old" element={<Home />} /> */}
      <Route path="/home" element={<Home />} />
    </Routes>
  )
}
`;
    const draft = await inferInit(memoryFs(routerFiles(app)));
    expect(draft.routes.routes).toEqual([{ screenId: 'home', url: '/home', entryFile: 'src/pages/Home.tsx' }]);
  });

  it('resolves path={ROUTES.home} from a const in the router module', async () => {
    const app = `import { Route, Routes } from 'react-router-dom'
import { Home } from './pages/Home'

const ROUTES = { home: '/home' } as const

export function App() {
  return (
    <Routes>
      <Route path={ROUTES.home} element={<Home />} />
    </Routes>
  )
}
`;
    const draft = await inferInit(memoryFs(routerFiles(app)));
    expect(draft.routes.routes).toEqual([{ screenId: 'home', url: '/home', entryFile: 'src/pages/Home.tsx' }]);
  });

  it('names the file and line of a route path it cannot resolve', async () => {
    const app = `import { Route, Routes } from 'react-router-dom'
import { ROUTES } from './paths'
import { Home } from './pages/Home'

export function App() {
  return (
    <Routes>
      <Route path={ROUTES.home} element={<Home />} />
      <Route path="/account" element={<Home />} />
    </Routes>
  )
}
`;
    const draft = await inferInit(memoryFs(routerFiles(app)));
    expect(draft.routes.routes.map((route) => route.url)).toEqual(['/account']);
    expect(draft.notes.some((note) => note.includes('src/App.tsx line 8') && note.includes('usabl.routes.json'))).toBe(
      true,
    );
  });

  it('names the router file when it does not parse', async () => {
    const app = `export function App() { return <Routes><Route path="/a" ></Routes> }\n`;
    const draft = await inferInit(memoryFs(routerFiles(app)));
    expect(draft.routes.routes).toEqual([]);
    expect(draft.notes.some((note) => note.includes('src/App.tsx') && note.includes('does not parse'))).toBe(true);
  });
});

describe('inferInit readiness signal recommendation for a login-gated application', () => {
  const loginRouter = `import { Route, Routes } from 'react-router-dom'
import { Overview } from './pages/Overview'
import { Clusters } from './pages/Clusters'
import { SignIn } from './pages/SignIn'

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Overview />} />
      <Route path="/clusters" element={<Clusters />} />
      <Route path="/sign-in" element={<SignIn />} />
    </Routes>
  )
}
`;

  const recommendationsIn = (notes: string[]): string[] => notes.filter((note) => note.includes('reachedWhen'));

  it('recommends a readiness signal for every screen when the run is configured with a session', async () => {
    const draft = await inferInit(memoryFs(fixtureFiles()), { sessionConfigured: true });
    const notes = recommendationsIn(draft.notes);
    for (const id of ['root', 'clusters']) {
      expect(notes.some((note) => note.includes(`"${id}"`))).toBe(true);
    }
    expect(notes.some((note) => note.includes('USABL_STORAGE_STATE'))).toBe(true);
  });

  it('recommends a readiness signal for every screen when the router has a sign-in route', async () => {
    const fs = memoryFs(
      fixtureFiles({
        'src/App.tsx': loginRouter,
        'src/pages/SignIn.tsx': 'export function SignIn() { return null }\n',
      }),
    );
    const draft = await inferInit(fs);
    const notes = recommendationsIn(draft.notes);
    for (const id of ['root', 'clusters', 'sign-in']) {
      expect(notes.some((note) => note.includes(`"${id}"`))).toBe(true);
    }
    expect(notes.some((note) => note.includes('/sign-in'))).toBe(true);
  });

  it('recommends a readiness signal for every screen when usabl session saved a session', async () => {
    const draft = await inferInit(memoryFs(fixtureFiles({ '.usabl/session/storage-state.json': '{}' })));
    const notes = recommendationsIn(draft.notes);
    for (const id of ['root', 'clusters']) {
      expect(notes.some((note) => note.includes(`"${id}"`))).toBe(true);
    }
    expect(notes.some((note) => note.includes('.usabl/session/storage-state.json'))).toBe(true);
  });

  it('says nothing about a readiness signal when nothing suggests a login', async () => {
    const draft = await inferInit(memoryFs(fixtureFiles()), { sessionConfigured: false });
    expect(recommendationsIn(draft.notes)).toEqual([]);
  });

  it('writes no readiness signal itself, because only the operator knows what the screen shows', async () => {
    const draft = await inferInit(memoryFs(fixtureFiles()), { sessionConfigured: true });
    expect(draft.config.surfaces.every((surface) => surface.reachedWhen === undefined)).toBe(true);
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
  ])('names the line of the matched route, not prose that mentions the same path: %s', async (
    _label,
    routerSource,
  ) => {
    // The line comes from the offset the parser recorded for the path it read. A search of the
    // file for the path text would have found the prose comment on line 2 first and sent the
    // operator to a line that declares nothing.
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

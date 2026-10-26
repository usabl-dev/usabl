import { describe, it, expect } from 'vitest';
import {
  deriveScreenId,
  isRouterSource,
  mergeParsedRoutes,
  parseDataRouterRoutes,
  parseRouterFallback,
  screenIdFromUrl,
} from '../../src/coverage/router-parse.js';

describe('router-parse', () => {
  it('derives screenId from url', () => {
    expect(screenIdFromUrl('/')).toBe('root');
    expect(screenIdFromUrl('/clusters')).toBe('clusters');
    expect(screenIdFromUrl('/a/b')).toBe('a-b');
  });

  it('sets aside a route whose derived id fails the grammar, and says where the character is', () => {
    // A route literal in application source is not a policy file, so this is the first and only
    // place the derived id is checked. The route is kept apart, not dropped, so the planner can
    // report it. The reason names the position and code point and never repeats the id.
    const manifest = parseRouterFallback(`
      export const App = () => (
        <Routes>
          <Route path="/clusters" element={<Clusters />} />
          <Route path="/acct\u202eadmin" element={<Admin />} />
        </Routes>
      );
      export const router = createBrowserRouter([{ path: '/docs\u2800private', element: <Docs /> }]);
    `);
    expect(manifest.routes.map((route) => route.screenId)).toEqual(['clusters']);
    expect(manifest.unusable.map((route) => route.url)).toEqual(['/acct\u202eadmin', '/docs\u2800private']);
    expect(manifest.unusable[0]?.reason).toContain('at position 5: U+202E');
    expect(manifest.unusable[0]?.reason).not.toContain('\u202e');
    expect(manifest.unusable[1]?.reason).toContain('at position 5: U+2800');
    expect(manifest.unusable[1]?.reason).not.toContain('\u2800');
  });

  it('derives and validates a screen id in one step', () => {
    expect(deriveScreenId('/users/:id')).toEqual({ ok: true, screenId: 'users-:id' });
    expect(deriveScreenId('/')).toEqual({ ok: true, screenId: 'root' });
    const refused = deriveScreenId('/user settings');
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.problem).toContain('at position 5: U+0020');
    }
  });

  it('parses jsx and object literal paths in router fallback', () => {
    const manifest = parseRouterFallback(`
      export const App = () => (
        <Routes>
          <Route path="/home" element={<Home />} />
        </Routes>
      );
      export const router = createBrowserRouter([{ path: '/about', element: <About /> }]);
    `);
    expect(manifest.routes.map((route) => route.url).sort()).toEqual(['/about', '/home']);
    expect(manifest.routes.every((route) => route.entryFile === null)).toBe(true);
  });

  it('detects router source markers', () => {
    expect(isRouterSource('<Route path="/" />')).toBe(true);
    expect(isRouterSource("createBrowserRouter([{ path: '/x' }])")).toBe(true);
    expect(isRouterSource('export function App() { return null }')).toBe(false);
  });

  it('discovers data-router route urls without attributing a component', () => {
    // Component attribution is intentionally not done: slicing to the next brace binds a nested
    // child element to its parent route. Routes are discovered as URLs only (component null).
    const source = `
      createBrowserRouter([
        { path: '/home', element: <Home /> },
        { path: '/about', element: <About /> },
      ])
    `;
    const routes = parseDataRouterRoutes(source);
    expect(routes).toEqual([
      { path: '/home', component: null, offset: source.indexOf("path: '/home'") },
      { path: '/about', component: null, offset: source.indexOf("path: '/about'") },
    ]);
  });

  it('records where each route was matched, not where its path text first appears', () => {
    // Prose that names a route path is the case an offset guards against: a caller that searched
    // the file for the path text would report that line instead. The router file is parsed, so a
    // comment is never read as a route either.
    const source = `
      // Example route: /home
      createBrowserRouter([{ path: '/home', element: <Home /> }])
    `;
    const routes = parseDataRouterRoutes(source);
    expect(routes[0]?.offset).toBe(source.indexOf("path: '/home'"));
    expect(source.slice(0, routes[0]?.offset).split('\n').length).toBe(3);
  });

  it('does not attribute a nested child element to its parent route', () => {
    // False-coverage guard. The old brace-slicer bound /parent to Child. Now no component is
    // attributed, so init cannot invent a wrong entry file for the parent route.
    const source = `
      createBrowserRouter([
        { path: '/parent', children: [{ path: '/child', element: <Child /> }], element: <Parent /> },
      ])
    `;
    const routes = parseDataRouterRoutes(source);
    expect(routes).toEqual([
      { path: '/parent', component: null, offset: source.indexOf("path: '/parent'") },
      { path: '/child', component: null, offset: source.indexOf("path: '/child'") },
    ]);
  });

  it('discovers the root path', () => {
    const source = `createBrowserRouter([{ path: '/', element: <Root /> }])`;
    expect(parseDataRouterRoutes(source)).toEqual([
      { path: '/', component: null, offset: source.indexOf("path: '/'") },
    ]);
  });

  it('ignores path-like objects outside the create*Router call', () => {
    // A decoy object elsewhere in the module must not be read as a route.
    const source = `
      const telemetry = { path: '/not-a-route', element: <Decoy /> };
      createBrowserRouter([{ path: '/home', element: <Home /> }]);
    `;
    expect(parseDataRouterRoutes(source)).toEqual([
      { path: '/home', component: null, offset: source.indexOf("path: '/home'") },
    ]);
  });

  it('merges jsx and data routes without duplicating paths', () => {
    const merged = mergeParsedRoutes(
      [{ path: '/', component: 'Overview', offset: 10 }],
      [
        { path: '/settings', component: 'Settings', offset: 40 },
        { path: '/', component: null, offset: 70 },
      ],
    );
    expect(merged).toEqual([
      { path: '/', component: 'Overview', offset: 10 },
      { path: '/settings', component: 'Settings', offset: 40 },
    ]);
  });
});

// Router discovery reads the router from a parsed file. Each case below was read wrongly when
// routes were matched as raw text: a decoy outside the router was read as a route, a real route
// was missed, or a delimiter inside a string or comment ended a tag or a call early.
describe('router-parse: reads only the real router', () => {
  const urls = (raw: string): string[] => parseRouterFallback(raw).routes.map((route) => route.url);
  const unreadableLines = (raw: string): Array<number | null> =>
    (parseRouterFallback(raw).unreadable ?? []).map((gap) => gap.line);

  it('ignores a path object outside the create*Router call', () => {
    const raw = [
      "const api = { path: '/decoy', method: 'GET' };",
      "export const router = createBrowserRouter([{ path: '/home', element: <Home /> }]);",
    ].join('\n');
    expect(urls(raw)).toEqual(['/home']);
  });

  it('keeps a <Route> outside the router out of the scan, and names it with its line', () => {
    // The stray route is not scanned, because no router that usabl read owns it. It is not
    // dropped in silence either: it may be a real route mounted in a way usabl does not read.
    const raw = [
      'const Decoy = () => <Route path="/account" element={<Decoy />} />;',
      'export const App = () => (',
      '  <Routes>',
      '    <Route path="/home" element={<Home />} />',
      '  </Routes>',
      ');',
    ].join('\n');
    expect(urls(raw)).toEqual(['/home']);
    expect(unreadableLines(raw)).toEqual([1]);
  });

  it('does not read a commented-out route', () => {
    const raw = [
      'export const App = () => (',
      '  <Routes>',
      '    {/* <Route path="/old-jsx" element={<Old />} /> */}',
      '    <Route path="/home" element={<Home />} />',
      '  </Routes>',
      ');',
      'export const router = createBrowserRouter([',
      "  // { path: '/old-data', element: <Old /> },",
      "  /* { path: '/old-block' }, */",
      "  { path: '/about', element: <About /> },",
      ']);',
    ].join('\n');
    expect(urls(raw).sort()).toEqual(['/about', '/home']);
  });

  it('reads a route whose element attribute comes before its path', () => {
    const raw = 'export const App = () => <Routes><Route element={<Home />} path="/home" /></Routes>;';
    expect(urls(raw)).toEqual(['/home']);
  });

  it('reads a route whose JSX attribute string holds a ">"', () => {
    const raw = [
      'export const App = () => (',
      '  <Routes>',
      '    <Route title=">" path="/hidden" element={<Live />} />',
      '    <Route path="/visible" title=">" element={<Live />} />',
      '  </Routes>',
      ');',
    ].join('\n');
    expect(urls(raw)).toEqual(['/hidden', '/visible']);
  });

  it('reads every route after a ")" inside a string or a comment in the router call', () => {
    const raw = [
      'export const router = createBrowserRouter([',
      "  { path: '/first', handle: { label: 'a ) b' } },",
      '  // a stray ) in a comment',
      "  { path: '/second' },",
      ']);',
    ].join('\n');
    expect(urls(raw)).toEqual(['/first', '/second']);
  });

  it('ignores create*Router( written in a string, a template, or a comment', () => {
    const raw = [
      "const docs = \"createBrowserRouter([{ path: '/in-string' }])\";",
      "const tip = `${'createHashRouter('} [{ path: '/in-template' }]`;",
      "// createMemoryRouter([{ path: '/in-comment' }])",
      "export const router = createBrowserRouter([{ path: '/real' }]);",
    ].join('\n');
    expect(urls(raw)).toEqual(['/real']);
  });

  it('reads every route after a regular expression that looks like a comment', () => {
    // A comment-blanking fix read the valid regular expression /[//]/ as the start of a line
    // comment, blanked the rest of the line, and a run with that router came back verified with
    // a route missing. The parser reads it as a regular expression.
    const raw = [
      'const slashes = /[//]/; export const router = createBrowserRouter([',
      "  { path: '/a' },",
      "  { path: '/b' },",
      ']);',
    ].join('\n');
    expect(urls(raw)).toEqual(['/a', '/b']);
  });

  it('resolves a path held in a const of the same module, including a member of a const object', () => {
    const raw = [
      "const HOME = '/home';",
      'const TEMPLATE = `/template`;',
      "export const ROUTES = { about: '/about', nested: { deep: HOME_ALIAS } } as const;",
      'const HOME_ALIAS = HOME;',
      'export const App = () => (',
      '  <Routes>',
      '    <Route path={HOME} element={<Home />} />',
      '    <Route path={ROUTES.about} element={<About />} />',
      "    <Route path={ROUTES['nested'].deep} element={<Deep />} />",
      '    <Route path={TEMPLATE} element={<T />} />',
      '    <Route path={`/inline`} element={<I />} />',
      '  </Routes>',
      ');',
      "export const router = createBrowserRouter([{ path: ROUTES.about }, { path: HOME }]);",
    ].join('\n');
    expect(urls(raw).sort()).toEqual(['/about', '/home', '/inline', '/template']);
    expect(unreadableLines(raw)).toEqual([]);
  });

  it('reports a path it cannot resolve as a gap with its line, not as a missing route', () => {
    const raw = [
      "import { ROUTES } from './paths';",
      'let mutable = "/mutable";',
      'export const App = () => (',
      '  <Routes>',
      '    <Route path={ROUTES.home} element={<Home />} />',
      '    <Route path={`/users/${id}`} element={<User />} />',
      '    <Route path={mutable} element={<M />} />',
      '    <Route path="/known" element={<Known />} />',
      '  </Routes>',
      ');',
    ].join('\n');
    expect(urls(raw)).toEqual(['/known']);
    expect(unreadableLines(raw)).toEqual([5, 6, 7]);
    for (const gap of parseRouterFallback(raw).unreadable ?? []) {
      expect(gap.reason).not.toBe('');
    }
  });

  it('reports routes built by code as a gap, not as an empty router', () => {
    const raw = [
      "const pages = [{ path: '/a' }, { path: '/b' }];",
      'export const App = () => (',
      '  <Routes>',
      '    {pages.map((page) => <Route key={page.path} path={page.path} element={<Page />} />)}',
      '  </Routes>',
      ');',
      'export const router = createBrowserRouter(buildRoutes());',
    ].join('\n');
    expect(urls(raw)).toEqual([]);
    expect(unreadableLines(raw)).toEqual([4, 7]);
  });

  it('joins a nested relative path to its parent path', () => {
    const raw = [
      'export const router = createBrowserRouter([',
      "  { path: '/app', children: [{ index: true }, { path: 'settings' }, { path: 'users/:id' }] },",
      "  { path: 'top' },",
      ']);',
    ].join('\n');
    expect(urls(raw)).toEqual(['/app', '/app/settings', '/app/users/:id', '/top']);
  });

  it('reports a file that does not parse as a gap, never as a router with no routes', () => {
    const result = parseRouterFallback('export const App = () => <Routes><Route path="/a" ></Routes>;');
    expect(result.routes).toEqual([]);
    expect(result.unreadable).toHaveLength(1);
    expect(result.unreadable?.[0]?.line).toBe(1);
    expect(result.unreadable?.[0]?.reason).toMatch(/does not parse/);
  });
});

describe('router-parse: the data router reader used by init', () => {
  const paths = (raw: string): string[] => parseDataRouterRoutes(raw).map((route) => route.path);

  it('reads every entry after a ")" inside a string or a comment in the router call', () => {
    const raw = [
      'export const router = createBrowserRouter([',
      "  { path: '/first', handle: { label: 'a ) b' } },",
      '  // a stray ) in a comment',
      "  { path: '/second' },",
      ']);',
    ].join('\n');
    expect(paths(raw)).toEqual(['/first', '/second']);
  });

  it('reads the real call when create*Router( appears earlier in a string, a template, or a comment', () => {
    const raw = [
      "const docs = \"createBrowserRouter([{ path: '/in-string' }])\";",
      "const tip = `${'createHashRouter('} [{ path: '/in-template' }]`;",
      "// createMemoryRouter([{ path: '/in-comment' }])",
      "export const router = createBrowserRouter([{ path: '/real' }]);",
    ].join('\n');
    expect(paths(raw)).toEqual(['/real']);
  });

  it('does not read a commented-out entry', () => {
    const raw = [
      'export const router = createBrowserRouter([',
      "  // { path: '/old' },",
      "  { path: '/new' },",
      ']);',
    ].join('\n');
    expect(paths(raw)).toEqual(['/new']);
  });
});

describe('router-parse: routes that match many URLs', () => {
  it('skips a bare catch-all and reports a splat that mounts other routes', () => {
    // A bare "*" is the not-found page. A path such as "/app/*" usually mounts routes declared in
    // another file, so the screens under it are unknown here. Scanning the literal URL "/app/*"
    // would check a page nobody visits and read as if those screens were covered.
    const raw = [
      'export const App = () => (',
      '  <Routes>',
      '    <Route path="/home" element={<Home />} />',
      '    <Route path="/app/*" element={<AppRoutes />} />',
      '    <Route path="*" element={<NotFound />} />',
      '  </Routes>',
      ');',
    ].join('\n');
    const result = parseRouterFallback(raw);
    expect(result.routes.map((route) => route.url)).toEqual(['/home']);
    expect(result.unreadable.map((gap) => gap.line)).toEqual([4]);
  });
});

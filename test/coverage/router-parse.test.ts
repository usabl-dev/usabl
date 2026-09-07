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
      <Route path="/clusters" element={<Clusters />} />
      <Route path="/acct\u202eadmin" element={<Admin />} />
      createBrowserRouter([{ path: '/docs\u2800private', element: <Docs /> }])
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
      <Route path="/home" element={<Home />} />
      createBrowserRouter([{ path: '/about', element: <About /> }])
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
    const routes = parseDataRouterRoutes(`
      createBrowserRouter([
        { path: '/home', element: <Home /> },
        { path: '/about', element: <About /> },
      ])
    `);
    expect(routes).toEqual([
      { path: '/home', component: null },
      { path: '/about', component: null },
    ]);
  });

  it('does not attribute a nested child element to its parent route', () => {
    // False-coverage guard. The old brace-slicer bound /parent to Child. Now no component is
    // attributed, so init cannot invent a wrong entry file for the parent route.
    const routes = parseDataRouterRoutes(`
      createBrowserRouter([
        { path: '/parent', children: [{ path: '/child', element: <Child /> }], element: <Parent /> },
      ])
    `);
    expect(routes).toEqual([
      { path: '/parent', component: null },
      { path: '/child', component: null },
    ]);
  });

  it('discovers the root path', () => {
    const routes = parseDataRouterRoutes(`createBrowserRouter([{ path: '/', element: <Root /> }])`);
    expect(routes).toEqual([{ path: '/', component: null }]);
  });

  it('ignores path-like objects outside the create*Router call', () => {
    // A decoy object elsewhere in the module must not be read as a route.
    const routes = parseDataRouterRoutes(`
      const telemetry = { path: '/not-a-route', element: <Decoy /> };
      createBrowserRouter([{ path: '/home', element: <Home /> }]);
    `);
    expect(routes).toEqual([{ path: '/home', component: null }]);
  });

  it('merges jsx and data routes without duplicating paths', () => {
    const merged = mergeParsedRoutes(
      [{ path: '/', component: 'Overview' }],
      [{ path: '/settings', component: 'Settings' }, { path: '/', component: null }],
    );
    expect(merged).toEqual([
      { path: '/', component: 'Overview' },
      { path: '/settings', component: 'Settings' },
    ]);
  });
});

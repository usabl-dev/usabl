import { describe, it, expect } from 'vitest';
import {
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

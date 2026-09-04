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

  it('parses data-router routes with inline components', () => {
    const routes = parseDataRouterRoutes(`
      createBrowserRouter([
        { path: '/home', element: <Home /> },
        { path: '/about', element: <About /> },
      ])
    `);
    expect(routes).toEqual([
      { path: '/home', component: 'Home' },
      { path: '/about', component: 'About' },
    ]);
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

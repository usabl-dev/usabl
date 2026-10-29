/**
 * Route shapes beyond plain <Route> trees and data router lists: route config arrays rendered
 * through map, lazy routes, and leaf route objects that name their component.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readRouterSource } from '../../src/coverage/router-parse.js';

const seedRoutes = readFileSync(
  fileURLToPath(new URL('../../fixtures/init/pf-seed/src/app/routes.tsx', import.meta.url)),
  'utf8',
);

const lineOf = (raw: string, text: string): number => raw.slice(0, raw.indexOf(text)).split('\n').length;

describe('readRouterSource reads a route config array rendered through map', () => {
  it('reads every route in a seed-shaped config, flattened with reduce, with its component', () => {
    const read = readRouterSource(seedRoutes, 'src/app/routes.tsx');
    expect(read.routes.map((route) => [route.path, route.component])).toEqual([
      ['/', 'Dashboard'],
      ['/support', 'Support'],
      ['/settings/general', 'GeneralSettings'],
      ['/settings/profile', 'ProfileSettings'],
    ]);
    expect(read.unreadable).toEqual([]);
    // reduce is code usabl does not run, so the read is a stated assumption with a line.
    expect(read.assumed).toHaveLength(1);
    expect(read.assumed[0]?.line).toBe(lineOf(seedRoutes, 'flattenedRoutes.map('));
    expect(read.assumed[0]?.reason).toContain('reduce');
  });

  it('reads a config mapped straight into a <Switch>, with component fields', () => {
    const raw = [
      "import { Dashboard } from './Dashboard';",
      "import { Support } from './Support';",
      'const routes = [',
      "  { component: Dashboard, exact: true, label: 'Dashboard', path: '/' },",
      "  { component: Support, label: 'Support', path: '/support' },",
      '];',
      'export const AppRoutes = () => (',
      '  <Switch>',
      '    {routes.map(({ path, exact, component }, idx) => (',
      '      <Route path={path} exact={exact} component={component} key={idx} />',
      '    ))}',
      '  </Switch>',
      ');',
    ].join('\n');
    const read = readRouterSource(raw);
    expect(read.routes.map((route) => [route.path, route.component])).toEqual([
      ['/', 'Dashboard'],
      ['/support', 'Support'],
    ]);
    expect(read.unreadable).toEqual([]);
    // A plain map over a literal list is read as written, with nothing assumed.
    expect(read.assumed).toEqual([]);
  });

  it('reads a member-style callback and an element rendered from a component field', () => {
    const raw = [
      "import { Home } from './Home';",
      "const routes = [{ path: '/home', component: Home }];",
      'export const App = () => (',
      '  <Routes>',
      '    {routes.map((route) => <Route key={route.path} path={route.path} element={<route.component />} />)}',
      '  </Routes>',
      ');',
    ].join('\n');
    const read = readRouterSource(raw);
    expect(read.routes.map((route) => [route.path, route.component])).toEqual([['/home', 'Home']]);
  });

  it('joins nested relative config paths to the parent and says it did', () => {
    const raw = [
      'const routes = [',
      "  { path: '/settings', component: Settings, routes: [",
      "    { path: 'general', component: General },",
      "    { path: 'profile', component: Profile },",
      '  ] },',
      '];',
      'const flat = routes.flatMap((r) => [r, ...(r.routes ?? [])]);',
      'export const App = () => (',
      '  <Routes>{flat.map(({ path, component: C }) => <Route path={path} element={<C />} />)}</Routes>',
      ');',
    ].join('\n');
    const read = readRouterSource(raw);
    expect(read.routes.map((route) => [route.path, route.component])).toEqual([
      // A parent with nested routes is a layout: its component is not one screen's entry file.
      ['/settings', null],
      ['/settings/general', 'General'],
      ['/settings/profile', 'Profile'],
    ]);
    expect(read.assumed).toHaveLength(1);
    expect(read.assumed[0]?.line).toBe(9);
    expect(read.assumed[0]?.reason).toContain('flatMap');
    expect(read.assumed[0]?.reason).toContain('joined');
  });

  it('does not attribute a component the callback does not render', () => {
    const raw = [
      "const routes = [{ path: '/a', component: A, element: <B /> }];",
      'export const App = () => (',
      '  <Routes>{routes.map((r) => <Route path={r.path} element={<Shell />} />)}</Routes>',
      ');',
    ].join('\n');
    const read = readRouterSource(raw);
    expect(read.routes).toEqual([expect.objectContaining({ path: '/a', component: null })]);
  });

  it('still names a map it cannot read: a path built from the item, or a list made by a call', () => {
    const raw = [
      "const routes = [{ path: 'a' }];",
      'export const App = () => (',
      '  <Routes>',
      "    {routes.map((r) => <Route path={'/x/' + r.path} />)}",
      '    {loadRoutes().map((r) => <Route path={r.path} />)}',
      '  </Routes>',
      ');',
    ].join('\n');
    const read = readRouterSource(raw);
    expect(read.routes).toEqual([]);
    expect(read.unreadable.map((gap) => gap.line)).toEqual([4, 5]);
  });

  it('names a config list that is changed in place', () => {
    const raw = [
      "const routes = [{ path: '/a', component: A }];",
      "routes.push({ path: '/b', component: B });",
      'export const App = () => <Routes>{routes.map((r) => <Route path={r.path} />)}</Routes>;',
    ].join('\n');
    const read = readRouterSource(raw);
    expect(read.routes).toEqual([]);
    expect(read.unreadable.map((gap) => gap.line)).toEqual([3]);
  });

  it('says when routes are rendered through an element that is not <Route>', () => {
    const raw = [
      "const routes = [{ path: '/a', component: A }];",
      'export const App = () => (',
      '  <Switch>{routes.map(({ path, component }) => <TitledRoute path={path} component={component} />)}</Switch>',
      ');',
    ].join('\n');
    const read = readRouterSource(raw);
    expect(read.routes.map((route) => [route.path, route.component])).toEqual([['/a', 'A']]);
    expect(read.assumed.map((entry) => entry.line)).toEqual([3]);
    expect(read.assumed[0]?.reason).toContain('<TitledRoute>');
  });
});

describe('readRouterSource reads lazy routes', () => {
  it('maps a React.lazy component to the module it imports', () => {
    const raw = [
      "import * as React from 'react';",
      "import { lazy } from 'react';",
      "const Reports = React.lazy(() => import('./pages/Reports'));",
      "const Users = lazy(() => import('./pages/Users').then((m) => ({ default: m.Users })));",
      "export const Billing = lazy(async () => { return import('@app/Billing'); });",
      'const Dynamic = lazy(() => import(name));',
      'export const App = () => (',
      '  <Routes>',
      '    <Route path="/reports" element={<React.Suspense fallback={null}><Reports /></React.Suspense>} />',
      '    <Route path="/users" element={<Users />} />',
      '    <Route path="/billing" element={<Billing />} />',
      '  </Routes>',
      ');',
    ].join('\n');
    const read = readRouterSource(raw);
    expect(read.localImports.get('Reports')).toBe('./pages/Reports');
    expect(read.localImports.get('Users')).toBe('./pages/Users');
    expect(read.localImports.has('Dynamic')).toBe(false);
    expect(read.bareImports.get('Billing')).toBe('@app/Billing');
    expect(read.routes.map((route) => [route.path, route.component])).toEqual([
      ['/reports', 'Reports'],
      ['/users', 'Users'],
      ['/billing', 'Billing'],
    ]);
  });

  it('attributes a data router lazy route to the module it imports, and joins nested paths', () => {
    const raw = [
      "import { Home } from './pages/Home';",
      'export const router = createBrowserRouter([',
      "  { path: '/', element: <Layout />, children: [",
      '    { index: true, element: <Home /> },',
      "    { path: 'reports', lazy: () => import('./routes/reports') },",
      "    { path: 'admin', children: [",
      "      { path: 'users', Component: Users },",
      "      { path: 'audit', lazy: async () => { const m = await import('./routes/audit'); return { Component: m.Audit }; } },",
      '    ] },',
      '  ] },',
      ']);',
    ].join('\n');
    const read = readRouterSource(raw);
    expect(read.routes.map((route) => [route.path, route.component, route.entryImport ?? null])).toEqual([
      // "/" is read twice: as the layout, which has children, and as its index route. The merge
      // keeps the one component it saw for the path.
      ['/', 'Home', null],
      ['/reports', null, './routes/reports'],
      ['/admin', null, null],
      ['/admin/users', 'Users', null],
      ['/admin/audit', null, './routes/audit'],
    ]);
    expect(read.unreadable).toEqual([]);
  });

  it('does not attribute a lazy route whose import it cannot read', () => {
    const raw = [
      'export const router = createBrowserRouter([',
      '  { path: "/a", lazy: () => import(modulePath) },',
      '  { path: "/b", lazy: () => Promise.all([import("./b"), import("./c")]) },',
      ']);',
    ].join('\n');
    const read = readRouterSource(raw);
    expect(read.routes.map((route) => [route.path, route.component, route.entryImport ?? null])).toEqual([
      ['/a', null, null],
      ['/b', null, null],
    ]);
  });

  it('gives no entry to a route whose two sources name different modules', () => {
    const raw = [
      'export const router = createBrowserRouter([',
      "  { path: '/a', element: <A />, lazy: () => import('./other') },",
      ']);',
    ].join('\n');
    const read = readRouterSource(raw);
    expect(read.routes.map((route) => [route.path, route.component, route.entryImport ?? null])).toEqual([
      ['/a', null, null],
    ]);
  });
});

/**
 * usabl init on the router shapes real apps use: a route config array rendered through map (the
 * PatternFly seed shape, read from a fixture that mirrors it), lazy routes, nested route objects,
 * and entry imports written as a directory or as a ".js" path for a TypeScript file.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inferInit, type InitFs } from '../../src/init/index.js';
import { matchGlob } from '../../src/primitives/match-glob.js';
import { parseUsablConfig } from '../../src/intake/config.js';
import { computeCoverage } from '../../src/coverage/planner.js';

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

function fixtureTree(name: string): Record<string, string> {
  const root = fileURLToPath(new URL(`../../fixtures/init/${name}`, import.meta.url));
  const files: Record<string, string> = {};
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else files[relative(root, full).split('\\').join('/')] = readFileSync(full, 'utf8');
    }
  };
  visit(root);
  return files;
}

describe('usabl init on a PatternFly seed-shaped app', () => {
  it('drafts every route with its entry file, and no route needs a hand edit', async () => {
    const draft = await inferInit(memoryFs(fixtureTree('pf-seed')));
    expect(draft.config.discovery.routerFile).toBe('src/app/routes.tsx');
    expect(draft.routes.routes).toEqual([
      { screenId: 'root', url: '/', entryFile: 'src/app/Dashboard/Dashboard.tsx' },
      { screenId: 'support', url: '/support', entryFile: 'src/app/Support/Support.tsx' },
      {
        screenId: 'settings-general',
        url: '/settings/general',
        entryFile: 'src/app/Settings/General/GeneralSettings.tsx',
      },
      {
        screenId: 'settings-profile',
        url: '/settings/profile',
        entryFile: 'src/app/Settings/Profile/ProfileSettings.tsx',
      },
    ]);
    expect(draft.notes).toContain('Attributed 4 of 4 routes to local entry files.');
    expect(draft.notes.some((note) => note.includes('no proven entry file'))).toBe(false);
    expect(draft.notes.some((note) => note.includes('does not list it'))).toBe(false);
    // The reduce that flattens the config is code init does not run, so it says what it assumed,
    // with the file and line, for the operator to confirm.
    const assumed = draft.notes.find((note) => note.includes('reduce'));
    expect(assumed).toMatch(/^Review: src\/app\/routes\.tsx line \d+: /);
  });

  it('writes a config usabl accepts, and a change to a seed page maps to its screen', async () => {
    const files = fixtureTree('pf-seed');
    const draft = await inferInit(memoryFs(files));
    const config = parseUsablConfig(JSON.stringify(draft.config));
    const planFs = memoryFs({ ...files, 'usabl.routes.json': JSON.stringify(draft.routes) });
    const coverage = await computeCoverage(planFs, config, ['src/app/Support/Support.tsx']);
    expect(coverage.gaps).toEqual([]);
    expect(coverage.affected.map((screen) => screen.screenId)).toEqual(['support']);
  });
});

describe('usabl init on nested route objects under a plain map', () => {
  // The map renders one <Route> per top-level item, with no children, so the nested object is not
  // a route the app serves through this map.
  const files = {
    'src/App.tsx': [
      "import { Routes, Route } from 'react-router-dom';",
      "import { Settings } from './Settings';",
      "import { General } from './General';",
      '',
      "const routes = [{ path: '/settings', element: <Settings />, children: [{ path: '/settings/general', element: <General /> }] }];",
      '',
      'export function App() {',
      '  return <Routes>{routes.map((r) => <Route key={r.path} path={r.path} element={r.element} />)}</Routes>;',
      '}',
    ].join('\n'),
    'src/Settings.tsx': 'export function Settings() { return null }\n',
    'src/General.tsx': 'export function General() { return null }\n',
  };

  it('drafts only the top-level route and names the nested one in a Review note', async () => {
    const draft = await inferInit(memoryFs(files));
    expect(draft.routes.routes).toEqual([{ screenId: 'settings', url: '/settings', entryFile: 'src/Settings.tsx' }]);
    const note = draft.notes.find((entry) => entry.includes('nested'));
    expect(note).toMatch(/^Review: src\/App\.tsx line 8: /);
  });

  it('leaves a change to the nested page unresolved, never mapped to a screen', async () => {
    const draft = await inferInit(memoryFs(files));
    const config = parseUsablConfig(JSON.stringify(draft.config));
    const planFs = memoryFs({ ...files, 'usabl.routes.json': JSON.stringify(draft.routes) });
    const coverage = await computeCoverage(planFs, config, ['src/General.tsx']);
    expect(coverage.affected).toEqual([]);
    expect(coverage.gaps.map((gap) => [gap.ref, gap.state])).toEqual([['src/General.tsx', 'unresolved']]);
  });
});

describe('usabl init on lazy routes and nested route objects', () => {
  const page = (name: string): string => `export function ${name}() { return null }\n`;

  it('attributes React.lazy routes and data router lazy routes, and joins nested relative paths', async () => {
    const files = {
      'vite.config.ts': 'export default { server: { port: 5173 } }\n',
      'src/main.tsx': 'import "./router"\n',
      'src/router.tsx': `import * as React from 'react'
import { createBrowserRouter } from 'react-router-dom'
import { Layout } from './Layout'
import { Home } from './pages/Home'

const Reports = React.lazy(() => import('./pages/Reports'))

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Home /> },
      { path: 'reports', element: <React.Suspense fallback={null}><Reports /></React.Suspense> },
      {
        path: 'admin',
        children: [
          { path: 'users', lazy: () => import('./routes/admin/users') },
          { path: 'audit/:id', lazy: () => import('./routes/admin/audit') },
        ],
      },
    ],
  },
])
`,
      'src/Layout.tsx': page('Layout'),
      'src/pages/Home.tsx': page('Home'),
      'src/pages/Reports.tsx': page('Reports'),
      'src/routes/admin/users.tsx': page('Component'),
      'src/routes/admin/audit.tsx': page('Component'),
    };
    const draft = await inferInit(memoryFs(files));
    expect(draft.routes.routes).toEqual([
      { screenId: 'root', url: '/', entryFile: 'src/pages/Home.tsx' },
      { screenId: 'reports', url: '/reports', entryFile: 'src/pages/Reports.tsx' },
      { screenId: 'admin', url: '/admin', entryFile: null },
      { screenId: 'admin-users', url: '/admin/users', entryFile: 'src/routes/admin/users.tsx' },
      { screenId: 'admin-audit-:id', url: '/admin/audit/:id', entryFile: 'src/routes/admin/audit.tsx' },
    ]);
    // The pathless-children layout route is named with its file and line.
    const note = draft.notes.find((entry) => entry.includes('/admin has no proven entry file'));
    expect(note).toMatch(/^Review: src\/router\.tsx line 16: /);
  });
});

describe('usabl init entry file resolution', () => {
  const app = (specifier: string): string => `import { Route, Routes } from 'react-router-dom'
import { Page } from '${specifier}'

export function App() {
  return (
    <Routes>
      <Route path="/page" element={<Page />} />
    </Routes>
  )
}
`;
  const entryFor = async (specifier: string, files: Record<string, string>) => {
    const draft = await inferInit(memoryFs({ 'src/App.tsx': app(specifier), ...files }));
    return { entry: draft.routes.routes[0]?.entryFile ?? null, notes: draft.notes };
  };

  it("tries a directory's index file", async () => {
    expect((await entryFor('./pages/Page', { 'src/pages/Page/index.tsx': 'x' })).entry).toBe(
      'src/pages/Page/index.tsx',
    );
  });

  it('prefers a file over a directory index, as every bundler does', async () => {
    const files = { 'src/pages/Page.tsx': 'x', 'src/pages/Page/index.tsx': 'x' };
    expect((await entryFor('./pages/Page', files)).entry).toBe('src/pages/Page.tsx');
  });

  it('refuses to pick between two index files and names both', async () => {
    const files = { 'src/pages/Page/index.tsx': 'x', 'src/pages/Page/index.ts': 'x' };
    const { entry, notes } = await entryFor('./pages/Page', files);
    expect(entry).toBeNull();
    const note = notes.find((line) => line.includes('/page has no proven entry file'));
    expect(note).toContain('src/pages/Page/index.ts, src/pages/Page/index.tsx');
  });

  it('reads the ./Page.js form as Page.ts or Page.tsx, the TypeScript ESM style', async () => {
    expect((await entryFor('./pages/Page.js', { 'src/pages/Page.ts': 'x' })).entry).toBe('src/pages/Page.ts');
    expect((await entryFor('./pages/Page.js', { 'src/pages/Page.tsx': 'x' })).entry).toBe('src/pages/Page.tsx');
    expect((await entryFor('./pages/Page.jsx', { 'src/pages/Page.tsx': 'x' })).entry).toBe('src/pages/Page.tsx');
    expect((await entryFor('./pages/Page.js', { 'src/pages/Page.js': 'x' })).entry).toBe('src/pages/Page.js');
  });

  it('refuses to pick when the ./Page.js form matches more than one file', async () => {
    const files = { 'src/pages/Page.js': 'x', 'src/pages/Page.ts': 'x' };
    const { entry, notes } = await entryFor('./pages/Page.js', files);
    expect(entry).toBeNull();
    const note = notes.find((line) => line.includes('/page has no proven entry file'));
    expect(note).toContain('src/pages/Page.js, src/pages/Page.ts');
  });

  it('resolves an import through a tsconfig path alias', async () => {
    const tsconfig = JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/app/*'] } } });
    const files = { 'tsconfig.json': tsconfig, 'src/app/Page.tsx': 'x' };
    expect((await entryFor('@app/Page', files)).entry).toBe('src/app/Page.tsx');
  });

  it('names the route with its file and line when no file matches', async () => {
    const { entry, notes } = await entryFor('./pages/Missing', {});
    expect(entry).toBeNull();
    expect(notes).toContain('Review: src/App.tsx line 7: /page has no proven entry file.');
  });
});

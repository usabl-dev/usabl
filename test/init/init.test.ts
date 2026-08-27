import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../../src/surfaces/cli.js';
import { inferInit, writeInitDrafts, type InitFs } from '../../src/init/index.js';
import { matchGlob } from '../../src/primitives/match-glob.js';

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

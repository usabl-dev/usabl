/**
 * usabl init on a repository that holds more than one app. Drafts are scoped to one app
 * directory, every path stays relative to the repository root, and init refuses to pick an app
 * or to write a config that can never produce a verdict.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCliArgs } from '../../src/surfaces/cli.js';
import { formatInitReport, inferInit, writeInitDrafts, type InitFs } from '../../src/init/index.js';
import { matchGlob } from '../../src/primitives/match-glob.js';
import { parseUsablConfig } from '../../src/intake/config.js';
import { computeCoverage } from '../../src/coverage/planner.js';
import { makeFsGlob } from '../../src/deps/fs.js';

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

const monorepo = (): Record<string, string> => fixtureTree('monorepo');

describe('parseCliArgs init --app', () => {
  it('reads the app directory', () => {
    expect(parseCliArgs(['init', '--app', 'packages/admin']).app).toBe('packages/admin');
    expect(parseCliArgs(['init']).app).toBeUndefined();
  });

  it('refuses --app with no value', () => {
    expect(() => parseCliArgs(['init', '--app'])).toThrow('--app requires a value');
    expect(() => parseCliArgs(['init', '--app', '--force'])).toThrow('--app requires a value');
  });
});

describe('usabl init --app on a monorepo', () => {
  it('drafts the admin app with paths relative to the repository root', async () => {
    const draft = await inferInit(memoryFs(monorepo()), { appDir: 'packages/admin' });
    expect(draft.config.appBaseUrl).toBe('https://127.0.0.1:4100');
    expect(draft.config.uiFileGlobs).toEqual(['packages/admin/src/**/*.tsx']);
    expect(draft.config.discovery.routerFile).toBe('packages/admin/src/App.tsx');
    expect(draft.config.discovery.wideBlastGlobs).toEqual([
      'packages/admin/src/main.tsx',
      'packages/admin/src/App.tsx',
      'packages/admin/index.html',
      'packages/admin/vite.config.ts',
    ]);
    // Policy files stay at the root, where CODEOWNERS and the trusted-ref guard look for them.
    expect(draft.config.guardedPaths).toEqual([
      'usabl.config.json',
      'usabl.routes.json',
      '.usabl-evidence.json',
      '.usabl-waivers.json',
    ]);
    expect(draft.routes.routes).toEqual([
      { screenId: 'users', url: '/users', entryFile: 'packages/admin/src/pages/Users.tsx' },
      { screenId: 'audit', url: '/audit', entryFile: 'packages/admin/src/pages/Audit.tsx' },
    ]);
    expect(draft.config.surfaces.map((surface) => surface.url)).toEqual([
      'https://127.0.0.1:4100/users',
      'https://127.0.0.1:4100/audit',
    ]);
    expect(draft.notes).toContain('Inferred appBaseUrl from packages/admin/vite.config.ts: port 4100, https.');
    expect(parseUsablConfig(JSON.stringify(draft.config)).uiFileGlobs).toEqual(['packages/admin/src/**/*.tsx']);
  });

  it('names a workspace package the app depends on, whose changes the config does not count', async () => {
    const admin = await inferInit(memoryFs(monorepo()), { appDir: 'packages/admin' });
    const note = admin.notes.find((line) => line.includes('packages/shared'));
    expect(note).toMatch(/^Review: /);
    expect(note).toContain('@mono/shared');
    expect(note).toContain('uiFileGlobs');
    const web = await inferInit(memoryFs(monorepo()), { appDir: 'packages/web' });
    expect(web.notes.some((line) => line.includes('packages/shared'))).toBe(false);
  });

  it('drafts the web app and says it could not read a port set by code', async () => {
    const draft = await inferInit(memoryFs(monorepo()), { appDir: 'packages/web' });
    expect(draft.config.appBaseUrl).toBe('http://127.0.0.1:5173');
    expect(draft.config.uiFileGlobs).toEqual(['packages/web/src/**/*.tsx']);
    expect(draft.config.discovery.routerFile).toBe('packages/web/src/router.tsx');
    expect(draft.routes.routes.map((route) => route.url)).toEqual(['/']);
    const note = draft.notes.find((line) => line.includes('packages/web/vite.config.ts'));
    expect(note).toMatch(/^Review: /);
    expect(note).toContain('server.port');
    expect(note).toContain('appBaseUrl');
  });

  it('accepts the app directory written with ./ or a trailing slash', async () => {
    const draft = await inferInit(memoryFs(monorepo()), { appDir: './packages/admin/' });
    expect(draft.config.discovery.routerFile).toBe('packages/admin/src/App.tsx');
  });

  it('refuses an app directory outside the repository, or one with no files', async () => {
    await expect(inferInit(memoryFs(monorepo()), { appDir: '../elsewhere' })).rejects.toThrow(
      'must be a folder inside this repository',
    );
    await expect(inferInit(memoryFs(monorepo()), { appDir: '/abs/path' })).rejects.toThrow(
      'must be a folder inside this repository',
    );
    await expect(inferInit(memoryFs(monorepo()), { appDir: 'packages/missing' })).rejects.toThrow(
      'has no files',
    );
  });

  it('does not scan one app for a change in the other', async () => {
    const files = monorepo();
    const draft = await inferInit(memoryFs(files), { appDir: 'packages/admin' });
    const config = parseUsablConfig(JSON.stringify(draft.config));
    const planFs = memoryFs({ ...files, 'usabl.routes.json': JSON.stringify(draft.routes) });

    const webChange = await computeCoverage(planFs, config, ['packages/web/src/pages/Home.tsx']);
    expect(webChange.nothingToCheck).toBe(true);
    expect(webChange.affected).toEqual([]);

    const sharedChange = await computeCoverage(planFs, config, ['packages/shared/src/Button.tsx']);
    expect(sharedChange.nothingToCheck).toBe(true);

    const adminChange = await computeCoverage(planFs, config, ['packages/admin/src/pages/Users.tsx']);
    expect(adminChange.affected.map((screen) => screen.screenId)).toEqual(['users']);
    expect(adminChange.gaps).toEqual([]);
  });
});

describe('usabl init --app on a PatternFly seed-shaped app in a monorepo', () => {
  // packages/admin is replaced with the seed fixture: its router is src/app/routes.tsx, its imports
  // go through the @app alias in its own tsconfig.json, and its shell is src/index.tsx and
  // src/index.html. It has no Vite config.
  const files = (): Record<string, string> => {
    const tree: Record<string, string> = {};
    for (const [path, contents] of Object.entries(monorepo())) {
      if (!path.startsWith('packages/admin/')) tree[path] = contents;
    }
    for (const [path, contents] of Object.entries(fixtureTree('pf-seed'))) tree[`packages/admin/${path}`] = contents;
    return tree;
  };

  it('attributes every route with paths under the app folder', async () => {
    const draft = await inferInit(memoryFs(files()), { appDir: 'packages/admin' });
    expect(draft.config.discovery.routerFile).toBe('packages/admin/src/app/routes.tsx');
    expect(draft.routes.routes).toEqual([
      { screenId: 'root', url: '/', entryFile: 'packages/admin/src/app/Dashboard/Dashboard.tsx' },
      { screenId: 'support', url: '/support', entryFile: 'packages/admin/src/app/Support/Support.tsx' },
      {
        screenId: 'settings-general',
        url: '/settings/general',
        entryFile: 'packages/admin/src/app/Settings/General/GeneralSettings.tsx',
      },
      {
        screenId: 'settings-profile',
        url: '/settings/profile',
        entryFile: 'packages/admin/src/app/Settings/Profile/ProfileSettings.tsx',
      },
    ]);
    expect(draft.notes).toContain('Attributed 4 of 4 routes to local entry files.');
    expect(draft.config.discovery.wideBlastGlobs).toEqual([
      'packages/admin/src/index.tsx',
      'packages/admin/src/app/routes.tsx',
      'packages/admin/src/index.html',
      'packages/admin/src/app/app.css',
    ]);
    expect(draft.config.uiFileGlobs).toEqual(['packages/admin/src/**/*.tsx']);
  });

  it('finds the app by its src/app/routes.tsx router when no --app is given', async () => {
    await expect(inferInit(memoryFs(files()))).rejects.toThrow(/packages\/admin\n {2}packages\/web\n/);
  });

  it('maps a change to a seed page to its screen', async () => {
    const tree = files();
    const draft = await inferInit(memoryFs(tree), { appDir: 'packages/admin' });
    const config = parseUsablConfig(JSON.stringify(draft.config));
    const planFs = memoryFs({ ...tree, 'usabl.routes.json': JSON.stringify(draft.routes) });
    const coverage = await computeCoverage(planFs, config, ['packages/admin/src/app/Support/Support.tsx']);
    expect(coverage.gaps).toEqual([]);
    expect(coverage.affected.map((screen) => screen.screenId)).toEqual(['support']);
  });
});

describe('usabl init with no --app on a monorepo', () => {
  it('refuses to pick between two apps and names both with the flag to use', async () => {
    const fs = memoryFs(monorepo());
    const refusal = inferInit(fs);
    await expect(refusal).rejects.toThrow('more than one app');
    const message = await refusal.catch((err: Error) => err.message);
    expect(message).toContain('packages/admin');
    expect(message).toContain('packages/web');
    expect(message).toContain('usabl init --app packages/admin');
    expect(message).not.toContain('packages/shared');
    expect(Object.keys(fs.store).filter((path) => path.startsWith('usabl.'))).toEqual([]);
  });

  it('finds both apps on the real file system too', async () => {
    const real = makeFsGlob({ cwd: fileURLToPath(new URL('../../fixtures/init/monorepo', import.meta.url)) });
    const fs: InitFs = {
      ...real,
      writeFile: async () => {
        throw new Error('this test never writes');
      },
    };
    await expect(inferInit(fs)).rejects.toThrow(/packages\/admin\n {2}packages\/web\n/);
    const draft = await inferInit(fs, { appDir: 'packages/admin' });
    expect(draft.config.uiFileGlobs).toEqual(['packages/admin/src/**/*.tsx']);
  });

  it('drafts the one app it finds under apps/, and says which', async () => {
    const files = monorepo();
    const one: Record<string, string> = {};
    for (const [path, contents] of Object.entries(files)) {
      if (path.startsWith('packages/admin/')) one[path.replace('packages/admin/', 'apps/console/')] = contents;
      else if (!path.startsWith('packages/web/')) one[path] = contents;
    }
    const draft = await inferInit(memoryFs(one));
    expect(draft.config.discovery.routerFile).toBe('apps/console/src/App.tsx');
    expect(draft.config.uiFileGlobs).toEqual(['apps/console/src/**/*.tsx']);
    expect(draft.notes.some((note) => note.includes('apps/console') && note.includes('--app'))).toBe(true);
  });

  it('finds an app by its Vite config in any folder, not only packages/ or apps/', async () => {
    const draft = await inferInit(
      memoryFs({
        'platform/vite.config.ts': 'export default { server: { port: 4100 } }\n',
        'platform/src/main.tsx': 'export {}\n',
        'node_modules/some-lib/vite.config.ts': 'export default {}\n',
      }),
    );
    expect(draft.config.appBaseUrl).toBe('http://127.0.0.1:4100');
    expect(draft.config.uiFileGlobs).toEqual(['platform/src/**/*.tsx']);
  });

  it('keeps the single app at the repository root as it was', async () => {
    const draft = await inferInit(
      memoryFs({
        'vite.config.ts': 'export default { server: { port: 5173 } }\n',
        'src/App.tsx': 'export const App = () => <Routes><Route path="/a" element={<A />} /></Routes>;\n',
        'packages/admin/vite.config.ts': 'export default {}\n',
        'packages/admin/src/main.tsx': 'export {}\n',
      }),
    );
    expect(draft.config.discovery.routerFile).toBe('src/App.tsx');
    expect(draft.config.uiFileGlobs).toEqual(['src/**/*.tsx']);
  });
});

describe('usabl init never writes a config that reads as idle', () => {
  it('refuses to write a config with no UI file globs, and says what to set', async () => {
    const fs = memoryFs({ 'README.md': '# nothing here\n' });
    const refusal = inferInit(fs);
    await expect(refusal).rejects.toThrow('uiFileGlobs');
    const message = await refusal.catch((err: Error) => err.message);
    expect(message).toContain('nothing was written');
    expect(message).toContain('--app');
    expect(Object.keys(fs.store)).toEqual(['README.md']);
  });

  it('drafts the globs for a JSX app instead of refusing it', async () => {
    const draft = await inferInit(memoryFs({ 'src/App.jsx': 'export const App = () => null;\n' }));
    expect(draft.config.uiFileGlobs).toEqual(['src/**/*.jsx']);
  });

  it('writes no routes sidecar when no route can be derived, and points to the manual mapping', async () => {
    const fs = memoryFs({
      'vite.config.ts': 'export default { server: { port: 5173 } }\n',
      'src/main.tsx': 'export {}\n',
      'src/Shell.tsx': 'export const Shell = () => null;\n',
    });
    const draft = await inferInit(fs);
    expect(draft.routes.routes).toEqual([]);
    const result = await writeInitDrafts(fs, draft, { force: false });
    expect(result.ok).toBe(true);
    expect(result.written).toEqual(['usabl.config.json']);
    expect(fs.store['usabl.routes.json']).toBeUndefined();
    const report = formatInitReport(draft, result);
    expect(report).toContain('did not write usabl.routes.json');
    expect(report).toContain('surfaces');
    expect(report).toContain('not covered');
  });
});

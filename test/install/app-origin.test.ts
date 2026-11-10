/**
 * `usabl install --ci` reads where the app is served so its report can say it plainly, and never
 * guesses. The trusted appBaseUrl in usabl.config.json comes first, because the judge and the
 * history scan both use it. Before init has run, the port comes from the app: the dev script, the
 * Vite config, or the webpack dev server config. When none can be read, the report names every
 * place it looked.
 */
import { describe, expect, it } from 'vitest';
import { matchGlob } from '../../src/primitives/match-glob.js';
import type { InstallFs } from '../../src/install/index.js';
import { hasDevScript, readAppOrigin } from '../../src/install/app-origin.js';

function memoryFs(files: Record<string, string>): InstallFs {
  return {
    readFile: async (path) => files[path] ?? null,
    glob: async (patterns) => Object.keys(files).filter((f) => patterns.some((p) => matchGlob(p, f))),
    writeFile: async () => {
      throw new Error('readAppOrigin must not write');
    },
  };
}

const config = (appBaseUrl: unknown): string => JSON.stringify({ appBaseUrl, uiFileGlobs: ['src/**'] });

// patternfly-react-seed's dev config: the port is a const that falls back to 9000.
const SEED_DEV_CONFIG = `const path = require('path');
const { merge } = require('webpack-merge');
const common = require('./webpack.common.js');
const HOST = process.env.HOST || 'localhost';
const PORT = process.env.PORT || '9000';

module.exports = merge(common('development'), {
  mode: 'development',
  devtool: 'eval-source-map',
  devServer: {
    host: HOST,
    port: PORT,
    historyApiFallback: true,
    open: true,
  },
});
`;
const SEED_PACKAGE = JSON.stringify({
  scripts: { 'start:dev': 'webpack serve --color --progress --config webpack.dev.js', build: 'webpack --config webpack.prod.js' },
});

describe('readAppOrigin from usabl.config.json', () => {
  it('takes a loopback http appBaseUrl with an explicit port', async () => {
    expect(await readAppOrigin(memoryFs({ 'usabl.config.json': config('http://127.0.0.1:9000/') }))).toEqual({
      kind: 'config',
      origin: 'http://127.0.0.1:9000',
    });
  });

  it('prefers appBaseUrl over anything the app files say', async () => {
    const fs = memoryFs({
      'usabl.config.json': config('http://localhost:5174'),
      'vite.config.ts': 'export default { server: { port: 3000 } }\n',
    });
    expect(await readAppOrigin(fs)).toEqual({ kind: 'config', origin: 'http://localhost:5174' });
  });

  it.each([
    ['not JSON', '{', 'does not parse as JSON'],
    ['no appBaseUrl', JSON.stringify({}), 'has no appBaseUrl'],
    ['not a URL', config('nope'), 'is not a URL'],
    ['https', config('https://127.0.0.1:5173'), 'must use http'],
    ['off loopback', config('http://10.0.0.5:5173'), 'loopback host'],
    ['no port', config('http://127.0.0.1'), 'explicit port'],
  ])('says what is wrong when appBaseUrl is %s', async (_case, raw, problem) => {
    const origin = await readAppOrigin(memoryFs({ 'usabl.config.json': raw }));
    expect(origin.kind).toBe('config-invalid');
    expect(origin.kind === 'config-invalid' && origin.problem).toContain(problem);
  });
});

describe('readAppOrigin before init has run', () => {
  it('reads --port from the dev script', async () => {
    const fs = memoryFs({ 'package.json': JSON.stringify({ scripts: { dev: 'vite --port 3000 --host' } }) });
    expect(await readAppOrigin(fs)).toEqual({ kind: 'app', port: 3000, source: 'package.json script "dev"' });
    const equals = memoryFs({ 'package.json': JSON.stringify({ scripts: { dev: 'vite --port=3001' } }) });
    expect(await readAppOrigin(equals)).toMatchObject({ kind: 'app', port: 3001 });
  });

  it('reads server.port from the Vite config', async () => {
    const fs = memoryFs({ 'vite.config.ts': 'import { defineConfig } from "vite"\nexport default defineConfig({ server: { port: 4000 } })\n' });
    expect(await readAppOrigin(fs)).toEqual({ kind: 'app', port: 4000, source: 'vite.config.ts' });
  });

  it("takes Vite's default port when the Vite config sets none, and says so", async () => {
    const fs = memoryFs({ 'vite.config.mts': 'export default {}\n' });
    expect(await readAppOrigin(fs)).toEqual({
      kind: 'app',
      port: 5173,
      source: "Vite's default port, because vite.config.mts sets no server.port",
    });
  });

  it('reads the webpack dev server port on the PatternFly seed as 9000', async () => {
    const fs = memoryFs({
      'package.json': SEED_PACKAGE,
      'webpack.common.js': 'module.exports = () => ({});\n',
      'webpack.dev.js': SEED_DEV_CONFIG,
      'webpack.prod.js': "module.exports = { mode: 'production' };\n",
    });
    expect(await readAppOrigin(fs)).toEqual({
      kind: 'app',
      port: 9000,
      source: 'webpack.dev.js, devServer.port, the value it uses when PORT is not set',
    });
  });

  it('reads a literal webpack dev server port', async () => {
    const fs = memoryFs({ 'webpack.config.js': 'module.exports = { devServer: { port: 8080 } };\n' });
    expect(await readAppOrigin(fs)).toEqual({ kind: 'app', port: 8080, source: 'webpack.config.js, devServer.port' });
  });

  it('never guesses a port set by code, and names every place it looked', async () => {
    const fs = memoryFs({
      'package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
      'vite.config.ts': 'export default { server: { port: Number(process.env.PORT) } }\n',
    });
    const origin = await readAppOrigin(fs);
    expect(origin.kind).toBe('unread');
    expect(origin.kind === 'unread' && origin.lookedIn).toEqual([
      'usabl.config.json (absent)',
      'package.json script "dev" (no --port)',
      'vite.config.ts (sets server.port with code usabl does not run)',
      'webpack configs (none found)',
    ]);
  });

  it('names every place it looked in an empty folder', async () => {
    const origin = await readAppOrigin(memoryFs({}));
    expect(origin.kind === 'unread' && origin.lookedIn).toEqual([
      'usabl.config.json (absent)',
      'package.json script "dev" (absent)',
      'vite.config.ts, .js, .mts, .mjs, .cts, or .cjs (absent)',
      'webpack configs (none found)',
    ]);
  });

  it('never reads a port the webpack config sets with code', async () => {
    const fs = memoryFs({ 'webpack.config.js': 'module.exports = { devServer: { port: Number(process.env.PORT) } };\n' });
    const origin = await readAppOrigin(fs);
    expect(origin.kind === 'unread' && origin.lookedIn).toContain('webpack.config.js (sets devServer.port with code usabl does not run)');
  });
});

describe('hasDevScript', () => {
  it('is true only when package.json has a dev script', async () => {
    expect(await hasDevScript(memoryFs({ 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }) }))).toBe(true);
    expect(await hasDevScript(memoryFs({ 'package.json': SEED_PACKAGE }))).toBe(false);
    expect(await hasDevScript(memoryFs({}))).toBe(false);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import type { Result } from '../../src/contracts/index.js';
import { usablVitePlugin } from '../../src/surfaces/vite-plugin.js';

// The overlay is a dev-server surface. Its loader imports a module only the dev server answers,
// so in a production build it would ship a request for a path that does not exist, and the
// webpack plugin already stays out of production builds. The Vite plugin must do the same.

const result: Result = {
  schemaVersion: 'usabl.result.v1',
  verdict: 'verified',
  summary: 'verified',
  screens: [],
  coverage: { changedFiles: [], affected: [], unresolvedFiles: [], gaps: [], nothingToCheck: false },
  findings: [],
  receipt: null,
  dirtyGuardedPaths: [],
  exitCode: 0,
  accessibilityVerdict: null,
  accessibilityExitCode: 0,
  paidDownCount: 0,
  floorHeadroom: [],
  floorUnconfirmed: [],
};

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('usablVitePlugin in a production build', () => {
  it('leaves the overlay loader out of the built HTML', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usabl-vite-build-'));
    made.push(root);
    await writeFile(join(root, 'index.html'), '<!doctype html><html lang="en"><head><title>app</title></head><body><main>app</main></body></html>\n');

    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [usablVitePlugin({ run: async () => result }) as never],
      build: { outDir: join(root, 'dist'), emptyOutDir: true },
    });
    const built = await readFile(join(root, 'dist', 'index.html'), 'utf8');

    expect(built).toContain('<main>app</main>');
    expect(built).not.toContain('/__usabl/client.js');
    expect(built).not.toContain('navigator.webdriver');
  });

  it('still injects the loader when the dev server serves the page', async () => {
    const plugin = usablVitePlugin({ run: async () => result });
    plugin.configResolved?.({ command: 'serve' });

    const served = await plugin.transformIndexHtml?.('<html><body><main>app</main></body></html>');

    expect(served).toContain('/__usabl/client.js');
  });

  it('injects nothing before Vite says whether it is serving or building', async () => {
    const plugin = usablVitePlugin({ run: async () => result });
    const html = '<html><body><main>app</main></body></html>';

    expect(await plugin.transformIndexHtml?.(html)).toBe(html);
  });
});

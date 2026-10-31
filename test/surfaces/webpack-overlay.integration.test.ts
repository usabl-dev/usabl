/**
 * The webpack overlay end to end: a seed-shaped app served by webpack-dev-server with the plugin,
 * a real engine run in real Chromium, and the overlay's result endpoint read the way the panel
 * reads it. The finding on the known barrier must carry its exact source line, which only the
 * plugin's development transform can put there.
 *
 * The dev server is started the way `webpack serve` starts it: from the devServer options on the
 * compiler, after the plugin has been applied to it.
 *
 * Gated behind USABL_INTEGRATION=1 like the other browser tests, because it launches Chromium.
 */
import { execFile } from 'node:child_process';
import { appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import webpack from 'webpack';
import WebpackDevServer from 'webpack-dev-server';
import { UsablWebpackPlugin } from '../../src/surfaces/webpack-plugin.js';
import { BARRIER_FILE, BARRIER_LINE, copySeedApp, seedDevConfig } from '../fixtures/webpack-seed-app.js';

const execFileAsync = promisify(execFile);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

interface ProjectedFinding {
  rule: string;
  screenId: string;
  appSource: { tier: string; file: string | null; line: number | null } | null;
}

describe.skipIf(process.env.USABL_INTEGRATION !== '1')('webpack overlay on a live dev server', { timeout: 180_000 }, () => {
  let root: string;
  let server: WebpackDevServer;
  let base: string;

  beforeAll(async () => {
    root = await copySeedApp();
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    await writeFile(
      join(root, 'usabl.config.json'),
      `${JSON.stringify(
        {
          appBaseUrl: base,
          uiFileGlobs: ['src/**'],
          discovery: { routerFile: 'src/index.tsx', wideBlastGlobs: [] },
          surfaces: [{ id: 'deployments', url: `${base}/`, files: [BARRIER_FILE] }],
          guardedPaths: [],
        },
        null,
        2,
      )}\n`,
    );
    await git(root, 'init', '--quiet');
    await git(root, 'config', 'user.name', 'usabl test');
    await git(root, 'config', 'user.email', 'test@usabl.invalid');
    await git(root, 'add', '.');
    await git(root, 'commit', '--quiet', '-m', 'seed');
    // The change under check. A trailing comment moves no line, so the barrier stays on its line.
    await appendFile(join(root, BARRIER_FILE), '// changed\n');

    const compiler = webpack(
      seedDevConfig(root, [new UsablWebpackPlugin({ cwd: root })], port) as webpack.Configuration,
    );
    server = new WebpackDevServer({ ...(compiler.options.devServer ?? {}) }, compiler);
    await server.start();
  }, 120_000);

  afterAll(async () => {
    await server?.stop();
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serves the overlay loader in the dev bundle and the client from the dev server', async () => {
    const bundle = await (await fetch(`${base}/main.bundle.js`)).text();
    expect(bundle).toContain('/__usabl/client.js');
    const client = await fetch(`${base}/__usabl/client.js`);
    expect(client.status).toBe(200);
    expect(await client.text()).toContain("new EventSource('/__usabl/events')");
  });

  it('reports the barrier with its exact source line', async () => {
    const response = await fetch(`${base}/__usabl/result`);
    expect(response.status).toBe(200);
    const projected = (await response.json()) as { findings: ProjectedFinding[]; coverage: { gaps: unknown[] } };
    const finding = projected.findings.find((entry) => entry.rule === 'button-name');
    expect(finding, JSON.stringify(projected.coverage.gaps)).toBeDefined();
    expect(finding?.screenId).toBe('deployments');
    expect(finding?.appSource).toEqual({
      tier: 'renderer',
      file: BARRIER_FILE,
      line: BARRIER_LINE,
      candidates: [BARRIER_FILE],
    });
    // The line is the one the barrier is on in the source the developer edits.
    const source = (await readFile(join(root, BARRIER_FILE), 'utf8')).split('\n');
    expect(source[BARRIER_LINE - 1]).toContain('<button');
  });
});

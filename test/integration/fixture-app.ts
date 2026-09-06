/**
 * Shared setup for the integration suites that drive the live usabl demo app.
 *
 * The demo app is a separate repository. Its checkout path comes from the
 * `USABL_FIXTURE_APP_CWD` environment variable so nothing here depends on one
 * machine's layout. Two outcomes are possible before any test runs:
 *
 * - The variable is unset, or `USABL_INTEGRATION` is not `1`: the suite skips and
 *   the skip note states the exact command that runs it.
 * - The variable is set but the path is missing or is not the demo app: the module
 *   throws so the suite fails. A fixture the caller asked for must never skip.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { accessSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseUsablConfig } from '../../src/intake/config.js';
import type { UsablConfig } from '../../src/contracts/index.js';

export const FIXTURE_APP_ENV = 'USABL_FIXTURE_APP_CWD';
const DEMO_APP_PACKAGE_NAME = 'usabl-app';

export type FixtureServerProcess = ReturnType<typeof spawn>;

export type FixtureAppRequest =
  | { kind: 'skip'; note: string }
  | { kind: 'run'; cwd: string };

export const RUN_COMMAND = `${FIXTURE_APP_ENV}=/path/to/usabl-app npm run test:demo-integration`;

function readPackageName(cwd: string): string | null {
  const raw = readFileSync(join(cwd, 'package.json'), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const name = Reflect.get(parsed, 'name');
  return typeof name === 'string' ? name : null;
}

/**
 * Checks that `cwd` is a checkout of the usabl demo app. Throws with the reason
 * when it is not, so an explicitly requested fixture never turns into a skip.
 */
export function assertDemoApp(cwd: string): void {
  const problem = (reason: string): Error =>
    new Error(`${FIXTURE_APP_ENV}=${cwd} is not the usabl demo app: ${reason}`);
  try {
    if (!statSync(cwd).isDirectory()) {
      throw problem('path is not a directory');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw problem('path does not exist');
    }
    throw error;
  }
  for (const required of ['usabl.config.json', 'package.json']) {
    try {
      accessSync(join(cwd, required));
    } catch {
      throw problem(`${required} is missing`);
    }
  }
  const name = readPackageName(cwd);
  if (name !== DEMO_APP_PACKAGE_NAME) {
    throw problem(`package.json name is ${JSON.stringify(name)}, expected ${JSON.stringify(DEMO_APP_PACKAGE_NAME)}`);
  }
}

/**
 * Resolves whether the demo-app suites run. Skips carry the exact run command.
 * An explicitly requested but invalid fixture throws here, at module load, so the
 * test file itself fails instead of silently reporting zero tests.
 */
export function requestFixtureApp(): FixtureAppRequest {
  const cwd = process.env[FIXTURE_APP_ENV];
  if (cwd !== undefined && cwd.trim().length > 0) {
    assertDemoApp(cwd);
  }
  if (process.env['USABL_INTEGRATION'] !== '1') {
    return { kind: 'skip', note: `needs a live demo app and Chromium; run: ${RUN_COMMAND}` };
  }
  if (cwd === undefined || cwd.trim().length === 0) {
    return { kind: 'skip', note: `${FIXTURE_APP_ENV} is unset; run: ${RUN_COMMAND}` };
  }
  return { kind: 'run', cwd };
}

/**
 * Loads the demo app's own usabl.config.json and points it at the test server.
 * Only the origin changes. Surfaces, files, discovery, and guarded paths stay as
 * the demo ships them, so the suite checks the configuration the demo runs with.
 */
export function loadFixtureConfig(cwd: string, baseUrl: string): UsablConfig {
  const config = parseUsablConfig(readFileSync(join(cwd, 'usabl.config.json'), 'utf8'));
  const shippedOrigin = config.appBaseUrl;
  const retarget = (url: string): string => {
    if (!url.startsWith(shippedOrigin)) {
      throw new Error(`fixture surface url ${url} does not start with the configured appBaseUrl ${shippedOrigin}`);
    }
    return `${baseUrl}${url.slice(shippedOrigin.length)}`;
  };
  return {
    ...config,
    appBaseUrl: baseUrl,
    surfaces: config.surfaces.map((surface) => ({ ...surface, url: retarget(surface.url) })),
  };
}

export function startFixtureServer(cwd: string, port: number): FixtureServerProcess {
  return spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function attachOutputBuffer(server: FixtureServerProcess): string[] {
  if (server.stdout === null || server.stderr === null) {
    throw new Error('fixture server must expose stdout and stderr pipes');
  }
  const output: string[] = [];
  server.stdout.on('data', (chunk: Buffer) => {
    output.push(chunk.toString('utf8'));
  });
  server.stderr.on('data', (chunk: Buffer) => {
    output.push(chunk.toString('utf8'));
  });
  return output;
}

export function summarizeOutput(chunks: string[]): string {
  const compact = chunks.join('').trim();
  if (compact.length === 0) {
    return 'no fixture server output';
  }
  return compact.slice(-3000);
}

export async function waitForServerReady(
  server: FixtureServerProcess,
  output: string[],
  probeUrl: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastReason = 'request never succeeded';
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(
        `fixture dev server exited before ready with code ${server.exitCode}: ${summarizeOutput(output)}`,
      );
    }
    try {
      const response = await fetch(probeUrl);
      if (response.ok) {
        return;
      }
      lastReason = `HTTP ${response.status}`;
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
    await delay(200);
  }
  throw new Error(`fixture dev server did not become ready: ${lastReason}; output: ${summarizeOutput(output)}`);
}

export async function stopFixtureServer(server: FixtureServerProcess): Promise<void> {
  if (server.exitCode !== null) {
    return;
  }
  server.kill('SIGTERM');
  const graceful = await Promise.race([once(server, 'exit'), delay(5_000).then(() => null)]);
  if (graceful === null && server.exitCode === null) {
    server.kill('SIGKILL');
    await once(server, 'exit');
  }
}

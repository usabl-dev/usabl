/**
 * Shared setup for the integration suites that drive the live usabl demo app.
 *
 * The demo app is a separate repository. Its checkout path comes from the
 * `USABL_FIXTURE_APP_CWD` environment variable so nothing here depends on one
 * machine's layout. Before any test runs, one of three things happens:
 *
 * - `USABL_INTEGRATION` is not `1`: the suite skips. The path variable is not
 *   read at all, so a stale value cannot break the default suite.
 * - `USABL_INTEGRATION=1` but the path variable is unset: the suite skips and the
 *   note states the exact command that runs it.
 * - `USABL_INTEGRATION=1` and the path is set but missing or not the demo app:
 *   the module throws so the suite fails. A fixture the caller asked for must
 *   never turn into a skip.
 *
 * The suites never touch the real checkout. They clone it at HEAD into a
 * temporary directory, give the clone a `node_modules` whose entries link to the
 * real app's packages except `usabl`, which links to this engine repository, and
 * do every break and repair edit in the clone. Removing the clone is a plain
 * directory removal, so a killed run leaves at most a stray temp dir. The real
 * app must have a clean `git status` before and after, and the suites assert it.
 *
 * The clone's dev server loads `usabl/vite` from `node_modules/usabl`, so the
 * engine's built `dist/` must exist. `npm run test:demo-integration` builds first.
 */
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { accessSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseUsablConfig } from '../../src/intake/config.js';
import type { Finding, UsablConfig } from '../../src/contracts/index.js';

const execFileAsync = promisify(execFile);

export const FIXTURE_APP_ENV = 'USABL_FIXTURE_APP_CWD';
export const RUN_COMMAND = `${FIXTURE_APP_ENV}=/path/to/usabl-app npm run test:demo-integration`;
const DEMO_APP_PACKAGE_NAME = 'usabl-app';
const ENGINE_PACKAGE_NAME = 'usabl';
// Vite writes its dependency cache into these entries. The clone gets its own so the
// real app's node_modules is never written to.
const NODE_MODULES_NOT_LINKED = new Set([ENGINE_PACKAGE_NAME, '.vite', '.vite-temp', '.tmp']);
const MARKER_FILE = 'usabl-fixture-marker.txt';
const OVERLAY_LOADER = "import('/__usabl/client.js')";
const REQUEST_TIMEOUT_MS = 2_000;

export type FixtureAppRequest =
  | { kind: 'skip'; note: string }
  | { kind: 'run'; cwd: string };

export interface DisposableApp {
  /** The clone the suite runs against. Every edit happens here. */
  cwd: string;
  /** The real checkout the clone came from. Never written to. */
  sourceCwd: string;
  /** Commit both the real checkout and the clone sit on. */
  head: string;
  /** Resolved path of the engine the clone's `node_modules/usabl` points at. */
  enginePath: string;
  /** Random token served from the clone's public directory; proves a server is ours. */
  token: string;
  dispose(): Promise<void>;
}

export interface FixtureServer {
  process: ReturnType<typeof spawn>;
  baseUrl: string;
  port: number;
  output: string[];
}

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
  if (process.env['USABL_INTEGRATION'] !== '1') {
    return { kind: 'skip', note: `needs a live demo app and Chromium; run: ${RUN_COMMAND}` };
  }
  const cwd = process.env[FIXTURE_APP_ENV];
  if (cwd === undefined || cwd.trim().length === 0) {
    return { kind: 'skip', note: `${FIXTURE_APP_ENV} is unset; run: ${RUN_COMMAND}` };
  }
  assertDemoApp(cwd);
  return { kind: 'run', cwd };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout;
}

/** Fails when the real demo app has any uncommitted change. The suites must not be the cause. */
export async function assertRealAppClean(cwd: string, moment: string): Promise<void> {
  const status = (await git(cwd, ['status', '--porcelain'])).trim();
  if (status.length > 0) {
    throw new Error(`the demo app at ${cwd} has uncommitted changes ${moment}:\n${status}`);
  }
}

/** The engine repository this test file belongs to. */
export function engineRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url));
}

async function linkNodeModules(sourceCwd: string, cloneCwd: string): Promise<string> {
  const sourceModules = join(sourceCwd, 'node_modules');
  const cloneModules = join(cloneCwd, 'node_modules');
  await mkdir(cloneModules);
  for (const entry of await readdir(sourceModules)) {
    if (NODE_MODULES_NOT_LINKED.has(entry)) {
      continue;
    }
    await symlink(join(sourceModules, entry), join(cloneModules, entry));
  }

  const engine = engineRoot();
  try {
    accessSync(join(engine, 'dist', 'vite-plugin.js'));
  } catch {
    throw new Error(`${engine} has no dist/vite-plugin.js; run npm run build in the engine first`);
  }
  await symlink(engine, join(cloneModules, ENGINE_PACKAGE_NAME));

  // The clone must load the engine under test: the repository that holds this very file.
  const resolvedEngine = await realpath(join(cloneModules, ENGINE_PACKAGE_NAME));
  const thisFile = await realpath(fileURLToPath(import.meta.url));
  if (!thisFile.startsWith(`${resolvedEngine}/`)) {
    throw new Error(
      `the clone's node_modules/${ENGINE_PACKAGE_NAME} resolves to ${resolvedEngine}, which does not contain ${thisFile}`,
    );
  }
  if (readPackageName(resolvedEngine) !== ENGINE_PACKAGE_NAME) {
    throw new Error(`${resolvedEngine} is not the ${ENGINE_PACKAGE_NAME} package`);
  }
  return resolvedEngine;
}

/**
 * Clones the real demo app at HEAD into a temporary directory and wires its
 * `node_modules` to the real packages plus this engine. Every suite edit happens in
 * the clone. `dispose()` removes the whole temporary directory.
 */
export async function createDisposableApp(sourceCwd: string): Promise<DisposableApp> {
  await assertRealAppClean(sourceCwd, 'before the suite started');
  const head = (await git(sourceCwd, ['rev-parse', 'HEAD'])).trim();
  const root = await mkdtemp(join(tmpdir(), 'usabl-demo-app-'));
  const cwd = join(root, 'app');
  try {
    await git(root, ['clone', '--quiet', '--no-hardlinks', sourceCwd, cwd]);
    await git(cwd, ['checkout', '--quiet', '--detach', head]);
    const cloneHead = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
    if (cloneHead !== head) {
      throw new Error(`clone sits on ${cloneHead}, the demo app sits on ${head}`);
    }
    const enginePath = await linkNodeModules(sourceCwd, cwd);
    const token = randomUUID();
    await mkdir(join(cwd, 'public'), { recursive: true });
    await writeFile(join(cwd, 'public', MARKER_FILE), token, 'utf8');
    return {
      cwd,
      sourceCwd,
      head,
      enginePath,
      token,
      dispose: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/** Timeout budget the engine applies to reaching one screen. */
export function fixtureReadyTimeoutMs(cwd: string): number {
  return parseUsablConfig(readFileSync(join(cwd, 'usabl.config.json'), 'utf8')).readyTimeoutMs ?? 60_000;
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

/** Sorted `screen:rule` pairs. Element paths are left out because they can shift without a real change. */
export function normalizeFindings(findings: Finding[]): string[] {
  return findings.map((finding) => `${finding.screenId}:${finding.rule}`).sort();
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

export async function fetchText(url: string): Promise<{ ok: boolean; status: number; body: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  return { ok: response.ok, status: response.status, body: await response.text() };
}

export function summarizeOutput(chunks: string[]): string {
  const compact = chunks.join('').trim();
  if (compact.length === 0) {
    return 'no fixture server output';
  }
  return compact.slice(-3000);
}

function attachOutputBuffer(server: ReturnType<typeof spawn>): string[] {
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

/**
 * Starts the clone's dev server on a free port and waits until it proves it is
 * ours: it serves the clone's random marker token, and its HTML carries the usabl
 * overlay loader that only this engine's Vite plugin injects. A child that exits
 * before that point fails the wait at once.
 */
export async function startFixtureServer(app: DisposableApp, probePath: string): Promise<FixtureServer> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: app.cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = attachOutputBuffer(child);
  const server: FixtureServer = { process: child, baseUrl, port, output };
  try {
    await waitForServerReady(server, app, probePath);
  } catch (error) {
    await stopFixtureServer(server);
    throw error;
  }
  return server;
}

type ProbeOutcome = { state: 'ready' } | { state: 'retry'; reason: string } | { state: 'wrong'; reason: string };

/** One readiness probe. Connection errors and timeouts are retries; identity mismatches are final. */
async function probeServer(server: FixtureServer, app: DisposableApp, probePath: string): Promise<ProbeOutcome> {
  try {
    const marker = await fetchText(`${server.baseUrl}/${MARKER_FILE}`);
    if (!marker.ok) {
      return { state: 'retry', reason: `marker request returned HTTP ${marker.status}` };
    }
    if (marker.body !== app.token) {
      return {
        state: 'wrong',
        reason: `port ${server.port} is served by a different application; marker body was ${marker.body.slice(0, 80)}`,
      };
    }
    const page = await fetchText(`${server.baseUrl}${probePath}`);
    if (!page.ok) {
      return { state: 'retry', reason: `${probePath} returned HTTP ${page.status}` };
    }
    if (!page.body.includes(OVERLAY_LOADER)) {
      return { state: 'wrong', reason: `${probePath} carries no usabl overlay loader; the usabl Vite plugin did not load` };
    }
    return { state: 'ready' };
  } catch (error) {
    return { state: 'retry', reason: error instanceof Error ? error.message : String(error) };
  }
}

async function waitForServerReady(server: FixtureServer, app: DisposableApp, probePath: string): Promise<void> {
  // Resolves, never rejects, so nothing dangles after the server is stopped later on purpose.
  const exited = new Promise<'exited'>((resolve) => {
    server.process.once('exit', () => resolve('exited'));
  });
  const deadline = Date.now() + 30_000;
  let lastReason = 'request never succeeded';
  while (Date.now() < deadline) {
    const outcome = await Promise.race([probeServer(server, app, probePath), exited]);
    if (outcome === 'exited') {
      throw new Error(
        `fixture dev server exited before ready with code ${server.process.exitCode}: ${summarizeOutput(server.output)}`,
      );
    }
    if (outcome.state === 'ready') {
      return;
    }
    if (outcome.state === 'wrong') {
      throw new Error(outcome.reason);
    }
    lastReason = outcome.reason;
    await Promise.race([delay(200), exited]);
  }
  throw new Error(`fixture dev server did not become ready: ${lastReason}; output: ${summarizeOutput(server.output)}`);
}

export async function stopFixtureServer(server: FixtureServer): Promise<void> {
  const child = server.process;
  if (child.exitCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  const graceful = await Promise.race([once(child, 'exit'), delay(5_000).then(() => null)]);
  if (graceful === null && child.exitCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

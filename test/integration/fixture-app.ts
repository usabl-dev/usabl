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
 * do every break and repair edit in the clone. The real app must have a clean
 * `git status` before and after, and the suites assert it.
 *
 * The dev server runs detached in its own process group and is stopped by
 * signalling that group. If the test runner itself is killed, `afterAll` never
 * runs: the clone stays in the temp dir and its Vite process keeps running until
 * the next run finds the clone's owner process dead and removes both. A clone
 * whose owner is still alive is never touched.
 *
 * Every wait is bounded. Server start and source propagation use the app's
 * `readyTimeoutMs`, the same budget the engine gives to reaching one screen. Git
 * and the demo's switch script have their own timeouts. The clone's dev server
 * loads `usabl/vite` from `node_modules/usabl`, so the engine's built `dist/`
 * must exist. `npm run test:demo-integration` builds first under a lock.
 */
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { accessSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
const CLONE_PREFIX = 'usabl-demo-app-';
const OWNER_FILE = 'owner.json';
const MARKER_FILE = 'usabl-fixture-marker.txt';
const OVERLAY_LOADER = "import('/__usabl/client.js')";
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 2_000;
const GIT_TIMEOUT_MS = 60_000;
const SOURCE_SWITCH_TIMEOUT_MS = 30_000;
const GRACEFUL_STOP_MS = 5_000;
const FORCED_STOP_MS = 5_000;

/**
 * Time budgets for one suite. `readyTimeoutMs` is the engine's budget for reaching
 * one screen. Starting the dev server and re-serving an edited module are the same
 * class of wait, so they share it. Test timeouts add these up per operation.
 */
export interface Budgets {
  readyTimeoutMs: number;
  serverStartMs: number;
  sourceSwitchMs: number;
  gitMs: number;
}

export function budgetsFor(readyTimeoutMs: number): Budgets {
  return { readyTimeoutMs, serverStartMs: readyTimeoutMs, sourceSwitchMs: readyTimeoutMs, gitMs: GIT_TIMEOUT_MS };
}

export type FixtureAppRequest =
  | { kind: 'skip'; note: string }
  | { kind: 'run'; cwd: string };

export interface DisposableApp {
  /** The clone the suite runs against. Every edit happens here. */
  cwd: string;
  /** Temp root holding the clone and its owner file. */
  root: string;
  /** The real checkout the clone came from. Never written to. */
  sourceCwd: string;
  /** Commit both the real checkout and the clone sit on. */
  head: string;
  /** Resolved path of the engine the clone's `node_modules/usabl` points at. */
  enginePath: string;
  /** Random token served from the clone's public directory; proves a server is ours. */
  token: string;
  budgets: Budgets;
  dispose(): Promise<void>;
}

export interface FixtureServer {
  process: ReturnType<typeof spawn>;
  baseUrl: string;
  port: number;
  output: string[];
}

interface OwnerRecord {
  pid: number;
  startedAt: number;
  cwd: string;
  serverPid?: number;
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

/** Runs a child process with a hard deadline and names the command in the failure. */
export async function runBounded(
  label: string,
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, { cwd, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' });
    return stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
    if (failure.killed === true) {
      throw new Error(`${label} did not finish within ${timeoutMs}ms`);
    }
    throw new Error(`${label} failed: ${failure.stderr?.trim() || failure.message}`);
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  return runBounded(`git ${args[0]}`, 'git', args, cwd, GIT_TIMEOUT_MS);
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

/** Timeout budget the engine applies to reaching one screen, read from the app's config. */
export function fixtureReadyTimeoutMs(cwd: string): number {
  return parseUsablConfig(readFileSync(join(cwd, 'usabl.config.json'), 'utf8')).readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else. Treat it as alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readOwner(root: string): Promise<OwnerRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(root, OWNER_FILE), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const pid = Reflect.get(parsed, 'pid');
    const startedAt = Reflect.get(parsed, 'startedAt');
    const cwd = Reflect.get(parsed, 'cwd');
    const serverPid = Reflect.get(parsed, 'serverPid');
    if (typeof pid !== 'number' || typeof startedAt !== 'number' || typeof cwd !== 'string') {
      return null;
    }
    return { pid, startedAt, cwd, ...(typeof serverPid === 'number' ? { serverPid } : {}) };
  } catch {
    return null;
  }
}

/**
 * Kills the dev server group a dead run left behind, but only when the group
 * leader's command line still names that run's clone. A reused pid never matches.
 */
async function killOrphanedServer(owner: OwnerRecord): Promise<void> {
  if (owner.serverPid === undefined || !processAlive(owner.serverPid)) {
    return;
  }
  let cmdline: string;
  try {
    cmdline = await readFile(`/proc/${owner.serverPid}/cmdline`, 'utf8');
  } catch {
    return;
  }
  if (!cmdline.includes(owner.cwd)) {
    return;
  }
  killGroup(owner.serverPid, 'SIGKILL');
}

/**
 * Removes clones from earlier runs whose owner process is gone. A clone is only
 * removed when it is older than this process and no live process owns it, so a
 * concurrent run's clone is never touched.
 */
export async function removeStaleClones(): Promise<string[]> {
  const processStartedAt = Date.now() - process.uptime() * 1000;
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(tmpdir());
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.startsWith(CLONE_PREFIX)) {
      continue;
    }
    const root = join(tmpdir(), entry);
    try {
      const info = await stat(root);
      if (!info.isDirectory() || info.mtimeMs >= processStartedAt) {
        continue;
      }
      const owner = await readOwner(root);
      if (owner !== null && processAlive(owner.pid)) {
        continue;
      }
      if (owner !== null) {
        await killOrphanedServer(owner);
      }
      await rm(root, { recursive: true, force: true });
      removed.push(root);
    } catch {
      // Another run may have removed it first. Nothing to do.
    }
  }
  return removed;
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

async function writeOwner(root: string, record: OwnerRecord): Promise<void> {
  await writeFile(join(root, OWNER_FILE), JSON.stringify(record), 'utf8');
}

/**
 * Clones the real demo app at HEAD into a temporary directory and wires its
 * `node_modules` to the real packages plus this engine. Every suite edit happens in
 * the clone. `dispose()` removes the whole temporary directory.
 */
export async function createDisposableApp(sourceCwd: string): Promise<DisposableApp> {
  await assertRealAppClean(sourceCwd, 'before the suite started');
  for (const stale of await removeStaleClones()) {
    console.info(`[fixture app] removed stale clone ${stale} left by an earlier run`);
  }
  const budgets = budgetsFor(fixtureReadyTimeoutMs(sourceCwd));
  const head = (await git(sourceCwd, ['rev-parse', 'HEAD'])).trim();
  const root = await mkdtemp(join(tmpdir(), CLONE_PREFIX));
  const cwd = join(root, 'app');
  try {
    await writeOwner(root, { pid: process.pid, startedAt: Date.now(), cwd });
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
      root,
      sourceCwd,
      head,
      enginePath,
      token,
      budgets,
      dispose: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/** Runs the demo app's own source switch script inside the clone. */
export async function switchDemoSource(app: DisposableApp, script: string, mode: string): Promise<void> {
  await runBounded(`${script} ${mode}`, 'node', [script, mode], app.cwd, SOURCE_SWITCH_TIMEOUT_MS);
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
 * Starts the clone's dev server on a free port, in its own process group, and
 * waits until it proves it is ours: it serves the clone's random marker token, and
 * its HTML carries the usabl overlay loader that only this engine's Vite plugin
 * injects. A child that exits before that point fails the wait at once.
 */
export async function startFixtureServer(app: DisposableApp, probePath: string): Promise<FixtureServer> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: app.cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group, so stopping the server also stops the Vite grandchild npm starts.
    detached: true,
  });
  const output = attachOutputBuffer(child);
  const server: FixtureServer = { process: child, baseUrl, port, output };
  if (child.pid !== undefined) {
    await writeOwner(app.root, { pid: process.pid, startedAt: Date.now(), cwd: app.cwd, serverPid: child.pid });
  }
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
  const deadline = Date.now() + app.budgets.serverStartMs;
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
  throw new Error(
    `fixture dev server did not become ready within ${app.budgets.serverStartMs}ms: ${lastReason}; output: ${summarizeOutput(server.output)}`,
  );
}

/** Signals a whole process group. A group that is already gone is not an error. */
function killGroup(leaderPid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-leaderPid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}

async function exitedWithin(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  const outcome = await Promise.race([once(child, 'exit').then(() => 'exited' as const), delay(timeoutMs)]);
  return outcome === 'exited';
}

/**
 * Stops the dev server and everything npm started under it by signalling the
 * process group: SIGTERM first, SIGKILL after a grace period. Both waits are
 * bounded; a group that survives SIGKILL is reported, not waited on forever.
 */
export async function stopFixtureServer(server: FixtureServer): Promise<void> {
  const child = server.process;
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  killGroup(child.pid, 'SIGTERM');
  if (await exitedWithin(child, GRACEFUL_STOP_MS)) {
    return;
  }
  killGroup(child.pid, 'SIGKILL');
  if (!(await exitedWithin(child, FORCED_STOP_MS))) {
    throw new Error(`fixture dev server group ${child.pid} did not exit within ${FORCED_STOP_MS}ms of SIGKILL`);
  }
}

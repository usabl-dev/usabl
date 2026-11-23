/**
 * Stop time, measured. A Stop hook the assistant times out is not a block: the assistant ends the
 * hook and the stop goes on. So the time a stop takes is measured here, beside the hook's budget.
 *
 * What it does, for each N given (1, 5, and 20 by default):
 * 1. Clones the usabl demo app into a temporary folder (the same disposable clone the demo
 *    integration suites use) and starts its dev server on a free port.
 * 2. Commits the demo config, pointed at that server, as the trusted branch, and records it as
 *    origin/main through refs/remotes/origin/HEAD, as a clone does.
 * 3. Makes a branch that changes the files of N screens, one commit per screen.
 * 4. Runs the generated Claude Code Stop hook command twice in the clone, with "{}" on stdin:
 *    a cold stop with no stored receipt, then a warm stop that can use the receipt the cold stop
 *    saved. It reports the wall time of each, how each stop ended, and whether it fits the budget.
 *
 * It decides nothing and tunes nothing. It is not part of npm run check, and it needs a real
 * browser and the demo app, so run it on a quiet machine, one run at a time:
 *
 *    npm run build
 *    flock -w 3000 /path/to/browser.lock env USABL_FIXTURE_APP_CWD=/path/to/usabl-app \
 *      npm run measure:stop-time -- 1 5 20
 *
 * The hook runs from this repository's dist folder through the clone's node_modules, so build
 * first. The budgets are the timeouts usabl install writes: the Claude Code hook's `timeout`, which
 * its command also passes to the runner, and the Cursor hook's `timeout`. The runner ends each stop
 * by its own deadline, 30 seconds short of the budget, so a stop past that deadline blocks with
 * "usabl ran out of time" instead of being ended by the assistant. The command run here is the
 * Claude Code one, so the Claude Code deadline is the one that applies.
 *
 * A signal while the fixture server is still starting stops that server once its start ends, and
 * a signal while a stop runs stops the stop's whole process group (see stop-time-cleanup.ts).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { STOP_HOOK_COMMAND } from '../src/install/claude.js';
import { buildCursorHooksJson } from '../src/install/cursor.js';
import { CLAUDE_STOP_TIMEOUT_SECONDS, runnerDeadlineSeconds } from '../src/surfaces/stop-hook-deadline.js';
import { stopTimeCleanup, type StopTimeCleanup } from './stop-time-cleanup.js';
import {
  assertDemoApp,
  createDisposableApp,
  engineRoot,
  FIXTURE_APP_ENV,
  loadFixtureConfig,
  runBounded,
  startFixtureServer,
  stopFixtureServer,
  type DisposableApp,
  type FixtureServer,
} from '../test/integration/fixture-app.js';

// No stop is let run past this, so a hung stop ends the script. It is above every budget.
const STOP_CEILING_MS = 15 * 60_000;
const GIT_MS = 60_000;
const DEFAULT_COUNTS = [1, 5, 20];

function cursorTimeoutSeconds(): number {
  const parsed = JSON.parse(buildCursorHooksJson(null)) as { hooks: { stop: Array<{ timeout: number }> } };
  return parsed.hooks.stop[0]?.timeout ?? 0;
}

function counts(argv: string[]): number[] {
  // npm and vite-node may pass the "--" that separates script arguments through.
  const values = argv.filter((value) => value !== '--');
  if (values.length === 0) return DEFAULT_COUNTS;
  return values.map((value) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`each argument is a screen count, a whole number from 1 up; got ${JSON.stringify(value)}`);
    }
    return n;
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  return runBounded(`git ${args[0] ?? ''}`, 'git', ['-c', 'user.name=usabl stop time', '-c', 'user.email=stop-time@example.invalid', ...args], cwd, GIT_MS);
}

interface StopRun {
  ms: number;
  exitCode: number | null;
  // The first line the hook wrote: the decision line, or the block reason's first line.
  firstLine: string;
  blocked: boolean;
}

/**
 * Runs the generated Stop hook command the way Claude Code does: sh -c, JSON on stdin. The hook
 * runs in a process group of its own, so the ceiling and the cleanup stop sh, npm, and usabl
 * together.
 */
async function runStop(cwd: string, cleanup: StopTimeCleanup<FixtureServer>): Promise<StopRun> {
  // After a signal, the run starts no new stop.
  cleanup.assertRunning();
  const started = performance.now();
  const child = spawn('sh', ['-c', STOP_HOOK_COMMAND], {
    cwd,
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child.pid !== undefined) {
      process.kill(-child.pid, signal);
    }
  };
  const exited = cleanup.trackStop(() => signalGroup('SIGTERM'));
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
  child.stdin.end('{}');
  const ceiling = setTimeout(() => {
    try {
      signalGroup('SIGKILL');
    } catch {
      // The group is already gone.
    }
  }, STOP_CEILING_MS);
  const exitCode = await new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  clearTimeout(ceiling);
  exited();
  const ms = performance.now() - started;
  const out = stdout.join('');
  let blocked = false;
  let reason = '';
  for (const line of out.split('\n')) {
    try {
      const payload = JSON.parse(line) as { decision?: string; reason?: string };
      if (payload.decision === 'block') {
        blocked = true;
        reason = payload.reason ?? '';
      }
    } catch {
      // Not a JSON line.
    }
  }
  const text = blocked ? reason : stderr.join('');
  return { ms, exitCode, firstLine: (text.split('\n')[0] ?? '').slice(0, 160), blocked };
}

/** The demo screens that name their own files, in config order, up to `n`. */
function screensToChange(app: DisposableApp, baseUrl: string, n: number): Array<{ id: string; file: string }> {
  const config = loadFixtureConfig(app.cwd, baseUrl);
  const screens: Array<{ id: string; file: string }> = [];
  for (const surface of config.surfaces) {
    const file = surface.files[0];
    if (file !== undefined && screens.every((screen) => screen.file !== file)) {
      screens.push({ id: surface.id, file });
    }
  }
  return screens.slice(0, n);
}

async function measure(
  app: DisposableApp,
  server: FixtureServer,
  n: number,
  trusted: string,
  cleanup: StopTimeCleanup<FixtureServer>,
): Promise<string> {
  const branch = `stop-time-${n}`;
  cleanup.assertRunning();
  await git(app.cwd, ['switch', '--quiet', '--force', '-c', branch, trusted]);
  const screens = screensToChange(app, server.baseUrl, n);
  for (const screen of screens) {
    await appendFile(join(app.cwd, screen.file), `\n// stop time measurement ${n}\n`);
    await git(app.cwd, ['commit', '--quiet', '-am', `change ${screen.id}`]);
  }
  // A cold stop has no stored receipt to use.
  await rm(join(app.cwd, '.usabl', 'receipt.json'), { force: true });
  const cold = await runStop(app.cwd, cleanup);
  const warm = await runStop(app.cwd, cleanup);
  const changed = screens.length === n ? `${n}` : `${screens.length} (the demo names only ${screens.length} screens with files)`;
  const claude = runnerDeadlineSeconds(CLAUDE_STOP_TIMEOUT_SECONDS);
  const cursor = runnerDeadlineSeconds(cursorTimeoutSeconds());
  return [
    `screens changed: ${changed}`,
    `  cold stop: ${(cold.ms / 1000).toFixed(1)} s, exit ${String(cold.exitCode)}, ${cold.blocked ? 'blocked' : 'allowed'}: ${cold.firstLine}`,
    `  warm stop: ${(warm.ms / 1000).toFixed(1)} s, exit ${String(warm.exitCode)}, ${warm.blocked ? 'blocked' : 'allowed'}: ${warm.firstLine}`,
    `  under usabl's Claude Code deadline of ${claude} s: cold ${fits(cold.ms, claude)}, warm ${fits(warm.ms, claude)}`,
    `  under usabl's Cursor deadline of ${cursor} s: cold ${fits(cold.ms, cursor)}, warm ${fits(warm.ms, cursor)}`,
  ].join('\n');
}

function fits(ms: number, seconds: number): string {
  return ms < seconds * 1000 ? 'yes' : 'NO';
}

async function main(argv: string[]): Promise<number> {
  const source = process.env[FIXTURE_APP_ENV];
  if (source === undefined || source.trim().length === 0) {
    process.stderr.write(`${FIXTURE_APP_ENV} is unset. Set it to a checkout of the usabl demo app.\n`);
    return 2;
  }
  assertDemoApp(source);
  if (!existsSync(join(engineRoot(), 'dist', 'cli.js'))) {
    process.stderr.write('dist/cli.js is missing. Run npm run build first.\n');
    return 2;
  }
  const requested = counts(argv);
  const app = await createDisposableApp(source);
  // A signal skips the finally below, so it stops what is running and removes the clone first.
  const cleanup = stopTimeCleanup<FixtureServer>({
    stopServer: (server) => stopFixtureServer(server),
    dispose: () => app.dispose(),
  });
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    process.once(signal, () => {
      void cleanup.run().finally(() => process.exit(code));
    });
  }
  try {
    const server = await cleanup.startServer(() => startFixtureServer(app, '/'));
    // A signal during the start: the cleanup stops this server, so the run goes no further.
    cleanup.assertRunning();
    // The trusted branch: the demo as it ships, with its config pointed at this server.
    const config = loadFixtureConfig(app.cwd, server.baseUrl);
    const shipped = JSON.parse(await readFile(join(app.cwd, 'usabl.config.json'), 'utf8')) as Record<string, unknown>;
    await writeFile(
      join(app.cwd, 'usabl.config.json'),
      JSON.stringify({ ...shipped, appBaseUrl: config.appBaseUrl, surfaces: config.surfaces }, null, 2) + '\n',
    );
    await writeFile(join(app.cwd, '.git', 'info', 'exclude'), '.usabl/\n', { flag: 'a' });
    await git(app.cwd, ['switch', '--quiet', '-c', 'stop-time-trusted']);
    await git(app.cwd, ['commit', '--quiet', '-am', 'point the demo at the measurement server']);
    const trusted = (await git(app.cwd, ['rev-parse', 'HEAD'])).trim();
    await git(app.cwd, ['update-ref', 'refs/remotes/origin/main', trusted]);
    await git(app.cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);

    process.stdout.write(
      `Stop time on the usabl demo app at ${server.baseUrl}. Budgets: Claude Code ${CLAUDE_STOP_TIMEOUT_SECONDS} s ` +
        `(the timeout usabl install --claude writes), Cursor ${cursorTimeoutSeconds()} s. ` +
        'usabl ends each stop by its own deadline, 30 seconds short of the budget.\n',
    );
    for (const n of requested) {
      process.stdout.write(`${await measure(app, server, n, trusted, cleanup)}\n`);
    }
    return 0;
  } finally {
    await cleanup.run();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);

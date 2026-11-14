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
 * first. The budgets: a Claude Code command hook with no timeout field gets Claude Code's default
 * (usabl install --claude writes none), and Cursor gets the timeout usabl install --cursor writes.
 * The Claude Code default is set below from its hooks documentation. Check it against the Claude
 * Code version in use before reading the result.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { STOP_HOOK_COMMAND } from '../src/install/claude.js';
import { buildCursorHooksJson } from '../src/install/cursor.js';
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

// Claude Code's documented default for a command hook with no timeout field, in seconds.
const CLAUDE_DEFAULT_HOOK_TIMEOUT_S = 60;
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

/** Runs the generated Stop hook command the way Claude Code does: sh -c, JSON on stdin. */
async function runStop(cwd: string): Promise<StopRun> {
  const started = performance.now();
  const child = spawn('sh', ['-c', STOP_HOOK_COMMAND], {
    cwd,
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
  child.stdin.end('{}');
  const ceiling = setTimeout(() => child.kill('SIGKILL'), STOP_CEILING_MS);
  const exitCode = await new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  clearTimeout(ceiling);
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

async function measure(app: DisposableApp, server: FixtureServer, n: number, trusted: string): Promise<string> {
  const branch = `stop-time-${n}`;
  await git(app.cwd, ['switch', '--quiet', '--force', '-c', branch, trusted]);
  const screens = screensToChange(app, server.baseUrl, n);
  for (const screen of screens) {
    await appendFile(join(app.cwd, screen.file), `\n// stop time measurement ${n}\n`);
    await git(app.cwd, ['commit', '--quiet', '-am', `change ${screen.id}`]);
  }
  // A cold stop has no stored receipt to use.
  await rm(join(app.cwd, '.usabl', 'receipt.json'), { force: true });
  const cold = await runStop(app.cwd);
  const warm = await runStop(app.cwd);
  const changed = screens.length === n ? `${n}` : `${screens.length} (the demo names only ${screens.length} screens with files)`;
  return [
    `screens changed: ${changed}`,
    `  cold stop: ${(cold.ms / 1000).toFixed(1)} s, exit ${String(cold.exitCode)}, ${cold.blocked ? 'blocked' : 'allowed'}: ${cold.firstLine}`,
    `  warm stop: ${(warm.ms / 1000).toFixed(1)} s, exit ${String(warm.exitCode)}, ${warm.blocked ? 'blocked' : 'allowed'}: ${warm.firstLine}`,
    `  fits Claude Code ${CLAUDE_DEFAULT_HOOK_TIMEOUT_S} s: cold ${fits(cold.ms, CLAUDE_DEFAULT_HOOK_TIMEOUT_S)}, warm ${fits(warm.ms, CLAUDE_DEFAULT_HOOK_TIMEOUT_S)}`,
    `  fits Cursor ${cursorTimeoutSeconds()} s: cold ${fits(cold.ms, cursorTimeoutSeconds())}, warm ${fits(warm.ms, cursorTimeoutSeconds())}`,
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
  let server: FixtureServer | null = null;
  try {
    server = await startFixtureServer(app, '/');
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
      `Stop time on the usabl demo app at ${server.baseUrl}. Budgets: Claude Code ${CLAUDE_DEFAULT_HOOK_TIMEOUT_S} s ` +
        `(its default, since usabl writes no timeout), Cursor ${cursorTimeoutSeconds()} s.\n`,
    );
    for (const n of requested) {
      process.stdout.write(`${await measure(app, server, n, trusted)}\n`);
    }
    return 0;
  } finally {
    if (server !== null) {
      await stopFixtureServer(server);
    }
    await app.dispose();
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

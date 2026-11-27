/**
 * Runs the real stop-hook command in a child process, as the host runs it, from a bundle built
 * from src with the package's own build tool, on a real git repository.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// The source the bundle is built from. Another folder holds another revision of the package, so the
// same cases can be run against it.
export const SOURCE_ROOT = process.env['USABL_HARD_DEADLINE_SOURCE'] ?? ROOT;

// The hook's limit, as usabl install writes it, so usabl's own deadline is 15 seconds.
export const HOST_LIMIT_SECONDS = 30;
export const DEADLINE_MS = 15_000;
// How long a case waits before it ends a stop that has not ended: past the host's limit.
export const GIVE_UP_MS = 40_000;

export const BASE_CONFIG = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'src/routes.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'home', url: 'http://127.0.0.1:5173/', files: ['src/App.tsx'] }],
  guardedPaths: [],
};

/** A folder for bundles and repositories, with the repository's node_modules beside them. */
export async function makeWork(prefix: string): Promise<string> {
  const work = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  // The bundle loads its dependencies by name, so it needs the repository's node_modules beside it.
  await symlink(join(ROOT, 'node_modules'), join(work, 'node_modules'), 'dir');
  return work;
}

export async function removeWork(work: string): Promise<void> {
  if (work.length > 0) await rm(work, { recursive: true, force: true });
}

/**
 * Builds the CLI into `<work>/<name>/dist`, laid out as the package is: dist/ beside the
 * package.json the engine reads. `workerEntry` replaces the stop hook's own worker when given.
 */
export async function bundle(work: string, name: string, workerEntry: string | null = null): Promise<string> {
  const dist = join(work, name, 'dist');
  await mkdir(dist, { recursive: true });
  await copyFile(join(SOURCE_ROOT, 'package.json'), join(dist, '..', 'package.json'));
  const { build } = await import('tsup');
  const entry: Record<string, string> = { cli: join(SOURCE_ROOT, 'src/cli-bin.ts') };
  const ownWorker = join(SOURCE_ROOT, 'src/surfaces/stop-hook-worker.ts');
  if (workerEntry !== null) entry['stop-hook-worker'] = workerEntry;
  else if (existsSync(ownWorker)) entry['stop-hook-worker'] = ownWorker;
  await build({
    entry,
    outDir: dist,
    format: ['esm'],
    target: 'node22',
    dts: false,
    clean: false,
    silent: true,
    config: false,
    splitting: true,
  });
  return dist;
}

export function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=usabl test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

export async function write(repo: string, path: string, text: string): Promise<void> {
  await mkdir(join(repo, path, '..'), { recursive: true });
  await writeFile(join(repo, path), text);
}

/**
 * A repository whose main branch holds the config and `base`, and a feature branch that commits
 * `change` on top. origin/main and origin/HEAD name the main branch, so the stop checks the branch.
 */
export async function repository(
  work: string,
  name: string,
  base: Record<string, string>,
  change: Record<string, string>,
  config: object = BASE_CONFIG,
): Promise<string> {
  const repo = join(work, 'repos', name);
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  await write(repo, '.gitignore', '.usabl/\n');
  await write(repo, 'usabl.config.json', JSON.stringify(config, null, 2) + '\n');
  await write(repo, 'src/App.tsx', 'export const App = 1;\n');
  const entries = Object.entries(base);
  for (let start = 0; start < entries.length; start += 500) {
    await Promise.all(entries.slice(start, start + 500).map(([path, text]) => write(repo, path, text)));
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'main');
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git(repo, 'switch', '-q', '-c', 'feature');
  for (const [path, text] of Object.entries(change)) await write(repo, path, text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'change');
  return repo;
}

export interface StopRun {
  // When the first answer line reached stdout, from the start of the process, or null.
  answerMs: number | null;
  // When the process ended, or null when the case ended it after GIVE_UP_MS.
  exitMs: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the stop-hook command as the host runs it, with the hook's limit set as usabl install sets it. */
export function stop(
  dist: string,
  repo: string,
  options: { env?: Record<string, string | undefined>; sessionId?: string } = {},
): Promise<StopRun> {
  // A variable set to undefined in `options.env` is left out of the child's environment.
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries({
    ...process.env,
    USABL_STOP_HOOK_TIMEOUT: String(HOST_LIMIT_SECONDS),
    CLAUDE_PROJECT_DIR: repo,
    ...options.env,
  })) {
    if (value !== undefined) env[name] = value;
  }
  return new Promise((resolveRun) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(dist, 'cli.js'), 'stop-hook'], {
      cwd: repo,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let answerMs: number | null = null;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (answerMs === null && stdout.includes('\n')) answerMs = Date.now() - started;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const giveUp = setTimeout(() => child.kill('SIGKILL'), GIVE_UP_MS);
    child.on('exit', (_code, signal) => {
      clearTimeout(giveUp);
      resolveRun({ answerMs, exitMs: signal === 'SIGKILL' ? null : Date.now() - started, stdout, stderr });
    });
    child.stdin.end(JSON.stringify({ session_id: options.sessionId ?? 'hard-deadline', stop_hook_active: false }));
  });
}

export function answerOf(run: StopRun): Record<string, unknown> | null {
  const line = run.stdout.split('\n').find((text) => text.trim().length > 0);
  return line === undefined ? null : (JSON.parse(line) as Record<string, unknown>);
}

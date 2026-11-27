/**
 * The Stop hook's deadline holds even while the checks hold their own thread. A timer can fire only
 * between pieces of work in its thread, and an agent can write input that makes one piece of the
 * checks run for minutes: one long line that a slow pattern reads, or many files against many
 * imports that the test file placement compares. A hook the host ends at its limit gives no
 * answer, and the stop goes on with nothing checked. So the stop-hook command runs the checks in a
 * worker thread, and its own thread keeps the deadline.
 *
 * Each case runs the real stop-hook command in a child process, as the host runs it, from a bundle
 * built from src with the package's own build tool, on a real git repository. The hook's limit is
 * 30 seconds, so usabl's own deadline is 15 seconds. The answer must reach the host, and the
 * process must end, before the 30 seconds pass.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// The source the bundle is built from. Another folder holds another revision of the package, so the
// same cases can be run against it.
const SOURCE_ROOT = process.env['USABL_HARD_DEADLINE_SOURCE'] ?? ROOT;

const HOST_LIMIT_SECONDS = 30;
const DEADLINE_MS = 15_000;
// How long the case waits before it ends a stop that has not answered: past the host's limit.
const GIVE_UP_MS = 40_000;
// What the answer may take past usabl's deadline: the timer firing and the answer being written.
const ANSWER_SLACK_MS = 3_000;

const config = {
  appBaseUrl: 'http://127.0.0.1:5173',
  uiFileGlobs: ['src/**'],
  discovery: { routerFile: 'src/routes.tsx', wideBlastGlobs: [] },
  surfaces: [{ id: 'home', url: 'http://127.0.0.1:5173/', files: ['src/App.tsx'] }],
  guardedPaths: [],
};

let work = '';
let realDist = '';
let heldDist = '';
let endingDist = '';

async function bundle(outDir: string, workerEntry: string | null): Promise<void> {
  const { build } = await import('tsup');
  const entry: Record<string, string> = { cli: join(SOURCE_ROOT, 'src/cli-bin.ts') };
  const ownWorker = join(SOURCE_ROOT, 'src/surfaces/stop-hook-worker.ts');
  if (workerEntry !== null) entry['stop-hook-worker'] = workerEntry;
  else if (existsSync(ownWorker)) entry['stop-hook-worker'] = ownWorker;
  await build({
    entry,
    outDir,
    format: ['esm'],
    target: 'node22',
    dts: false,
    clean: false,
    silent: true,
    config: false,
    splitting: true,
  });
}

beforeAll(async () => {
  work = await realpath(await mkdtemp(join(tmpdir(), 'usabl-hard-deadline-')));
  // The bundle loads its dependencies by name, so it needs the repository's node_modules beside it.
  await symlink(join(ROOT, 'node_modules'), join(work, 'node_modules'), 'dir');
  // Each bundle is laid out as the package is: dist/ beside the package.json the engine reads.
  realDist = join(work, 'real', 'dist');
  heldDist = join(work, 'held', 'dist');
  endingDist = join(work, 'ending', 'dist');
  for (const dist of [realDist, heldDist, endingDist]) {
    await mkdir(dist, { recursive: true });
    await copyFile(join(SOURCE_ROOT, 'package.json'), join(dist, '..', 'package.json'));
  }
  await bundle(realDist, null);
  await bundle(heldDist, join(ROOT, 'test/support/held-stop-hook-worker.ts'));
  await bundle(endingDist, join(ROOT, 'test/support/ending-stop-hook-worker.ts'));
}, 120_000);

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=usabl test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

async function write(repo: string, path: string, text: string): Promise<void> {
  await mkdir(join(repo, path, '..'), { recursive: true });
  await writeFile(join(repo, path), text);
}

/**
 * A repository whose main branch holds the config and `base`, and a feature branch that commits
 * `change` on top. origin/main and origin/HEAD name the main branch, so the stop checks the branch.
 */
async function repository(name: string, base: Record<string, string>, change: Record<string, string>): Promise<string> {
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

interface StopRun {
  // When the first answer line reached stdout, from the start of the process, or null.
  answerMs: number | null;
  // When the process ended, or null when the case ended it after GIVE_UP_MS.
  exitMs: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the stop-hook command as the host runs it, with the hook's limit set as usabl install sets it. */
function stop(dist: string, repo: string): Promise<StopRun> {
  return new Promise((resolveRun) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(dist, 'cli.js'), 'stop-hook'], {
      cwd: repo,
      env: { ...process.env, USABL_STOP_HOOK_TIMEOUT: String(HOST_LIMIT_SECONDS), CLAUDE_PROJECT_DIR: repo },
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
    child.on('exit', (code, signal) => {
      clearTimeout(giveUp);
      resolveRun({ answerMs, exitMs: signal === 'SIGKILL' ? null : Date.now() - started, stdout, stderr });
    });
    child.stdin.end(JSON.stringify({ session_id: 'hard-deadline', stop_hook_active: false }));
  });
}

function answerOf(run: StopRun): Record<string, unknown> | null {
  const line = run.stdout.split('\n').find((text) => text.trim().length > 0);
  return line === undefined ? null : (JSON.parse(line) as Record<string, unknown>);
}

// What every stop here must do, whatever it found: answer by usabl's deadline and a small margin,
// end before the host's limit, write one answer at most, and never say VERIFIED or save a receipt.
// An allow with nothing to show writes no stdout line, so its answer is the end of the process.
function expectAnsweredInTime(run: StopRun, repo: string): void {
  expect(run.exitMs, `the stop gave no answer before ${GIVE_UP_MS} ms; stderr: ${run.stderr.slice(0, 400)}`).not.toBeNull();
  expect(run.answerMs ?? run.exitMs!).toBeLessThan(DEADLINE_MS + ANSWER_SLACK_MS);
  expect(run.exitMs!).toBeLessThan(HOST_LIMIT_SECONDS * 1000);
  expect(run.stdout.split('\n').filter((line) => line.trim().length > 0).length).toBeLessThanOrEqual(1);
  expect(run.stdout + run.stderr).not.toContain('VERIFIED');
  expect(existsSync(join(repo, '.usabl', 'receipt.json'))).toBe(false);
}

describe('the Stop hook deadline while the checks hold their thread', () => {
  it('blocks with the out-of-time message at the deadline when the checks never yield', async () => {
    const repo = await repository('held', {}, { 'src/App.tsx': 'export const App = 2;\n' });

    const run = await stop(heldDist, repo);

    expectAnsweredInTime(run, repo);
    expect(run.answerMs).not.toBeNull();
    expect(run.answerMs!).toBeGreaterThanOrEqual(DEADLINE_MS - 1_000);
    expect(run.answerMs!).toBeLessThan(DEADLINE_MS + ANSWER_SLACK_MS);
    const answer = answerOf(run);
    expect(answer?.['decision']).toBe('block');
    expect(String(answer?.['reason'])).toMatch(/^NOT verified - usabl ran out of time: .* 15 seconds/u);
    expect(String(answer?.['reason'])).toContain('Nothing is proven about this change, and no receipt was saved.');
  }, 60_000);

  it('gives the stop hook error answer, without blocking, when the worker ends before it answers', async () => {
    const repo = await repository('ending', {}, { 'src/App.tsx': 'export const App = 2;\n' });

    const run = await stop(endingDist, repo);

    expectAnsweredInTime(run, repo);
    const message = String(answerOf(run)?.['systemMessage']);
    expect(message).toMatch(/^NOT verified - stop hook error: /u);
    expect(message).toContain('ended with exit code 3 before it answered');
    expect(answerOf(run)?.['decision']).toBeUndefined();
  }, 60_000);

  it('answers in time when one changed file has a line that a slow pattern would read for minutes', async () => {
    // One import statement with 150,000 spaces in it: valid JavaScript, read by the import reader.
    const line = `import${' '.repeat(150_000)}'./styles.css';\n`;
    const repo = await repository('long-line', {}, { 'src/Long.tsx': line });

    const run = await stop(realDist, repo);

    expectAnsweredInTime(run, repo);
    // The check finishes in time and blocks on the file it could not place, or the deadline
    // blocks first. Either is a block that says the change is not verified.
    const answer = answerOf(run);
    expect(answer?.['decision']).toBe('block');
    expect(String(answer?.['reason'])).toMatch(/^(NOT COVERED \(exit 3\): )?NOT verified/u);
  }, 60_000);

  it('answers in time when placement would compare 20,000 test files with 4,000 unresolved imports', async () => {
    const base: Record<string, string> = {};
    for (let index = 0; index < 20_000; index += 1) {
      base[`src/__tests__/f${String(index).padStart(5, '0')}.test.ts`] = 'export const t = 1;\n';
    }
    const imports = Array.from({ length: 4_000 }, (_, index) => `import k${index} from '#k${index}';`).join('\n');
    base['src/App.tsx'] = `${imports}\nexport const App = 1;\n`;
    const repo = await repository('placement', base, { 'src/__tests__/f00007.test.ts': 'export const t = 2;\n' });

    const run = await stop(realDist, repo);

    expectAnsweredInTime(run, repo);
    expect(run.stdout + run.stderr).toMatch(/NOT verified|NO VERDICT/u);
  }, 120_000);
});

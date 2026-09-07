/**
 * Builds the engine and runs the demo app integration suites under one lock.
 *
 * The suites load `usabl/vite` from this repository's `dist/`, and the build
 * cleans `dist/` first. Two overlapping runs in the same checkout could therefore
 * empty `dist/` under each other and fail for no real reason. This script holds an
 * exclusive lock file for the whole build-and-run and records the process group of
 * the step it is running. A second run fails fast (exit 3) and names the holder. A
 * lock left by a dead run is replaced only once that run's step group is gone too.
 *
 * Each step runs detached in its own process group. On SIGINT, SIGTERM, SIGHUP, or
 * a step timeout, the whole group is signalled (SIGTERM, then SIGKILL) and awaited,
 * the clones that group left under the temp directory are removed (bounded), and
 * only then is the lock released. This script is the only signal listener for
 * those signals: the Vite server that vite-node hosts in this process installs its
 * own SIGTERM listener, which exits the process as soon as that server has closed.
 * Listeners installed before this script's are taken off the signal and replayed,
 * in order and with the signal's arguments, after the step is stopped and the lock
 * released, so their cleanup still runs; the exit code stays this script's. Should
 * the process still exit early by some other path, a synchronous `exit` handler
 * kills the running step group, leaves the lock for the next run to reclaim, and
 * sets exit code 1 so an interrupted run never reports success.
 *
 * Known limits:
 * - A SIGKILL of this script cannot stop its step; the lock keeps the next run
 *   out until that step group ends on its own, and nobody kills it. A step process
 *   stuck in an uninterruptible kernel wait outlives SIGKILL.
 * - The lock has one three-way race: a third run that creates a lock while a
 *   second is moving a displaced live lock back leaves two runs believing they
 *   hold it. See demo-integration-lock.ts.
 * - The 30-minute ceiling on the Vitest step assumes Vitest runs the two suites in
 *   parallel. Their worst-case envelopes are 1,350 s (hero-bug-flip) and 720 s
 *   (fixture-clean) with the app's default 60 s readiness budget: 1,350 s in
 *   parallel, 2,070 s in sequence. A serial run (for example one forced through
 *   forwarded Vitest arguments) must raise the ceiling or run one suite at a time.
 *
 * Usage: USABL_FIXTURE_APP_CWD=/path/to/usabl-app npm run test:demo-integration
 * Extra arguments are passed to Vitest (for example one test file path).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeClonesOfStoppedRun } from '../test/integration/fixture-app.js';
import { acquireLock, releaseLock, updateLock, type LockDeps } from './demo-integration-lock.js';
import { exitFallback, ownSignals } from './demo-integration-signals.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const lockPath = join(repoRoot, '.demo-integration.lock');
const BUILD_TIMEOUT_MS = 5 * 60_000;
// The suites bound their own waits; this is only a ceiling for a hung runner, and
// it assumes the two suites run in parallel (see the header).
const TEST_TIMEOUT_MS = 30 * 60_000;
const GRACE_MS = 5_000;
// Removing a stopped run's clones may wait for each clone's server group; two clones
// with the helper's own limits fit well inside this.
const CLONE_CLEANUP_MS = 20_000;
const SIGNAL_EXIT_CODE = 130;
const POLL_MS = 100;

function signalAlive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const lockDeps: LockDeps = {
  pid: process.pid,
  nonce: randomUUID(),
  now: Date.now,
  processAlive: (pid) => signalAlive(pid),
  groupAlive: (pgid) => signalAlive(-pgid),
};

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitGroupGone(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!signalAlive(-pgid)) {
      return true;
    }
    await sleep(POLL_MS);
  }
  return !signalAlive(-pgid);
}

/** SIGTERM the group, then SIGKILL it, and wait until every member is gone. */
async function stopGroup(pgid: number): Promise<void> {
  signalGroup(pgid, 'SIGTERM');
  if (await waitGroupGone(pgid, GRACE_MS)) {
    return;
  }
  signalGroup(pgid, 'SIGKILL');
  if (!(await waitGroupGone(pgid, GRACE_MS))) {
    process.stderr.write(`process group ${pgid} survived SIGKILL; it is left running\n`);
  }
}

/**
 * Removes the clones a stopped Vitest group left behind. Called only once that
 * group is confirmed gone, so every clone owner pid it recorded is dead.
 */
async function removeClonesLeftByStoppedStep(): Promise<void> {
  const { removed, timedOut } = await removeClonesOfStoppedRun({
    timeoutMs: CLONE_CLEANUP_MS,
    log: (line) => process.stderr.write(`${line}\n`),
    onRemoved: (root) => process.stderr.write(`removed clone ${root} left by the stopped step\n`),
  });
  if (timedOut) {
    process.stderr.write(
      `clone cleanup did not finish within ${CLONE_CLEANUP_MS}ms; ${removed.length} removed, the rest is left for the next run\n`,
    );
  }
}

let currentStep: ChildProcess | null = null;
let shuttingDown = false;
let shutdownExitCode: number | null = null;

async function runStep(label: string, command: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(command, args, { cwd: repoRoot, stdio: 'inherit', env, detached: true });
  if (child.pid === undefined) {
    throw new Error(`${label} did not start`);
  }
  const pgid = child.pid;
  currentStep = child;
  updateLock(lockPath, lockDeps, { stepPid: pgid });
  // The deadline timer is cleared when the step ends; left armed it would keep this
  // process alive until it fired.
  let deadline: NodeJS.Timeout | undefined;
  try {
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const timedOut = new Promise<'timeout'>((resolve) => {
      deadline = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const outcome = await Promise.race([exit, timedOut]);
    if (outcome === 'timeout') {
      await stopGroup(pgid);
      currentStep = null;
      await removeClonesLeftByStoppedStep();
      throw new Error(`${label} did not finish within ${timeoutMs}ms`);
    }
    // The leader exited; make sure nothing it started is still running.
    if (!(await waitGroupGone(pgid, GRACE_MS))) {
      await stopGroup(pgid);
    }
    if (outcome.code !== 0) {
      throw new Error(`${label} exited with ${outcome.code ?? outcome.signal}`);
    }
  } finally {
    clearTimeout(deadline);
    currentStep = null;
    updateLock(lockPath, lockDeps, {});
  }
}

const acquired = acquireLock(lockPath, lockDeps);
if (acquired.state === 'held') {
  process.stderr.write(`${acquired.reason}; wait for it to finish, or remove the file if that process is not a test run\n`);
  process.exit(3);
}

const claimedSignals = ownSignals(process, ['SIGINT', 'SIGTERM', 'SIGHUP'], (signal, ...args) => {
  void shutdown(signal, args);
});

async function shutdown(signal: NodeJS.Signals, args: readonly unknown[]): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  shutdownExitCode = SIGNAL_EXIT_CODE;
  process.stderr.write(`received ${signal}; stopping the current step before releasing the lock\n`);
  const step = currentStep;
  if (step !== null && step.pid !== undefined) {
    await stopGroup(step.pid);
    currentStep = null;
    await removeClonesLeftByStoppedStep();
  }
  releaseLock(lockPath, lockDeps);
  // The displaced listeners get their turn now that nothing of ours is at stake.
  // Vite's closes its server and exits; the code set here is the one it keeps.
  process.exitCode = SIGNAL_EXIT_CODE;
  await claimedSignals.replay(signal, args, GRACE_MS);
  process.exit(SIGNAL_EXIT_CODE);
}

process.on('exit', (code) => {
  exitFallback({
    code,
    stepPgid: currentStep?.pid ?? null,
    shutdownExitCode,
    host: process,
    groupAlive: (pgid) => signalAlive(-pgid),
    killGroup: (pgid) => signalGroup(pgid, 'SIGKILL'),
    releaseLock: () => releaseLock(lockPath, lockDeps),
    warn: (message) => process.stderr.write(`${message}\n`),
  });
});

try {
  await runStep('npm run build', 'npm', ['run', 'build'], BUILD_TIMEOUT_MS, process.env);
  await runStep(
    'vitest',
    'npx',
    ['vitest', 'run', '--config', 'vitest.demo.config.ts', ...process.argv.slice(2)],
    TEST_TIMEOUT_MS,
    { ...process.env, USABL_INTEGRATION: '1' },
  );
} catch (error) {
  if (!shuttingDown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} finally {
  if (!shuttingDown) {
    releaseLock(lockPath, lockDeps);
  }
}

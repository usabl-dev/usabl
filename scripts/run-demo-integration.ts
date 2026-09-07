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
 * a step timeout, the whole group is signalled (SIGTERM, then SIGKILL) and awaited
 * before the lock is released.
 *
 * Known limits: a SIGKILL of this script cannot stop its step; the lock keeps the
 * next run out until that step group ends on its own, and nobody kills it. A step
 * process stuck in an uninterruptible kernel wait outlives SIGKILL. The lock has
 * one three-way race window, described in demo-integration-lock.ts.
 *
 * Usage: USABL_FIXTURE_APP_CWD=/path/to/usabl-app npm run test:demo-integration
 * Extra arguments are passed to Vitest (for example one test file path).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, releaseLock, updateLock, type LockDeps } from './demo-integration-lock.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const lockPath = join(repoRoot, '.demo-integration.lock');
const BUILD_TIMEOUT_MS = 5 * 60_000;
// The suites bound their own waits; this is only a ceiling for a hung runner.
const TEST_TIMEOUT_MS = 30 * 60_000;
const GRACE_MS = 5_000;
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

let currentStep: ChildProcess | null = null;
let shuttingDown = false;

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

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  process.stderr.write(`received ${signal}; stopping the current step before releasing the lock\n`);
  const step = currentStep;
  if (step !== null && step.pid !== undefined) {
    await stopGroup(step.pid);
  }
  releaseLock(lockPath, lockDeps);
  process.exit(130);
}

const acquired = acquireLock(lockPath, lockDeps);
if (acquired.state === 'held') {
  process.stderr.write(`${acquired.reason}; wait for it to finish, or remove the file if that process is not a test run\n`);
  process.exit(3);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

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

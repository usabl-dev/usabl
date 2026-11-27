/**
 * Starts the worker thread the stop-hook command runs the checks in. See "the checks in a worker"
 * in stop-hook-runner.ts.
 *
 * Loading usabl takes a few seconds on a slow machine, and the worker loads it again for itself.
 * So the command starts the worker before the rest of usabl loads (see stop-hook-early.ts), and both
 * threads load at once. The worker then waits for the message that starts the checks. A worker
 * started early that the command never uses does not keep the process alive.
 *
 * This file imports nothing of usabl, so it runs before the rest of usabl loads.
 */
import { Worker } from 'node:worker_threads';

/** The file the worker runs. The build puts it next to the runner. */
export const STOP_HOOK_WORKER_FILE = 'stop-hook-worker.js';

/** A started worker, and what it did before anyone listened to it. */
export interface StartedWorker {
  worker: Worker;
  // Settles with the error the worker failed with, if it fails.
  failed: Promise<unknown>;
  // Settles with the worker's exit code when it ends.
  exited: Promise<number>;
}

let early: StartedWorker | null = null;

function start(): StartedWorker {
  const worker = new Worker(new URL(`./${STOP_HOOK_WORKER_FILE}`, import.meta.url));
  // Listening at once keeps an early failure from being lost, or from ending the process as an
  // error nobody handled.
  const failed = new Promise<unknown>((resolve) => {
    worker.on('error', resolve);
  });
  const exited = new Promise<number>((resolve) => {
    worker.once('exit', resolve);
  });
  return { worker, failed, exited };
}

/** Starts the worker now, before the rest of usabl loads. It waits until the command takes it. */
export function startStopHookWorkerEarly(): void {
  if (early === null) {
    early = start();
    early.worker.unref();
  }
}

/** The worker started early, or a new one when none was. It keeps the process alive from now on. */
export function takeStopHookWorker(): StartedWorker {
  const taken = early ?? start();
  early = null;
  taken.worker.ref();
  return taken;
}

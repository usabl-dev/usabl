/**
 * A stop-hook worker that holds its thread in one synchronous piece of work, as a slow pattern on
 * a long line would. The hard deadline test builds it in place of src/surfaces/stop-hook-worker.ts,
 * so the real stop-hook command starts it. It runs the real checks up to the point where they build
 * the deps, then loops for ten minutes without a break, so a leaked worker still ends.
 */
import { parentPort } from 'node:worker_threads';
import { runStopHookWorker, type StopWorkerData } from '../../src/surfaces/stop-hook-runner.js';

const HOLD_MS = 10 * 60 * 1000;

const port = parentPort;
if (port !== null) {
  port.once('message', (message: { type: 'start'; data: StopWorkerData }) => {
    void hold(port, message.data);
  });
}

function hold(port: NonNullable<typeof parentPort>, data: StopWorkerData): Promise<void> {
  return runStopHookWorker(port, data, (ports) => ({
    ...ports,
    buildDeps: async () => {
      const end = Date.now() + HOLD_MS;
      while (Date.now() < end) {
        // Holds the thread.
      }
      throw new Error('the held worker ran to its end');
    },
  }));
}

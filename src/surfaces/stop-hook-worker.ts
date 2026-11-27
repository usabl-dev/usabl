/**
 * The worker thread the stop-hook command runs the checks in. The thread that started it keeps the
 * deadline and writes the answer. See "the checks in a worker" in stop-hook-runner.ts.
 */
import { parentPort } from 'node:worker_threads';
import { runStopHookWorker, type StopWorkerData } from './stop-hook-runner.js';

// The worker may start before the command knows what to check, so it waits for the start message.
const port = parentPort;
if (port !== null) {
  port.once('message', (message: { type: 'start'; data: StopWorkerData }) => {
    void runStopHookWorker(port, message.data);
  });
}

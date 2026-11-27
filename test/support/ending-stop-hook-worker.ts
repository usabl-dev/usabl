/**
 * A stop-hook worker that ends before it answers, as one that failed to load or ran out of memory
 * would. The hard deadline test builds it in place of src/surfaces/stop-hook-worker.ts, so the real
 * stop-hook command starts it and must answer for it.
 */
import { parentPort } from 'node:worker_threads';

const port = parentPort;
if (port !== null) {
  port.once('message', () => {
    process.exit(3);
  });
}

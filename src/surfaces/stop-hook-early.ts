/**
 * Starts the stop-hook worker early when this process is the stop-hook command: `usabl stop-hook`,
 * or the runner file an older hook command runs. The command's entry files import this file before
 * anything else, so the worker loads while the rest of usabl does. See stop-hook-worker-start.ts.
 */
import { basename } from 'node:path';
import { startStopHookWorkerEarly } from './stop-hook-worker-start.js';

const script = process.argv[1] === undefined ? '' : basename(process.argv[1]);
if (process.argv[2] === 'stop-hook' || script === 'stop-hook-runner.js') {
  startStopHookWorkerEarly();
}

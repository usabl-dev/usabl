/**
 * Signal ownership for the demo integration runner.
 *
 * The runner executes under vite-node, which hosts a Vite dev server in the same
 * process. Vite installs its own SIGTERM listener that closes that server and then
 * calls process.exit. Both listeners run on the same signal, and Vite's usually
 * finishes first, so the process died while the build group was still being
 * stopped and the lock was still on disk. The runner therefore removes every
 * listener installed before its own for the signals it handles, and keeps a
 * synchronous last resort for any exit it did not choose.
 */

export interface SignalHost {
  listeners(event: string): Function[];
  removeListener(event: string, listener: Function): unknown;
  on(event: string, listener: (signal: NodeJS.Signals) => void): unknown;
}

/**
 * Makes `handler` the only listener for each signal in `signals`.
 * Returns how many listeners installed by other modules were removed.
 */
export function ownSignals(
  host: SignalHost,
  signals: readonly NodeJS.Signals[],
  handler: (signal: NodeJS.Signals) => void,
): number {
  let removed = 0;
  for (const signal of signals) {
    for (const listener of host.listeners(signal)) {
      host.removeListener(signal, listener);
      removed += 1;
    }
    host.on(signal, handler);
  }
  return removed;
}

export interface ExitFallbackDeps {
  /** Process group of the step still recorded as running, or null when none is. */
  stepPgid: number | null;
  groupAlive: (pgid: number) => boolean;
  /** Sends SIGKILL to the group. */
  killGroup: (pgid: number) => void;
  releaseLock: () => void;
  warn: (message: string) => void;
}

/**
 * Runs synchronously from the process `exit` event. When a step group is still
 * running it is killed and the lock is left in place, because the lock may only
 * be released once the group is gone and nothing can wait for that here. The
 * next run reclaims the lock as soon as the group has ended. Otherwise the lock
 * is released as usual.
 */
export function exitFallback(deps: ExitFallbackDeps): 'released' | 'left' {
  if (deps.stepPgid !== null && deps.groupAlive(deps.stepPgid)) {
    deps.killGroup(deps.stepPgid);
    deps.warn(
      `exiting while process group ${deps.stepPgid} is still running; sent SIGKILL and left the lock until that group is gone`,
    );
    return 'left';
  }
  deps.releaseLock();
  return 'released';
}

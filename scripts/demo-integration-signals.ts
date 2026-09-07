/**
 * Signal ownership for the demo integration runner.
 *
 * The runner executes under vite-node, which hosts a Vite dev server in the same
 * process. Vite installs its own SIGTERM listener that closes that server and then
 * calls process.exit. Both listeners run on the same signal, and Vite's usually
 * finishes first, so the process died while the build group was still being
 * stopped and the lock was still on disk. The runner therefore takes every
 * listener installed before its own off the signals it handles, and replays them
 * itself once the step group is stopped and the lock is released, so their cleanup
 * still runs, in the original order and with the original arguments. A synchronous
 * last resort covers any exit the runner did not choose.
 */

type SignalListener = (signal: NodeJS.Signals, ...rest: unknown[]) => unknown;

export interface SignalHost {
  listeners(event: string): Function[];
  removeListener(event: string, listener: Function): unknown;
  on(event: string, listener: SignalListener): unknown;
}

export interface ClaimedSignals {
  /** How many listeners other modules had installed on the claimed signals. */
  captured: number;
  /**
   * Invokes the listeners captured for `signal`, in their original order, with the
   * same arguments the signal delivered. Waits for any promise they return, but no
   * longer than `timeoutMs`, so a listener that never settles cannot hold the exit.
   */
  replay(signal: NodeJS.Signals, args: readonly unknown[], timeoutMs: number): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Makes `handler` the only listener for each signal in `signals`, keeping the
 * listeners it displaced so the caller can replay them later.
 */
export function ownSignals(host: SignalHost, signals: readonly NodeJS.Signals[], handler: SignalListener): ClaimedSignals {
  const displaced = new Map<NodeJS.Signals, Function[]>();
  let captured = 0;
  for (const signal of signals) {
    const existing = host.listeners(signal);
    for (const listener of existing) {
      host.removeListener(signal, listener);
    }
    displaced.set(signal, existing);
    captured += existing.length;
    host.on(signal, handler);
  }
  return {
    captured,
    async replay(signal, args, timeoutMs) {
      const results: unknown[] = [];
      for (const listener of displaced.get(signal) ?? []) {
        results.push(Reflect.apply(listener, host, [signal, ...args]));
      }
      const settled = Promise.allSettled(results.map((result) => Promise.resolve(result)));
      await Promise.race([settled, sleep(timeoutMs)]);
    },
  };
}

/** The part of `process` the exit fallback writes. */
export interface ExitHost {
  exitCode?: number | string | null | undefined;
}

export interface ExitFallbackDeps {
  /** The code the process is exiting with, as the exit event reports it. */
  code: number;
  /** Process group of the step still recorded as running, or null when none is. */
  stepPgid: number | null;
  /** The code the runner's own signal shutdown chose, or null when no shutdown is in progress. */
  shutdownExitCode: number | null;
  host: ExitHost;
  groupAlive: (pgid: number) => boolean;
  /** Sends SIGKILL to the group. */
  killGroup: (pgid: number) => void;
  releaseLock: () => void;
  warn: (message: string) => void;
}

/**
 * Runs synchronously from the process `exit` event.
 *
 * A step still recorded means the exit was not the runner's choice and the run is
 * interrupted: a step group that is still running is killed and the lock is left in
 * place, because the lock may only be released once the group is gone and nothing
 * can wait for that here; the next run reclaims it as soon as the group has ended.
 * Either way the exit code becomes 1, so a foreign `process.exit(0)` cannot report
 * an interrupted build or test run as a success.
 *
 * During the runner's own signal shutdown the replayed listeners may exit with a
 * code of their own; the runner's code wins. Otherwise the lock is released.
 */
export function exitFallback(deps: ExitFallbackDeps): 'interrupted' | 'shutdown' | 'released' {
  if (deps.stepPgid !== null) {
    if (deps.groupAlive(deps.stepPgid)) {
      deps.killGroup(deps.stepPgid);
      deps.warn(
        `run interrupted: exit with code ${deps.code} was requested while process group ${deps.stepPgid} was still running; sent SIGKILL, left the lock until that group is gone, exiting with code 1`,
      );
    } else {
      deps.releaseLock();
      deps.warn(
        `run interrupted: exit with code ${deps.code} was requested while a step was recorded; its process group ${deps.stepPgid} has ended, lock released, exiting with code 1`,
      );
    }
    deps.host.exitCode = 1;
    return 'interrupted';
  }
  if (deps.shutdownExitCode !== null) {
    deps.host.exitCode = deps.shutdownExitCode;
    return 'shutdown';
  }
  deps.releaseLock();
  return 'released';
}

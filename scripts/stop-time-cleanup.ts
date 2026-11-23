/**
 * The cleanup of the stop time script (measure-stop-time.ts). The script starts a fixture dev
 * server and runs Stop hook children in a clone of the demo app. A signal can come at any point,
 * so the cleanup knows what is running:
 * - a server that is still starting is stopped once its start ends (a start that fails stops its
 *   own server);
 * - a Stop hook child that is still running is stopped, so a SIGTERM sent only to the script does
 *   not leave it running against a removed clone.
 * Then it removes the clone. It runs once, whether a signal or the end of the run asks first.
 */

export interface StopTimeCleanupSteps<Server> {
  stopServer: (server: Server) => Promise<void>;
  dispose: () => Promise<void>;
}

export interface StopTimeCleanup<Server> {
  /** Starts the server and keeps the start, so a signal before the server is ready still stops it. */
  startServer: (start: () => Promise<Server>) => Promise<Server>;
  /** Records a running Stop hook and how to stop it. Call the returned function once it exited. */
  trackStop: (stop: () => void) => () => void;
  /** Stops what is running and removes the clone. Every call returns the same promise. */
  run: () => Promise<void>;
}

export function stopTimeCleanup<Server>(steps: StopTimeCleanupSteps<Server>): StopTimeCleanup<Server> {
  let starting: Promise<Server> | null = null;
  const running = new Set<() => void>();
  let cleaned: Promise<void> | null = null;
  return {
    startServer: (start) => {
      starting = start();
      return starting;
    },
    trackStop: (stop) => {
      running.add(stop);
      return () => {
        running.delete(stop);
      };
    },
    run: () =>
      (cleaned ??= (async () => {
        for (const stop of running) {
          try {
            stop();
          } catch {
            // The child exited on its own in the meantime.
          }
        }
        running.clear();
        const server = starting === null ? null : await starting.catch(() => null);
        if (server !== null) {
          await steps.stopServer(server);
        }
        await steps.dispose();
      })()),
  };
}

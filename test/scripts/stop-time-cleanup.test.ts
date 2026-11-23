/**
 * The stop time script's cleanup. A signal can come while the fixture server is still starting,
 * or while a Stop hook child is running. Either must be stopped before the clone is removed. The
 * script itself needs the demo app and Chromium, so only its cleanup is tested here.
 */
import { describe, expect, it } from 'vitest';
import { stopTimeCleanup } from '../../scripts/stop-time-cleanup.js';

function steps() {
  const events: string[] = [];
  return {
    events,
    stopServer: async (server: string) => {
      events.push(`stop server ${server}`);
    },
    dispose: async () => {
      events.push('remove clone');
    },
  };
}

describe('the stop time cleanup', () => {
  it('stops a server that was still starting when the signal came, then removes the clone', async () => {
    const s = steps();
    const cleanup = stopTimeCleanup(s);
    let ready: (server: string) => void = () => {};
    const started = cleanup.startServer(() => new Promise<string>((resolve) => (ready = resolve)));

    const cleaned = cleanup.run();
    s.events.push('server ready');
    ready('demo');
    await cleaned;
    await started;

    expect(s.events).toEqual(['server ready', 'stop server demo', 'remove clone']);
  });

  it('does not stop a server whose start failed, and still removes the clone', async () => {
    const s = steps();
    const cleanup = stopTimeCleanup(s);
    const started = cleanup.startServer(async () => {
      throw new Error('the server did not start');
    });
    await expect(started).rejects.toThrow('the server did not start');

    await cleanup.run();
    expect(s.events).toEqual(['remove clone']);
  });

  it('stops a running Stop hook before it removes the clone, and not one that already exited', async () => {
    const s = steps();
    const cleanup = stopTimeCleanup(s);
    const exited = cleanup.trackStop(() => s.events.push('stop hook 1'));
    exited();
    cleanup.trackStop(() => s.events.push('stop hook 2'));
    await cleanup.startServer(async () => 'demo');

    await cleanup.run();
    expect(s.events).toEqual(['stop hook 2', 'stop server demo', 'remove clone']);
  });

  it('still cleans up when stopping a Stop hook throws', async () => {
    const s = steps();
    const cleanup = stopTimeCleanup(s);
    cleanup.trackStop(() => {
      throw new Error('no such process');
    });

    await cleanup.run();
    expect(s.events).toEqual(['remove clone']);
  });

  it('leaves no stop running when a signal comes during the first stop', async () => {
    const s = steps();
    const cleanup = stopTimeCleanup(s);
    await cleanup.startServer(async () => 'demo');
    const running = new Set<string>();
    // The way the script runs a stop: it asks first, then tracks the child until it exits.
    const startStop = (name: string): void => {
      cleanup.assertRunning();
      running.add(name);
      cleanup.trackStop(() => running.delete(name));
    };

    startStop('cold');
    const cleaned = cleanup.run();
    // The cold stop's exit lets the measurement go on to the warm stop.
    expect(() => startStop('warm')).toThrow('the run is stopping');
    // A stop that was spawned anyway, just before the check, is stopped at once.
    running.add('late');
    cleanup.trackStop(() => running.delete('late'));
    await cleaned;

    expect(running.size).toBe(0);
    expect(cleanup.stopping()).toBe(true);
  });

  it('starts no server once the cleanup began', async () => {
    const s = steps();
    const cleanup = stopTimeCleanup(s);
    await cleanup.run();
    let started = false;
    await expect(
      cleanup.startServer(async () => {
        started = true;
        return 'demo';
      }),
    ).rejects.toThrow('the run is stopping');
    expect(started).toBe(false);
  });

  it('runs once, however often a signal or the end of the run asks', async () => {
    const s = steps();
    const cleanup = stopTimeCleanup(s);
    await cleanup.startServer(async () => 'demo');

    await Promise.all([cleanup.run(), cleanup.run()]);
    await cleanup.run();
    expect(s.events).toEqual(['stop server demo', 'remove clone']);
  });
});

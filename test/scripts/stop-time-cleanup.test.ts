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

  it('runs once, however often a signal or the end of the run asks', async () => {
    const s = steps();
    const cleanup = stopTimeCleanup(s);
    await cleanup.startServer(async () => 'demo');

    await Promise.all([cleanup.run(), cleanup.run()]);
    await cleanup.run();
    expect(s.events).toEqual(['stop server demo', 'remove clone']);
  });
});

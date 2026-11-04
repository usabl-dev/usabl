/**
 * Service-worker activity keeps readiness waiting. A worker's requests are reported on the browser
 * context, never on the page, and its install and activation only over CDP, so the page's own
 * tracker reads quiet while a worker fetch that gates the content is still out. These pin the
 * tracker that closes that, driven by fake events; test/judge/isolated-browser.real.integration.test.ts
 * checks the same against real Chromium.
 */
import { describe, expect, it } from 'vitest';
import {
  makeWorkerActivityTracker,
  waitForRendered,
  type WorkerRequestEvents,
  type WorkerRequestHandle,
} from '../../src/deps/real.js';

type Handler = (request: WorkerRequestHandle) => void;

function fakeContext(): { events: WorkerRequestEvents; emit: (event: string, request: WorkerRequestHandle) => void } {
  const handlers = new Map<string, Handler[]>();
  return {
    events: {
      on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
      off: (event, handler) => handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== handler)),
    },
    emit: (event, request) => {
      for (const handler of handlers.get(event) ?? []) handler(request);
    },
  };
}

const workerRequest: WorkerRequestHandle = { serviceWorker: () => ({}) };
const pageRequest: WorkerRequestHandle = { serviceWorker: () => null };

describe('makeWorkerActivityTracker', () => {
  it('is busy while a service worker request is in flight, and quiet a window after it ends', () => {
    let clock = 0;
    const context = fakeContext();
    const tracker = makeWorkerActivityTracker(context.events, () => clock);
    clock = 1000;
    expect(tracker.quietFor(500)).toBe(true);

    context.emit('request', workerRequest);
    clock = 5000;
    expect(tracker.quietFor(500)).toBe(false);
    expect(tracker.busyDetail()).toBe('1 service worker request still in flight');

    context.emit('requestfinished', workerRequest);
    expect(tracker.quietFor(500)).toBe(false);
    clock = 5500;
    expect(tracker.quietFor(500)).toBe(true);
    expect(tracker.busyDetail()).toBeNull();
  });

  it('ignores a page request, which the page tracker counts', () => {
    let clock = 0;
    const context = fakeContext();
    const tracker = makeWorkerActivityTracker(context.events, () => clock);
    context.emit('request', pageRequest);
    clock = 1000;
    expect(tracker.quietFor(500)).toBe(true);
  });

  it('counts a failed worker request as ended', () => {
    let clock = 0;
    const context = fakeContext();
    const tracker = makeWorkerActivityTracker(context.events, () => clock);
    context.emit('request', workerRequest);
    context.emit('requestfailed', workerRequest);
    clock = 1000;
    expect(tracker.quietFor(500)).toBe(true);
  });

  it('is busy while a worker installs or activates, and not for one that never started', () => {
    let clock = 0;
    const tracker = makeWorkerActivityTracker(fakeContext().events, () => clock);
    // New and stopped: a script that was never fetched, or failed to fetch. The browser reports
    // nothing more about it, so it cannot hold readiness.
    tracker.versionsUpdated([{ versionId: '0', status: 'new', runningStatus: 'stopped' }]);
    clock = 1000;
    expect(tracker.quietFor(500)).toBe(true);

    for (const [status, runningStatus] of [
      ['new', 'starting'],
      ['installing', 'running'],
      ['installed', 'running'],
      ['activating', 'running'],
    ] as const) {
      tracker.versionsUpdated([{ versionId: '0', status, runningStatus }]);
      clock += 1000;
      expect(tracker.quietFor(500)).toBe(false);
      expect(tracker.busyDetail()).toBe('1 service worker still installing or activating');
    }

    tracker.versionsUpdated([{ versionId: '0', status: 'activated', runningStatus: 'running' }]);
    expect(tracker.quietFor(500)).toBe(false);
    clock += 500;
    expect(tracker.quietFor(500)).toBe(true);
  });

  it('stops listening when stopped', () => {
    let clock = 0;
    const context = fakeContext();
    const tracker = makeWorkerActivityTracker(context.events, () => clock);
    tracker.stop();
    context.emit('request', workerRequest);
    clock = 1000;
    expect(tracker.quietFor(500)).toBe(true);
  });
});

describe('waitForRendered with a busy service worker', () => {
  it('names the service worker when the budget runs out on it', async () => {
    const page = {
      evaluate: async (): Promise<number> => 10,
      networkQuietFor: (): boolean => false,
      networkBusyDetail: (): string => '1 service worker request still in flight',
    };
    await expect(waitForRendered(page, 2500)).rejects.toThrow(
      'network activity did not go quiet within 2500ms (1 service worker request still in flight)',
    );
  });
});

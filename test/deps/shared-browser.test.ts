import { describe, expect, it } from 'vitest';
import { makeRealBrowserDriver, makeSharedBrowser, type LaunchedBrowser } from '../../src/deps/real.js';

/**
 * A browser process stand-in. It is connected until a test says otherwise, records the options of
 * every context it opens, and can be told to fail an open. The page and CDP session behind it do
 * nothing, which is enough: the shared browser only wires them up on open.
 */
function fakeLaunched(): {
  browser: LaunchedBrowser;
  contextOptions: unknown[];
  setConnected(value: boolean): void;
  failNextContext(error: Error, options?: { dies: boolean }): void;
  closeCalls: () => number;
} {
  let connected = true;
  let nextContextError: { error: Error; dies: boolean } | null = null;
  let closed = 0;
  const contextOptions: unknown[] = [];
  const page = {
    addInitScript: async () => {},
    on: () => page,
    goto: async () => null,
  };
  const context = {
    newPage: async () => page,
    newCDPSession: async () => ({ send: async () => ({}) }),
    close: async () => {},
  };
  const browser = {
    newContext: async (options?: unknown) => {
      contextOptions.push(options ?? {});
      if (nextContextError !== null) {
        const { error, dies } = nextContextError;
        nextContextError = null;
        if (dies) {
          // The process died in the middle of this call: it reports disconnected from here on.
          connected = false;
        }
        throw error;
      }
      return context;
    },
    isConnected: () => connected,
    close: async () => {
      closed += 1;
      connected = false;
    },
  } as unknown as LaunchedBrowser;
  return {
    browser,
    contextOptions,
    setConnected: (value) => {
      connected = value;
    },
    failNextContext: (error, options = { dies: false }) => {
      nextContextError = { error, dies: options.dies };
    },
    closeCalls: () => closed,
  };
}

describe('makeSharedBrowser', () => {
  it('launches once and opens every context with the options of its own run', async () => {
    const launched = fakeLaunched();
    let launches = 0;
    const shared = makeSharedBrowser({
      launch: async () => {
        launches += 1;
        return launched.browser;
      },
    });

    const signedOut = shared.driver({});
    const signedIn = shared.driver({ storageStatePath: '/tmp/session.json', readyTimeoutMs: 1000 });
    await signedOut.open('http://127.0.0.1:1/a');
    await signedIn.open('http://127.0.0.1:1/b');
    await signedOut.open('http://127.0.0.1:1/c');

    expect(launches).toBe(1);
    // The session is per run, applied on each open, not fixed at launch.
    expect(launched.contextOptions).toEqual([{}, { storageState: '/tmp/session.json' }, {}]);

    // A run's driver cannot close the process. Only the shared browser can, and it does so once.
    await signedIn.close();
    expect(launched.closeCalls()).toBe(0);
    await shared.close();
    expect(launched.closeCalls()).toBe(1);
    await shared.close();
    expect(launched.closeCalls()).toBe(1);
  });

  it('relaunches when the process died between runs', async () => {
    const processes: ReturnType<typeof fakeLaunched>[] = [];
    const shared = makeSharedBrowser({
      launch: async () => {
        const next = fakeLaunched();
        processes.push(next);
        return next.browser;
      },
    });
    const driver = shared.driver({});

    await driver.open('http://127.0.0.1:1/first');
    expect(processes.length).toBe(1);

    // The process is gone: crashed, killed, or closed from outside. The reference must not be
    // reused, or every later open in the dev session fails against a dead browser.
    processes[0]?.setConnected(false);
    await driver.open('http://127.0.0.1:1/second');
    expect(processes.length).toBe(2);
    expect(processes[1]?.contextOptions).toEqual([{}]);
    // The dead one was released on this side.
    expect(processes[0]?.closeCalls()).toBe(1);

    // A connected process is kept.
    await driver.open('http://127.0.0.1:1/third');
    expect(processes.length).toBe(2);
  });

  it('forgets a process that died during an open, so the next open relaunches', async () => {
    const processes: ReturnType<typeof fakeLaunched>[] = [];
    const shared = makeSharedBrowser({
      launch: async () => {
        const next = fakeLaunched();
        processes.push(next);
        return next.browser;
      },
    });
    const driver = shared.driver({});
    await driver.open('http://127.0.0.1:1/first');

    // The process dies in the middle of an open: it was connected when the open began, the context
    // call fails, and the browser reports disconnected afterwards.
    processes[0]?.failNextContext(new Error('Target page, context or browser has been closed'), {
      dies: true,
    });
    await expect(driver.open('http://127.0.0.1:1/second')).rejects.toThrow('has been closed');
    expect(processes.length).toBe(1);

    await driver.open('http://127.0.0.1:1/third');
    expect(processes.length).toBe(2);
  });

  it('keeps a live process when an open fails for a page reason', async () => {
    const processes: ReturnType<typeof fakeLaunched>[] = [];
    const shared = makeSharedBrowser({
      launch: async () => {
        const next = fakeLaunched();
        processes.push(next);
        return next.browser;
      },
    });
    const driver = shared.driver({});
    await driver.open('http://127.0.0.1:1/first');

    // The process is fine; this one context could not be made. That is the page's problem and
    // does not cost a relaunch.
    processes[0]?.failNextContext(new Error('net::ERR_CONNECTION_REFUSED'));
    await expect(driver.open('http://127.0.0.1:1/second')).rejects.toThrow('ERR_CONNECTION_REFUSED');
    await driver.open('http://127.0.0.1:1/third');
    expect(processes.length).toBe(1);
  });
});

describe('makeRealBrowserDriver', () => {
  it('is the one-shot shape: same open path, and its close ends the process', async () => {
    const launched = fakeLaunched();
    const driver = makeRealBrowserDriver(
      { storageStatePath: '/tmp/session.json' },
      { launch: async () => launched.browser },
    );
    await driver.open('http://127.0.0.1:1/a');
    expect(launched.contextOptions).toEqual([{ storageState: '/tmp/session.json' }]);
    await driver.close();
    expect(launched.closeCalls()).toBe(1);
  });
});

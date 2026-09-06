import { describe, expect, it } from 'vitest';
import { makeRealBrowserDriver, makeSharedBrowser, type LaunchedBrowser } from '../../src/deps/real.js';

/**
 * A browser process stand-in. It is connected until a test says otherwise, records the options of
 * every context it opens and how many contexts were closed, and can be told to fail the next
 * context, page, or navigation. The page and CDP session behind it do nothing, which is enough:
 * the shared browser only wires them up on open.
 */
function fakeLaunched(): {
  browser: LaunchedBrowser;
  contextOptions: unknown[];
  contextCloseCalls: () => number;
  setConnected(value: boolean): void;
  failNextContext(error: Error, options?: { dies: boolean }): void;
  failNextPage(error: Error): void;
  failNextGoto(error: Error): void;
  closeCalls: () => number;
} {
  let connected = true;
  let nextContextError: { error: Error; dies: boolean } | null = null;
  let nextPageError: Error | null = null;
  let nextGotoError: Error | null = null;
  let closed = 0;
  let contextsClosed = 0;
  const contextOptions: unknown[] = [];
  const page = {
    addInitScript: async () => {},
    on: () => page,
    goto: async () => {
      if (nextGotoError !== null) {
        const error = nextGotoError;
        nextGotoError = null;
        throw error;
      }
      return null;
    },
  };
  const context = {
    newPage: async () => {
      if (nextPageError !== null) {
        const error = nextPageError;
        nextPageError = null;
        throw error;
      }
      return page;
    },
    newCDPSession: async () => ({ send: async () => ({}) }),
    close: async () => {
      contextsClosed += 1;
    },
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
    contextCloseCalls: () => contextsClosed,
    setConnected: (value) => {
      connected = value;
    },
    failNextContext: (error, options = { dies: false }) => {
      nextContextError = { error, dies: options.dies };
    },
    failNextPage: (error) => {
      nextPageError = error;
    },
    failNextGoto: (error) => {
      nextGotoError = error;
    },
    closeCalls: () => closed,
  };
}

/** A launch port that records every launch and can hold the launch open until released. */
function launcher(options: { deferred?: boolean } = {}): {
  launch: () => Promise<LaunchedBrowser>;
  processes: ReturnType<typeof fakeLaunched>[];
  release: () => void;
  launches: () => number;
} {
  const processes: ReturnType<typeof fakeLaunched>[] = [];
  let pending: Array<(browser: LaunchedBrowser) => void> = [];
  let launches = 0;
  return {
    launch: async () => {
      launches += 1;
      const next = fakeLaunched();
      processes.push(next);
      if (!options.deferred) {
        return next.browser;
      }
      return new Promise<LaunchedBrowser>((resolve) => {
        pending.push(resolve);
      });
    },
    processes,
    release: () => {
      const waiting = pending;
      pending = [];
      waiting.forEach((resolve, index) => resolve(processes[index]?.browser as LaunchedBrowser));
    },
    launches: () => launches,
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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

  it('shares one launch between two concurrent first opens', async () => {
    // Two opens land before any process exists. Without a shared launch promise each launches a
    // process, only one is kept, and the other runs on with nothing to close it.
    const ports = launcher({ deferred: true });
    const shared = makeSharedBrowser({ launch: ports.launch });
    const driver = shared.driver({});

    const first = driver.open('http://127.0.0.1:1/a');
    const second = driver.open('http://127.0.0.1:1/b');
    await tick();
    expect(ports.launches()).toBe(1);
    ports.release();
    await Promise.all([first, second]);

    expect(ports.launches()).toBe(1);
    expect(ports.processes[0]?.contextOptions).toEqual([{}, {}]);
    await shared.close();
    expect(ports.processes[0]?.closeCalls()).toBe(1);
  });

  it('closes the process a launch produces when close() races that launch', async () => {
    // close() arrives while the first launch is still in flight. It must wait for the process and
    // close it, not look, see nothing, and leave the process running once the launch lands.
    const ports = launcher({ deferred: true });
    const shared = makeSharedBrowser({ launch: ports.launch });
    const driver = shared.driver({});

    const opening = driver.open('http://127.0.0.1:1/a');
    await tick();
    const closing = shared.close();
    ports.release();
    await closing;

    expect(ports.processes[0]?.closeCalls()).toBe(1);
    // The open that was waiting on the launch does not get a page from a closed browser.
    await expect(opening).rejects.toThrow('shared browser is closed');
  });

  it('rejects an open after close instead of launching a new process', async () => {
    const ports = launcher();
    const shared = makeSharedBrowser({ launch: ports.launch });
    const driver = shared.driver({});
    await driver.open('http://127.0.0.1:1/a');
    await shared.close();

    await expect(driver.open('http://127.0.0.1:1/b')).rejects.toThrow('shared browser is closed');
    await expect(shared.driver({}).open('http://127.0.0.1:1/c')).rejects.toThrow('shared browser is closed');
    expect(ports.launches()).toBe(1);
  });

  it('closes the context when setup after newContext fails', async () => {
    // Once a context exists, a failure making the page must close that context, or a page opened
    // from the run's storage state stays alive with nothing holding it.
    const ports = launcher();
    const shared = makeSharedBrowser({ launch: ports.launch });
    const driver = shared.driver({ storageStatePath: '/tmp/session.json' });
    await driver.open('http://127.0.0.1:1/a');
    const process = ports.processes[0];

    process?.failNextPage(new Error('page could not be created'));
    await expect(driver.open('http://127.0.0.1:1/b')).rejects.toThrow('page could not be created');
    expect(process?.contextCloseCalls()).toBe(1);
    // The process itself is fine and stays.
    expect(ports.launches()).toBe(1);
    await driver.open('http://127.0.0.1:1/c');
    expect(ports.launches()).toBe(1);
  });

  it('closes the context when navigation fails', async () => {
    const ports = launcher();
    const shared = makeSharedBrowser({ launch: ports.launch });
    const driver = shared.driver({ storageStatePath: '/tmp/session.json' });
    await driver.open('http://127.0.0.1:1/a');
    const process = ports.processes[0];

    process?.failNextGoto(new Error('net::ERR_CONNECTION_REFUSED'));
    await expect(driver.open('http://127.0.0.1:1/b')).rejects.toThrow('ERR_CONNECTION_REFUSED');
    expect(process?.contextCloseCalls()).toBe(1);
    expect(ports.launches()).toBe(1);
  });

  it('relaunches when the process died between runs', async () => {
    const ports = launcher();
    const shared = makeSharedBrowser({ launch: ports.launch });
    const driver = shared.driver({});

    await driver.open('http://127.0.0.1:1/first');
    expect(ports.launches()).toBe(1);

    // The process is gone: crashed, killed, or closed from outside. The reference must not be
    // reused, or every later open in the dev session fails against a dead browser.
    ports.processes[0]?.setConnected(false);
    await driver.open('http://127.0.0.1:1/second');
    expect(ports.launches()).toBe(2);
    expect(ports.processes[1]?.contextOptions).toEqual([{}]);
    // The dead one was released on this side.
    expect(ports.processes[0]?.closeCalls()).toBe(1);

    // A connected process is kept.
    await driver.open('http://127.0.0.1:1/third');
    expect(ports.launches()).toBe(2);
  });

  it('forgets a process that died during an open, so the next open relaunches', async () => {
    const ports = launcher();
    const shared = makeSharedBrowser({ launch: ports.launch });
    const driver = shared.driver({});
    await driver.open('http://127.0.0.1:1/first');

    // The process dies in the middle of an open: it was connected when the open began, the context
    // call fails, and the browser reports disconnected afterwards.
    ports.processes[0]?.failNextContext(new Error('Target page, context or browser has been closed'), {
      dies: true,
    });
    await expect(driver.open('http://127.0.0.1:1/second')).rejects.toThrow('has been closed');
    expect(ports.launches()).toBe(1);

    await driver.open('http://127.0.0.1:1/third');
    expect(ports.launches()).toBe(2);
  });

  it('replaces a process that stays connected but keeps refusing contexts', async () => {
    // A wedged process can keep its connection up while every newContext fails. Kept forever, it
    // would fail every later scan in the dev session. After a few failures in a row it is replaced.
    const ports = launcher();
    const shared = makeSharedBrowser({ launch: ports.launch, maxContextFailures: 2 });
    const driver = shared.driver({});
    await driver.open('http://127.0.0.1:1/first');
    const process = ports.processes[0];

    process?.failNextContext(new Error('context refused'));
    await expect(driver.open('http://127.0.0.1:1/a')).rejects.toThrow('context refused');
    expect(ports.launches()).toBe(1);
    process?.failNextContext(new Error('context refused'));
    await expect(driver.open('http://127.0.0.1:1/b')).rejects.toThrow('context refused');
    // Second failure in a row: the process is dropped even though it says it is connected.
    expect(process?.closeCalls()).toBe(1);

    await driver.open('http://127.0.0.1:1/c');
    expect(ports.launches()).toBe(2);
  });

  it('keeps a live process when one open fails for a page reason', async () => {
    const ports = launcher();
    const shared = makeSharedBrowser({ launch: ports.launch });
    const driver = shared.driver({});
    await driver.open('http://127.0.0.1:1/first');

    // One context could not be made and the process is fine. A single failure does not cost a
    // relaunch, and a success in between resets the count.
    ports.processes[0]?.failNextContext(new Error('net::ERR_CONNECTION_REFUSED'));
    await expect(driver.open('http://127.0.0.1:1/second')).rejects.toThrow('ERR_CONNECTION_REFUSED');
    await driver.open('http://127.0.0.1:1/third');
    ports.processes[0]?.failNextContext(new Error('net::ERR_CONNECTION_REFUSED'));
    await expect(driver.open('http://127.0.0.1:1/fourth')).rejects.toThrow('ERR_CONNECTION_REFUSED');
    await driver.open('http://127.0.0.1:1/fifth');
    expect(ports.launches()).toBe(1);
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

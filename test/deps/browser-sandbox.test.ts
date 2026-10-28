/**
 * How the shared browser starts Chromium: with its sandbox, and without it only when the system
 * cannot provide one and the run allows that. Driven through the launch port with a stand-in
 * process, so every launch and its options are recorded and no real Chromium starts.
 */
import { describe, expect, it, vi } from 'vitest';

// The real default launch, observed without starting a browser: chromium.launch records what it
// was asked for and fails. Only this module's view of playwright is replaced.
const launchCalls = vi.hoisted((): unknown[] => []);
vi.mock('playwright', async (importOriginal) => {
  const original = await importOriginal<typeof import('playwright')>();
  return {
    ...original,
    chromium: {
      launch: async (options: unknown) => {
        launchCalls.push(options);
        throw new Error('no browser in this test');
      },
    },
  };
});

import { makeRealBrowserDriver, makeSharedBrowser, type LaunchedBrowser } from '../../src/deps/real.js';
import { BrowserSandboxRequiredError, isBrowserSandboxRefusal } from '../../src/deps/sandbox.js';

// The line Chromium writes when it cannot start its sandbox, as Playwright reports it.
const NO_SANDBOX =
  'browserType.launch: Target page, context or browser has been closed\nBrowser logs:\nChromium sandboxing failed!\n' +
  '[pid=1000][err] [FATAL:zygote_host_impl_linux.cc(132)] No usable sandbox! If you are running on Ubuntu 23.10+ ' +
  'or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see ' +
  'https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md.';
const NOT_INSTALLED =
  "browserType.launch: Executable doesn't exist at /home/user/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell";

/** A browser process stand-in whose contexts, pages, and CDP sessions do nothing. */
function fakeProcess(): LaunchedBrowser {
  let connected = true;
  const page = { on: () => page, goto: async () => null };
  const context = {
    newPage: async () => page,
    newCDPSession: async () => ({ send: async () => ({}) }),
    close: async () => {},
  };
  return {
    newContext: async () => context,
    isConnected: () => connected,
    close: async () => {
      connected = false;
    },
  } as unknown as LaunchedBrowser;
}

/**
 * A launch port that records the options of every launch. A sandboxed launch fails with
 * `sandboxError` when one is given; an unsandboxed launch fails with `fallbackError` when one is.
 */
function launcher(options: { sandboxError?: string; fallbackError?: string } = {}): {
  launch: (launchOptions: { chromiumSandbox: boolean }) => Promise<LaunchedBrowser>;
  calls: Array<{ chromiumSandbox: boolean }>;
} {
  const calls: Array<{ chromiumSandbox: boolean }> = [];
  return {
    calls,
    launch: async (launchOptions) => {
      calls.push({ ...launchOptions });
      if (launchOptions.chromiumSandbox && options.sandboxError !== undefined) {
        throw new Error(options.sandboxError);
      }
      if (!launchOptions.chromiumSandbox && options.fallbackError !== undefined) {
        throw new Error(options.fallbackError);
      }
      return fakeProcess();
    },
  };
}

describe('the scan browser launch', () => {
  it('asks Chromium for its sandbox by default', async () => {
    launchCalls.length = 0;
    const driver = makeRealBrowserDriver();
    await expect(driver.open('http://app.test/')).rejects.toThrow('no browser in this test');
    expect(launchCalls).toEqual([{ headless: true, chromiumSandbox: true }]);
  });

  it('launches with the sandbox through the port, and a page from it carries no sandbox note', async () => {
    const ports = launcher();
    const shared = makeSharedBrowser({ launch: ports.launch });
    const page = await shared.driver().open('http://app.test/');
    expect(ports.calls).toEqual([{ chromiumSandbox: true }]);
    expect(page.browserSandbox).toBeUndefined();
    await shared.close();
  });
});

describe('when the system cannot provide a sandbox', () => {
  it('falls back to an unsandboxed launch and marks every page from it', async () => {
    const ports = launcher({ sandboxError: NO_SANDBOX });
    const shared = makeSharedBrowser({ launch: ports.launch });
    const page = await shared.driver().open('http://app.test/');
    expect(ports.calls).toEqual([{ chromiumSandbox: true }, { chromiumSandbox: false }]);
    expect(page.browserSandbox).toBe('off');
    await shared.close();
  });

  it('decides once per browser process, not once per page', async () => {
    const ports = launcher({ sandboxError: NO_SANDBOX });
    const shared = makeSharedBrowser({ launch: ports.launch });
    const first = await shared.driver().open('http://app.test/a');
    const second = await shared.driver().open('http://app.test/b');
    expect(ports.calls).toHaveLength(2);
    expect(first.browserSandbox).toBe('off');
    expect(second.browserSandbox).toBe('off');
    await shared.close();
  });

  it('refuses to scan when the run requires the sandbox, and never launches without it', async () => {
    const ports = launcher({ sandboxError: NO_SANDBOX });
    const shared = makeSharedBrowser({ launch: ports.launch });
    const refused = shared.driver({ browserSandbox: 'require' }).open('http://app.test/');
    await expect(refused).rejects.toBeInstanceOf(BrowserSandboxRequiredError);
    await expect(refused).rejects.toThrow(/browserSandbox/);
    await expect(refused).rejects.toThrow(/AppArmor/);
    expect(ports.calls).toEqual([{ chromiumSandbox: true }]);
    await shared.close();
  });

  it('refuses a run that requires the sandbox on a process an earlier run started without it', async () => {
    const ports = launcher({ sandboxError: NO_SANDBOX });
    const shared = makeSharedBrowser({ launch: ports.launch });
    await shared.driver().open('http://app.test/');
    await expect(shared.driver({ browserSandbox: 'require' }).open('http://app.test/')).rejects.toBeInstanceOf(
      BrowserSandboxRequiredError,
    );
    expect(ports.calls).toHaveLength(2);
    await shared.close();
  });

  it('still lets a run that allows the fallback start one after a run that required the sandbox was refused', async () => {
    const ports = launcher({ sandboxError: NO_SANDBOX });
    const shared = makeSharedBrowser({ launch: ports.launch });
    const [strict, relaxed] = await Promise.allSettled([
      shared.driver({ browserSandbox: 'require' }).open('http://app.test/a'),
      shared.driver({ browserSandbox: 'auto' }).open('http://app.test/b'),
    ]);
    expect(strict.status).toBe('rejected');
    expect(relaxed.status).toBe('fulfilled');
    expect(relaxed.status === 'fulfilled' ? relaxed.value.browserSandbox : null).toBe('off');
    await shared.close();
  });

  it('reports the fallback launch error when the unsandboxed launch fails too', async () => {
    const ports = launcher({ sandboxError: NO_SANDBOX, fallbackError: 'fallback launch failed' });
    const shared = makeSharedBrowser({ launch: ports.launch });
    await expect(shared.driver().open('http://app.test/')).rejects.toThrow('fallback launch failed');
    await shared.close();
  });
});

describe('a launch failure that is not about the sandbox', () => {
  it('is not treated as a sandbox failure: no fallback and no refusal', async () => {
    const ports = launcher({ sandboxError: NOT_INSTALLED });
    const shared = makeSharedBrowser({ launch: ports.launch });
    const failed = shared.driver({ browserSandbox: 'require' }).open('http://app.test/');
    await expect(failed).rejects.toThrow("Executable doesn't exist");
    await failed.catch((error: unknown) => {
      expect(isBrowserSandboxRefusal(error)).toBe(false);
    });
    expect(ports.calls).toEqual([{ chromiumSandbox: true }]);

    const relaxed = shared.driver().open('http://app.test/');
    await expect(relaxed).rejects.toThrow("Executable doesn't exist");
    expect(ports.calls).toEqual([{ chromiumSandbox: true }, { chromiumSandbox: true }]);
    await shared.close();
  });
});

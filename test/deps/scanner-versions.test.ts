import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  headlessShellPathFor,
  makeCachedVersionRunner,
  readChromiumVersion,
  readScannerVersions,
  revisionFromBrowserPath,
  runBrowserVersion,
  versionFromBrowserOutput,
} from '../../src/deps/scanner-versions.js';

// The receipt binds the version of the Chromium that scans, so the read has to work on the setups
// teams run: Playwright's own download and a custom PLAYWRIGHT_BROWSERS_PATH. A headless run starts
// Playwright's headless shell, so that is the binary asked. These tests never start a browser or
// run a file: the browser read is injected.

describe('the Chromium version from the browser itself', () => {
  it('reads the version a Chromium build prints for --version', () => {
    expect(versionFromBrowserOutput('Google Chrome for Testing 151.0.7922.34 \n')).toBe('151.0.7922.34');
    expect(versionFromBrowserOutput('Chromium 156.0.8078.73 Built from source for Fedora release 43\n')).toBe(
      '156.0.8078.73',
    );
  });

  it('reads nothing from output that holds no version', () => {
    expect(versionFromBrowserOutput('')).toBeNull();
    expect(versionFromBrowserOutput('Chromium\n')).toBeNull();
    expect(versionFromBrowserOutput('Chromium 156\n')).toBeNull();
  });
});

describe('the Chromium revision from the folder Playwright installed it in', () => {
  it('reads the default and the PLAYWRIGHT_BROWSERS_PATH=0 layouts', () => {
    expect(revisionFromBrowserPath('/home/u/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome')).toBe(
      'revision-1234',
    );
    expect(
      revisionFromBrowserPath('/app/node_modules/playwright-core/.local-browsers/chromium-1234/chrome-linux64/chrome'),
    ).toBe('revision-1234');
    expect(
      revisionFromBrowserPath('C:\\Users\\u\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe'),
    ).toBe('revision-1234');
  });

  it('reads the browser folder, not a part of a custom browsers path that looks like one', () => {
    // The old pattern took the first match anywhere in the path, so this read as revision-2024 and
    // stayed there through every Playwright upgrade.
    expect(revisionFromBrowserPath('/srv/chromium_2024/browsers/chromium-1234/chrome-linux64/chrome')).toBe(
      'revision-1234',
    );
  });

  it('reads the folder Playwright names for a platform with its own build', () => {
    expect(
      revisionFromBrowserPath('/opt/pw/chromium_ubuntu20.04-x64_special-1234/chrome-linux/chrome'),
    ).toBe('revision-1234');
  });

  it('reads nothing from a path with no Playwright browser folder', () => {
    expect(revisionFromBrowserPath('/usr/lib64/chromium-browser/chromium-browser')).toBeNull();
    expect(revisionFromBrowserPath('')).toBeNull();
  });
});

describe('the headless shell beside the full browser', () => {
  // A headless run with no channel launches Playwright's headless shell, from its own folder with
  // the same revision. chromium.executablePath() names the full browser, which does not scan.
  it('finds the headless shell for each platform Playwright ships', () => {
    expect(headlessShellPathFor('/home/u/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome')).toBe(
      '/home/u/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell',
    );
    expect(headlessShellPathFor('/opt/pw/chromium-1234/chrome-linux/chrome')).toBe(
      '/opt/pw/chromium_headless_shell-1234/chrome-linux/headless_shell',
    );
    expect(
      headlessShellPathFor(
        '/Users/u/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      ),
    ).toBe(
      '/Users/u/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',
    );
    expect(
      headlessShellPathFor('C:\\Users\\u\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe'),
    ).toBe(
      'C:\\Users\\u\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1234\\chrome-headless-shell-win64\\chrome-headless-shell.exe',
    );
    expect(headlessShellPathFor('/opt/pw/chromium_ubuntu20.04_x64_special-1234/chrome-linux/chrome')).toBe(
      '/opt/pw/chromium_headless_shell_ubuntu20.04_x64_special-1234/chrome-linux/headless_shell',
    );
  });

  it('reads the browser folder closest to the executable, not a custom path that looks like one', () => {
    expect(headlessShellPathFor('/srv/chromium-2024/browsers/chromium-1234/chrome-linux64/chrome')).toBe(
      '/srv/chromium-2024/browsers/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell',
    );
  });

  it('finds nothing outside Playwright layout', () => {
    expect(headlessShellPathFor('/usr/bin/chromium')).toBeNull();
    expect(headlessShellPathFor('/opt/pw/chromium-1234/some-other-layout/chrome')).toBeNull();
    expect(headlessShellPathFor('')).toBeNull();
  });
});

const FULL = '/opt/browsers/chromium-1234/chrome-linux64/chrome';
const SHELL = '/opt/browsers/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell';

describe('readChromiumVersion', () => {
  it('reads the headless shell that scans, not the full browser Playwright names', async () => {
    // The two folders hold different builds: the full browser was upgraded, the shell was not.
    const asked: string[] = [];
    const version = await readChromiumVersion({
      executablePath: () => FULL,
      isFile: async (path) => path === FULL || path === SHELL,
      runVersion: async (path) => {
        asked.push(path);
        return path === SHELL ? 'Google Chrome for Testing 151.0.7922.34\n' : 'Chromium 156.0.8078.73\n';
      },
    });
    expect(version).toBe('151.0.7922.34');
    expect(asked).toEqual([SHELL]);
  });

  it('falls back to the headless shell folder revision when the shell prints no version', async () => {
    const version = await readChromiumVersion({
      executablePath: () => '/srv/chromium_2024/browsers/chromium-1234/chrome-linux64/chrome',
      isFile: async () => true,
      runVersion: async () => null,
    });
    expect(version).toBe('revision-1234');
  });

  it('is unknown when the headless shell is missing, even though the full browser answers', async () => {
    const asked: string[] = [];
    const version = await readChromiumVersion({
      executablePath: () => FULL,
      isFile: async (path) => path === FULL,
      runVersion: async (path) => {
        asked.push(path);
        return 'Google Chrome for Testing 151.0.7922.34\n';
      },
    });
    expect(version).toBe('unknown');
    expect(asked).toEqual([]);
  });

  it('is unknown when neither the browser nor its path gives a version', async () => {
    await expect(
      readChromiumVersion({
        executablePath: () => '/usr/bin/chromium',
        isFile: async () => true,
        runVersion: async () => 'Chromium 130.0.6723.58',
      }),
    ).resolves.toBe('unknown');
    await expect(
      readChromiumVersion({ executablePath: () => '', isFile: async () => true, runVersion: async () => null }),
    ).resolves.toBe('unknown');
    await expect(
      readChromiumVersion({
        executablePath: () => {
          throw new Error('unsupported platform');
        },
        isFile: async () => true,
        runVersion: async () => null,
      }),
    ).resolves.toBe('unknown');
  });

  it('asks the headless shell under a custom browsers path', async () => {
    // With PLAYWRIGHT_BROWSERS_PATH=/srv/browsers, Playwright names the full browser there, and a
    // headless run starts the shell from the sibling folder. The shell here is a hand-placed build.
    const full = '/srv/browsers/chromium-1234/chrome-linux64/chrome';
    const shell = '/srv/browsers/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell';
    const asked: string[] = [];
    await expect(
      readChromiumVersion({
        executablePath: () => full,
        isFile: async (path) => path === shell,
        runVersion: async (path) => {
          asked.push(path);
          return 'Chromium 130.0.6723.58 built for a distribution\n';
        },
      }),
    ).resolves.toBe('130.0.6723.58');
    expect(asked).toEqual([shell]);
  });

  it('gets no output from a browser path that does not exist', async () => {
    await expect(runBrowserVersion(join(tmpdir(), 'usabl-no-such-browser', 'chrome'))).resolves.toBeNull();
  });
});

describe('the cached browser version read', () => {
  it('asks an unchanged browser once and asks again after the file changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usabl-browser-cache-'));
    try {
      const executable = join(root, 'chrome');
      await writeFile(executable, 'first build', 'utf8');
      let asked = 0;
      const cached = makeCachedVersionRunner(async () => {
        asked += 1;
        return `Chromium 130.0.0.${asked}`;
      });

      await expect(cached(executable)).resolves.toBe('Chromium 130.0.0.1');
      await expect(cached(executable)).resolves.toBe('Chromium 130.0.0.1');
      expect(asked).toBe(1);

      // An upgrade in place writes a new file, so its size or time moves and the browser is asked again.
      await writeFile(executable, 'second, longer build', 'utf8');
      await expect(cached(executable)).resolves.toBe('Chromium 130.0.0.2');
      expect(asked).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not keep an answer for a path it cannot see', async () => {
    let asked = 0;
    const cached = makeCachedVersionRunner(async () => {
      asked += 1;
      return null;
    });
    const missing = join(tmpdir(), 'usabl-no-such-browser', 'chrome');
    await expect(cached(missing)).resolves.toBeNull();
    await expect(cached(missing)).resolves.toBeNull();
    expect(asked).toBe(2);
  });
});

describe('readScannerVersions', () => {
  it('reads every version of the installed tool chain, with the browser read injected', async () => {
    // The packages are read from their package.json. The browser read is a fake, so this unit test
    // starts no browser and runs no file. The real-browser lane checks the real read.
    const asked: string[] = [];
    const versions = await readScannerVersions({
      executablePath: () => FULL,
      isFile: async (path) => path === SHELL,
      runVersion: async (path) => {
        asked.push(path);
        return 'Google Chrome for Testing 151.0.7922.34\n';
      },
    });
    expect(versions.axeCore).toMatch(/^\d+\.\d+\.\d+/);
    expect(versions.playwright).toMatch(/^\d+\.\d+\.\d+/);
    expect(versions.chromium).toBe('151.0.7922.34');
    expect(asked).toEqual([SHELL]);
  });
});

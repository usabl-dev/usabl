import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  headlessShellPathFor,
  headlessShellRevision,
  makeCachedVersionRunner,
  readChromiumVersion,
  readPlaywrightBrowsersList,
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

// The text of a playwright-core browsers.json, with the headless shell at this revision.
function browsersList(shellRevision: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    browsers: [
      { name: 'chromium', revision: '1234', browserVersion: '151.0.7922.34' },
      { name: 'chromium-headless-shell', revision: shellRevision, browserVersion: '151.0.7922.34', ...extra },
      { name: 'chromium-tip-of-tree-headless-shell', revision: '1433' },
    ],
  });
}
const LIST_1234 = async (): Promise<string> => browsersList('1234');

describe("the headless shell's revision from Playwright's list", () => {
  it('reads the chromium-headless-shell entry', () => {
    expect(headlessShellRevision(browsersList('1243'))).toBe('1243');
  });

  it('reads nothing from a list it cannot use', () => {
    expect(headlessShellRevision(null)).toBeNull();
    expect(headlessShellRevision('not json')).toBeNull();
    expect(headlessShellRevision(JSON.stringify({ browsers: [{ name: 'chromium', revision: '1234' }] }))).toBeNull();
    expect(headlessShellRevision(browsersList('12a4'))).toBeNull();
    expect(headlessShellRevision(JSON.stringify({ browsers: 'none' }))).toBeNull();
  });

  it('reads the list inside the installed playwright-core, which names one shell revision', async () => {
    // A package file read only: no browser starts.
    const list = await readPlaywrightBrowsersList();
    expect(list).not.toBeNull();
    expect(headlessShellRevision(list)).toMatch(/^\d+$/);
  });

  it('reads nothing when the entry has a per-platform override, since the platform is not known here', () => {
    expect(headlessShellRevision(browsersList('1234', { revisionOverrides: { 'mac14-arm64': '1200' } }))).toBeNull();
    expect(headlessShellRevision(browsersList('1234', { revisionOverrides: {} }))).toBe('1234');
  });
});

describe('the headless shell beside the full browser', () => {
  // A headless run with no channel launches Playwright's headless shell, from its own folder at its
  // own revision. chromium.executablePath() names the full browser, which does not scan.
  it('finds the headless shell for each platform Playwright ships', () => {
    expect(headlessShellPathFor('/home/u/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', '1234')).toBe(
      '/home/u/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell',
    );
    expect(headlessShellPathFor('/opt/pw/chromium-1234/chrome-linux/chrome', '1234')).toBe(
      '/opt/pw/chromium_headless_shell-1234/chrome-linux/headless_shell',
    );
    expect(
      headlessShellPathFor(
        '/Users/u/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        '1234',
      ),
    ).toBe(
      '/Users/u/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',
    );
    expect(
      headlessShellPathFor('C:\\Users\\u\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe', '1234'),
    ).toBe(
      'C:\\Users\\u\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1234\\chrome-headless-shell-win64\\chrome-headless-shell.exe',
    );
  });

  it("names the shell folder from the shell's own revision, not the full browser's", () => {
    expect(headlessShellPathFor('/opt/pw/chromium-1234/chrome-linux64/chrome', '1243')).toBe(
      '/opt/pw/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',
    );
    expect(headlessShellPathFor('/opt/pw/chromium_ubuntu20.04_x64_special-1200/chrome-linux/chrome', '1234')).toBe(
      '/opt/pw/chromium_headless_shell-1234/chrome-linux/headless_shell',
    );
  });

  it('reads the browser folder closest to the executable, not a custom path that looks like one', () => {
    expect(headlessShellPathFor('/srv/chromium-2024/browsers/chromium-1234/chrome-linux64/chrome', '1234')).toBe(
      '/srv/chromium-2024/browsers/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell',
    );
  });

  it('finds nothing outside Playwright layout', () => {
    expect(headlessShellPathFor('/usr/bin/chromium', '1234')).toBeNull();
    expect(headlessShellPathFor('/opt/pw/chromium-1234/some-other-layout/chrome', '1234')).toBeNull();
    expect(headlessShellPathFor('', '1234')).toBeNull();
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
      readBrowsersList: LIST_1234,
      isFile: async (path) => path === FULL || path === SHELL,
      runVersion: async (path) => {
        asked.push(path);
        return path === SHELL ? 'Google Chrome for Testing 151.0.7922.34\n' : 'Chromium 156.0.8078.73\n';
      },
    });
    expect(version).toBe('151.0.7922.34');
    expect(asked).toEqual([SHELL]);
  });

  it('binds the shell the list names, never an older shell folder left on disk', async () => {
    // Playwright's list names shell revision 1243. The browsers folder still holds the older shell
    // at 1234, the full browser's revision, which Playwright no longer launches.
    const older = SHELL;
    const newer = '/opt/browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
    const answers: Record<string, string> = {
      [older]: 'Google Chrome for Testing 150.0.7800.10\n',
      [newer]: 'Google Chrome for Testing 151.0.7922.34\n',
    };
    const asked: string[] = [];
    const read = (onDisk: string[]) =>
      readChromiumVersion({
        executablePath: () => FULL,
        readBrowsersList: async () => browsersList('1243'),
        isFile: async (path) => onDisk.includes(path),
        runVersion: async (path) => {
          asked.push(path);
          return answers[path] ?? null;
        },
      });
    await expect(read([FULL, older, newer])).resolves.toBe('151.0.7922.34');
    // With the newer shell not installed, the read is unknown, never the older shell's version.
    await expect(read([FULL, older])).resolves.toBe('unknown');
    expect(asked).toEqual([newer]);
  });

  it("is unknown when Playwright's list cannot be read, even with a shell folder on disk", async () => {
    const asked: string[] = [];
    for (const list of [null, 'not json', JSON.stringify({ browsers: [] })]) {
      await expect(
        readChromiumVersion({
          executablePath: () => FULL,
          readBrowsersList: async () => list,
          isFile: async () => true,
          runVersion: async (path) => {
            asked.push(path);
            return 'Google Chrome for Testing 151.0.7922.34\n';
          },
        }),
      ).resolves.toBe('unknown');
    }
    expect(asked).toEqual([]);
  });

  it('falls back to the headless shell folder revision when the shell prints no version', async () => {
    const version = await readChromiumVersion({
      executablePath: () => '/srv/chromium_2024/browsers/chromium-1234/chrome-linux64/chrome',
      readBrowsersList: LIST_1234,
      isFile: async () => true,
      runVersion: async () => null,
    });
    expect(version).toBe('revision-1234');
  });

  it('is unknown when the headless shell is missing, even though the full browser answers', async () => {
    const asked: string[] = [];
    const version = await readChromiumVersion({
      executablePath: () => FULL,
      readBrowsersList: LIST_1234,
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
        readBrowsersList: LIST_1234,
        isFile: async () => true,
        runVersion: async () => 'Chromium 130.0.6723.58',
      }),
    ).resolves.toBe('unknown');
    await expect(
      readChromiumVersion({
        executablePath: () => '',
        readBrowsersList: LIST_1234,
        isFile: async () => true,
        runVersion: async () => null,
      }),
    ).resolves.toBe('unknown');
    await expect(
      readChromiumVersion({
        executablePath: () => {
          throw new Error('unsupported platform');
        },
        readBrowsersList: LIST_1234,
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
        readBrowsersList: LIST_1234,
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
      readBrowsersList: LIST_1234,
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

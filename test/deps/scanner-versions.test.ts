import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  makeCachedVersionRunner,
  readChromiumVersion,
  readScannerVersions,
  revisionFromBrowserPath,
  runBrowserVersion,
  versionFromBrowserOutput,
} from '../../src/deps/scanner-versions.js';

// The receipt binds the Chromium version, so the read has to work on the setups teams run:
// Playwright's own download, a custom PLAYWRIGHT_BROWSERS_PATH, and a system Chromium placed where
// Playwright looks. Before this, the version came only from a pattern on the executable path.

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

describe('readChromiumVersion', () => {
  it('reads a system Chromium by asking it, whatever its path says', async () => {
    const version = await readChromiumVersion({
      executablePath: () => '/opt/browsers/chromium-1234/chrome-linux64/chrome',
      runVersion: async () => 'Chromium 130.0.6723.58 built for a distribution\n',
    });
    expect(version).toBe('130.0.6723.58');
  });

  it('falls back to the folder revision when the browser does not answer', async () => {
    const version = await readChromiumVersion({
      executablePath: () => '/srv/chromium_2024/browsers/chromium-1234/chrome-linux64/chrome',
      runVersion: async () => null,
    });
    expect(version).toBe('revision-1234');
  });

  it('is unknown when neither the browser nor its path gives a version', async () => {
    await expect(
      readChromiumVersion({ executablePath: () => '/usr/bin/chromium', runVersion: async () => 'no version here' }),
    ).resolves.toBe('unknown');
    await expect(readChromiumVersion({ executablePath: () => '', runVersion: async () => null })).resolves.toBe(
      'unknown',
    );
    await expect(
      readChromiumVersion({
        executablePath: () => {
          throw new Error('unsupported platform');
        },
        runVersion: async () => null,
      }),
    ).resolves.toBe('unknown');
  });

  it.skipIf(process.platform === 'win32')('runs the browser at a custom browsers path with --version', async () => {
    // A browsers folder laid out the way Playwright expects, holding a browser that is not
    // Playwright's own: a stand-in for a system Chromium placed there by hand.
    const root = await mkdtemp(join(tmpdir(), 'usabl-browsers-'));
    try {
      const folder = join(root, 'chromium-1234', 'chrome-linux64');
      await mkdir(folder, { recursive: true });
      const executable = join(folder, 'chrome');
      await writeFile(
        executable,
        '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Chromium 130.0.6723.58 built for a distribution"; fi\n',
        'utf8',
      );
      await chmod(executable, 0o755);

      await expect(runBrowserVersion(executable)).resolves.toContain('130.0.6723.58');
      await expect(readChromiumVersion({ executablePath: () => executable, runVersion: runBrowserVersion })).resolves.toBe(
        '130.0.6723.58',
      );
      // A path that does not exist gives no output, so the folder revision is used.
      const missing = join(root, 'chromium-1243', 'chrome-linux64', 'chrome');
      await expect(runBrowserVersion(missing)).resolves.toBeNull();
      await expect(readChromiumVersion({ executablePath: () => missing, runVersion: runBrowserVersion })).resolves.toBe(
        'revision-1243',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
  it('reads every version of the installed tool chain', async () => {
    const versions = await readScannerVersions();
    expect(versions.axeCore).toMatch(/^\d+\.\d+\.\d+/);
    expect(versions.playwright).toMatch(/^\d+\.\d+\.\d+/);
    expect(versions.chromium).not.toBe('unknown');
  });
});

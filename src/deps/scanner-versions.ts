/**
 * Reads the versions of the scanners a receipt binds: axe-core, Playwright, and the Chromium that
 * Playwright launches. This unit reads versions only. It never decides a verdict or a receipt.
 *
 * A version it cannot read is UNREADABLE_SCANNER_VERSION. The run turns that into a not-covered
 * gap and mints no receipt, and doctor reports it, so a read that fails is never silent.
 */
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { UNREADABLE_SCANNER_VERSION } from "../evidence/receipt.js";

const require = createRequire(import.meta.url);

function readVersion(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** The version in a package's package.json, as the run resolves the package. */
export function readDependencyVersion(packageName: string): string {
  try {
    const pkg: unknown = require(`${packageName}/package.json`);
    return (
      readVersion(typeof pkg === "object" && pkg !== null ? Reflect.get(pkg, "version") : null) ??
      UNREADABLE_SCANNER_VERSION
    );
  } catch {
    return UNREADABLE_SCANNER_VERSION;
  }
}

/** The four-part version a Chromium build prints for --version, such as 151.0.7922.34. */
export function versionFromBrowserOutput(output: string): string | null {
  return /\b(\d+\.\d+\.\d+\.\d+)\b/.exec(output)?.[1] ?? null;
}

// The folder Playwright installs a Chromium build in: chromium-1234, or, on a platform with its own
// build, chromium_<platform>_special-1234. Older Playwright releases used an underscore.
const BROWSER_FOLDER = /^chromium(?:_[a-z0-9.-]+_special)?[-_](\d+)$/i;

/**
 * The revision named by the browser folder in an executable path, or null. It reads the folder
 * closest to the executable, so a custom browsers path whose own name looks like a browser folder
 * is not mistaken for one.
 */
export function revisionFromBrowserPath(executablePath: string): string | null {
  const segments = executablePath.split(/[\\/]+/);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const match = BROWSER_FOLDER.exec(segments[index] ?? "");
    if (match?.[1] !== undefined) {
      return `revision-${match[1]}`;
    }
  }
  return null;
}

/**
 * Runs a browser executable with --version and returns what it printed, or null when it could not
 * run, failed, or took too long. No shell is used, and the path is passed as the program itself.
 */
export function runBrowserVersion(executablePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      executablePath,
      ["--version"],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true },
      (error, stdout) => {
        resolve(error === null && typeof stdout === "string" ? stdout : null);
      },
    );
  });
}

/**
 * Wraps a version runner so one process asks each browser file once. Every stop, every overlay
 * save, and every check builds its deps, and starting the browser each time costs real time.
 *
 * The answer is kept by the file's identity (device, inode, size, and modification time, read
 * through any symlink), never by its path alone. A browser upgraded in place is a new file, so it
 * is asked again. A path it cannot stat keeps no answer.
 */
export function makeCachedVersionRunner(
  run: (executablePath: string) => Promise<string | null>,
): (executablePath: string) => Promise<string | null> {
  const answers = new Map<string, Promise<string | null>>();
  return async (executablePath) => {
    let identity: string;
    try {
      const info = await stat(executablePath);
      identity = JSON.stringify([executablePath, info.dev, info.ino, info.size, info.mtimeMs]);
    } catch {
      return run(executablePath);
    }
    const known = answers.get(identity);
    if (known !== undefined) {
      return known;
    }
    const answer = run(executablePath);
    answers.set(identity, answer);
    return answer;
  };
}

export interface ChromiumVersionPorts {
  // Where Playwright looks for its Chromium. It honors PLAYWRIGHT_BROWSERS_PATH.
  executablePath: () => string;
  runVersion: (executablePath: string) => Promise<string | null>;
}

const REAL_PORTS: ChromiumVersionPorts = {
  executablePath: () => chromium.executablePath(),
  runVersion: makeCachedVersionRunner(runBrowserVersion),
};

/**
 * The Chromium version, read in this order:
 *
 * 1. What the browser at Playwright's Chromium path prints for --version. This is the browser's own
 *    word, so it is right for Playwright's download, for a custom PLAYWRIGHT_BROWSERS_PATH, and for
 *    a system Chromium placed where Playwright looks, whose path says nothing about its version.
 * 2. The revision in the name of the folder Playwright installed it in, when the browser gives no
 *    version (Chrome on Windows prints none, and an install with only the headless shell has no
 *    browser at this path).
 * 3. UNREADABLE_SCANNER_VERSION.
 *
 * Limit: Playwright launches its headless shell for a headless run, from a sibling folder with the
 * same revision. Playwright's own builds of the two always share a version, so the read stands for
 * both. A setup that puts a different browser only in the headless shell folder is not seen here.
 */
export async function readChromiumVersion(ports: ChromiumVersionPorts = REAL_PORTS): Promise<string> {
  let executablePath: string;
  try {
    executablePath = ports.executablePath();
  } catch {
    return UNREADABLE_SCANNER_VERSION;
  }
  if (typeof executablePath !== "string" || executablePath.length === 0) {
    return UNREADABLE_SCANNER_VERSION;
  }
  const output = await ports.runVersion(executablePath);
  const version = output === null ? null : versionFromBrowserOutput(output);
  if (version !== null) {
    return version;
  }
  return revisionFromBrowserPath(executablePath) ?? UNREADABLE_SCANNER_VERSION;
}

/** The core scanner versions a receipt binds. Optional engine versions are read elsewhere. */
export async function readScannerVersions(): Promise<{ axeCore: string; playwright: string; chromium: string }> {
  return {
    axeCore: readDependencyVersion("axe-core"),
    playwright: readDependencyVersion("playwright"),
    chromium: await readChromiumVersion(),
  };
}

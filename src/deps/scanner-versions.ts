/**
 * Reads the versions of the scanners a receipt binds: axe-core, Playwright, and the Chromium that
 * Playwright launches. This unit reads versions only. It never decides a verdict or a receipt.
 *
 * A version it cannot read is UNREADABLE_SCANNER_VERSION. The run turns that into a not-covered
 * gap and mints no receipt, and doctor reports it, so a read that fails is never silent.
 */
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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
// build, chromium_<platform>_special-1234. The headless shell's folder is the same with
// chromium_headless_shell in front. Older Playwright releases used an underscore before the number.
const BROWSER_FOLDER = /^chromium(?:_headless_shell)?(?:_[a-z0-9._-]+_special)?[-_](\d+)$/i;
const FULL_BROWSER_FOLDER = /^chromium(?:_[a-z0-9._-]+_special)?-\d+$/i;

// Where the headless shell's executable sits inside its folder, keyed by the folder the full
// browser's executable sits in. This is Playwright's own layout for each platform it ships.
const HEADLESS_SHELL_FILES: Readonly<Record<string, readonly string[]>> = {
  "chrome-linux64": ["chrome-headless-shell-linux64", "chrome-headless-shell"],
  "chrome-linux": ["chrome-linux", "headless_shell"],
  "chrome-mac-x64": ["chrome-headless-shell-mac-x64", "chrome-headless-shell"],
  "chrome-mac-arm64": ["chrome-headless-shell-mac-arm64", "chrome-headless-shell"],
  "chrome-win64": ["chrome-headless-shell-win64", "chrome-headless-shell.exe"],
};

/**
 * The headless shell's revision, read from the text of the `browsers.json` that ships inside the
 * installed playwright-core package, or null. Playwright gives each browser its own revision, so
 * the shell's revision is never taken from the full browser's folder. A per-platform override
 * would need the host platform Playwright computes inside an internal module, so an entry that
 * has any override is read as null too: usabl cannot tell which revision applies.
 */
export function headlessShellRevision(browsersList: string | null): string | null {
  if (browsersList === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(browsersList);
  } catch {
    return null;
  }
  const browsers: unknown = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "browsers") : null;
  if (!Array.isArray(browsers)) {
    return null;
  }
  const entries = browsers.filter(
    (entry: unknown) => typeof entry === "object" && entry !== null && Reflect.get(entry, "name") === "chromium-headless-shell",
  );
  if (entries.length !== 1) {
    return null;
  }
  const entry = entries[0] as object;
  const overrides: unknown = Reflect.get(entry, "revisionOverrides");
  if (overrides !== undefined && (typeof overrides !== "object" || overrides === null || Object.keys(overrides).length > 0)) {
    return null;
  }
  const revision: unknown = Reflect.get(entry, "revision");
  return typeof revision === "string" && /^\d+$/.test(revision) ? revision : null;
}

/**
 * The path of the headless shell Playwright installs for this revision, in the same browsers folder
 * as the full browser at this path, or null when the path is not in Playwright's layout. A headless
 * launch with no channel starts the headless shell, not the full browser that
 * `chromium.executablePath()` names. Playwright gives the shell's path only through an internal
 * module, so it is built here from the browsers folder, the shell's own revision (see
 * headlessShellRevision), and Playwright's file layout. The caller checks that the file exists.
 */
export function headlessShellPathFor(fullBrowserPath: string, shellRevision: string): string | null {
  const separator = fullBrowserPath.includes("\\") && !fullBrowserPath.includes("/") ? "\\" : "/";
  const segments = fullBrowserPath.split(/[\\/]+/);
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const folder = segments[index] ?? "";
    if (!FULL_BROWSER_FOLDER.test(folder)) {
      continue;
    }
    const inner = HEADLESS_SHELL_FILES[segments[index + 1] ?? ""];
    if (inner === undefined) {
      return null;
    }
    return [...segments.slice(0, index), `chromium_headless_shell-${shellRevision}`, ...inner].join(separator);
  }
  return null;
}

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
  // Where Playwright looks for its full Chromium. It honors PLAYWRIGHT_BROWSERS_PATH. The headless
  // shell the run launches is found in the same browsers folder.
  executablePath: () => string;
  // The text of the browsers.json inside the playwright-core that Playwright runs, or null.
  readBrowsersList: () => Promise<string | null>;
  isFile: (path: string) => Promise<boolean>;
  runVersion: (executablePath: string) => Promise<string | null>;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The browsers.json of the playwright-core package that the installed playwright package loads.
 * The folder is found through each package's exported package.json, so no internal module is
 * imported. Any failure is null, which makes the version unreadable.
 */
export async function readPlaywrightBrowsersList(): Promise<string | null> {
  try {
    const playwrightRequire = createRequire(require.resolve("playwright/package.json"));
    const corePackage = playwrightRequire.resolve("playwright-core/package.json");
    return await readFile(join(dirname(corePackage), "browsers.json"), "utf8");
  } catch {
    return null;
  }
}

const REAL_PORTS: ChromiumVersionPorts = {
  executablePath: () => chromium.executablePath(),
  readBrowsersList: readPlaywrightBrowsersList,
  isFile,
  runVersion: makeCachedVersionRunner(runBrowserVersion),
};

/**
 * The version of the Chromium that scans. A run launches Chromium headless with no channel, and
 * Playwright starts its headless shell for that, so the headless shell is what is read, in this
 * order:
 *
 * 1. What the headless shell prints for --version. This is the binary's own word, so it is right
 *    for Playwright's download and for a custom PLAYWRIGHT_BROWSERS_PATH, and it changes when the
 *    binary in that folder is replaced.
 * 2. The revision in the name of the headless shell's folder, as `revision-<number>`, when the
 *    binary prints no version (Chrome on Windows prints none). It never looks like a real version.
 * 3. UNREADABLE_SCANNER_VERSION, when the headless shell cannot be found: Playwright's list of
 *    browsers cannot be read or names no single revision for it, or its folder is not on disk. The
 *    full browser's version is never used in its place, because that binary does not scan in a
 *    headless run, and neither is any other shell folder on disk, because an older one can stay
 *    installed beside the one Playwright launches.
 */
export async function readChromiumVersion(ports: ChromiumVersionPorts = REAL_PORTS): Promise<string> {
  let fullBrowserPath: string;
  try {
    fullBrowserPath = ports.executablePath();
  } catch {
    return UNREADABLE_SCANNER_VERSION;
  }
  if (typeof fullBrowserPath !== "string" || fullBrowserPath.length === 0) {
    return UNREADABLE_SCANNER_VERSION;
  }
  const shellRevision = headlessShellRevision(await ports.readBrowsersList());
  if (shellRevision === null) {
    return UNREADABLE_SCANNER_VERSION;
  }
  const shellPath = headlessShellPathFor(fullBrowserPath, shellRevision);
  if (shellPath === null || !(await ports.isFile(shellPath))) {
    return UNREADABLE_SCANNER_VERSION;
  }
  const output = await ports.runVersion(shellPath);
  const version = output === null ? null : versionFromBrowserOutput(output);
  if (version !== null) {
    return version;
  }
  return revisionFromBrowserPath(shellPath) ?? UNREADABLE_SCANNER_VERSION;
}

/** The core scanner versions a receipt binds. Optional engine versions are read elsewhere. */
export async function readScannerVersions(
  ports: ChromiumVersionPorts = REAL_PORTS,
): Promise<{ axeCore: string; playwright: string; chromium: string }> {
  return {
    axeCore: readDependencyVersion("axe-core"),
    playwright: readDependencyVersion("playwright"),
    chromium: await readChromiumVersion(ports),
  };
}

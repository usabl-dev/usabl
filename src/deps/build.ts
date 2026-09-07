/**
 * Real Deps builder for the live `usabl check` CLI path.
 * This unit wires adapters and providers only and must never decide verdicts.
 * Browser launch stays lazy so normal checks and type/test workflows do not open Chromium.
 */
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { BrowserDriver, Capability, Deps, UsablConfig } from "../contracts/index.js";
import { canonicalHash, sha256 } from "../primitives/canonical.js";
import { sortBy } from "../primitives/sortKey.js";
import { makeCheckRunner } from "../providers/check-runner.js";
import { makeCoreProviders } from "../providers/core-stack.js";
import { makeStepRunner } from "../providers/keyboard-walk/steps.js";
import { loadRequirements } from "../intake/load.js";
import { mapRequirementsToProviders } from "../intake/map-to-providers.js";
import { overlayRequirementsFs } from "../intake/overlay-fs.js";
import { resolveIntakeConfig } from "../intake/trusted-config.js";
import { makeRealBrowserDriver, type RealBrowserOptions } from "./real.js";
import { makeGitReader } from "./git.js";
import { makeFsGlob } from "./fs.js";
import { resolveStorageStatePath, type EnvReader } from "./session.js";

const require = createRequire(import.meta.url);
const RUNNER_PACKAGE_PATHS = [
  // Built entries and chunks live in dist/.
  fileURLToPath(new URL("../package.json", import.meta.url)),
  // Source imports during Vitest live in src/deps/.
  fileURLToPath(new URL("../../package.json", import.meta.url)),
];

function readVersion(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

async function readPackageVersion(): Promise<string> {
  for (const path of RUNNER_PACKAGE_PATHS) {
    try {
      const raw = await readFile(path, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error("package.json must be a JSON object");
      }
      const version = readVersion(Reflect.get(parsed, "version"));
      if (version === null) {
        throw new Error("package.json missing version");
      }
      return version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  throw new Error(
    "usabl package.json was not found beside the source or built package",
  );
}

/**
 * Deterministic digest over the engine's own files. `runnerVersion` embeds this digest,
 * so a change to any shipped engine file moves the receipt fingerprint (ground-truth §10):
 * a receipt minted by one engine build cannot re-verify under a tampered or upgraded engine.
 * Pure and order-independent so trust never depends on directory-walk order.
 */
export function hashEngineFiles(
  files: Array<{ path: string; content: string }>,
): string {
  const fingerprints = sortBy(
    files.map((file) => [file.path, sha256(file.content)] as const),
    ([path]) => path,
  );
  return canonicalHash(fingerprints);
}

/**
 * The path is part of the hashed tuple and the sort key. `path.relative` emits `\` on
 * win32, so without this a receipt minted on one OS would falsely fail re-verification on
 * another. Normalize to `/` so the fingerprint is the same bytes on every platform.
 */
export function normalizeSeparators(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Resolve the on-disk engine root and the extension that marks engine code.
 * Built package: this module is a bundled chunk in `dist/`; engine files are `dist/*.js`.
 * Source or test run: this module is `src/deps/build.ts`; engine files are `src` tree `*.ts`.
 */
function resolveEngineScope(): { root: string; extension: string } {
  const selfDir = dirname(fileURLToPath(import.meta.url));
  if (basename(selfDir) === "deps" && basename(dirname(selfDir)) === "src") {
    return { root: dirname(selfDir), extension: ".ts" };
  }
  return { root: selfDir, extension: ".js" };
}

export async function collectEngineFiles(
  root: string,
  extension: string,
): Promise<Array<{ path: string; content: string }>> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  const files: Array<{ path: string; content: string }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(extension)) {
      continue;
    }
    const absolute = join(entry.parentPath, entry.name);
    files.push({
      path: normalizeSeparators(relative(root, absolute)),
      content: await readFile(absolute, "utf8"),
    });
  }
  return files;
}

async function readEngineHash(): Promise<string> {
  const { root, extension } = resolveEngineScope();
  const files = await collectEngineFiles(root, extension);
  if (files.length === 0) {
    // Fail closed: a receipt that cannot bind the engine would be a false proof.
    throw new Error(`usabl engine files were not found under ${root}`);
  }
  return hashEngineFiles(files);
}

async function readRunnerVersion(): Promise<string> {
  const [version, engineHash] = await Promise.all([
    readPackageVersion(),
    readEngineHash(),
  ]);
  return `${version}+${engineHash}`;
}

function readDependencyVersion(packageName: string): string {
  try {
    const pkg: unknown = require(`${packageName}/package.json`);
    return (
      readVersion(
        typeof pkg === "object" && pkg !== null
          ? Reflect.get(pkg, "version")
          : null,
      ) ?? "unknown"
    );
  } catch {
    return "unknown";
  }
}

function readChromiumVersion(): string {
  try {
    const executablePath = chromium.executablePath();
    const revisionMatch = /chromium[-_](\d+)/i.exec(executablePath);
    if (revisionMatch?.[1] !== undefined) {
      return `revision-${revisionMatch[1]}`;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

export async function buildDeps(
  config: UsablConfig,
  options: {
    cwd?: string;
    allowedCapabilities?: Capability[];
    storageStatePath?: string;
    trustedRef?: string;
    env?: EnvReader;
    // A caller can supply the browser driver so one warm Chromium serves many runs. The dev overlay
    // does this: it builds fresh Deps on every save for correct git and intake state, but keeps one
    // browser process. The factory receives the options this function resolved for the run, the
    // authenticated storage state and the readiness budget, so a driver that outlives one run still
    // opens every context with this run's session and this run's budget. Each open still makes a
    // fresh context, so run isolation is unchanged. When omitted, a driver is created per call and
    // the caller closes it, which is the CLI's one-shot behavior.
    browserFor?: (options: RealBrowserOptions) => BrowserDriver;
  } = {},
): Promise<Deps> {
  const cwd = options.cwd ?? process.cwd();
  const allowedCapabilities = options.allowedCapabilities ?? ["live"];
  // Every operator surface funnels through here, so this is the one place a session has to
  // be picked up for the CLI, the Vite overlay, and the Stop hook to all reach a login-gated
  // screen. The environment defaults like cwd does, and stays injectable for tests.
  const storageStatePath = await resolveStorageStatePath({
    explicit: options.storageStatePath,
    env: options.env ?? process.env,
  });
  const browserOptions: RealBrowserOptions = {
    ...(storageStatePath === null ? {} : { storageStatePath }),
    // The operator's app is what decides how long a screen takes to render, so the budget rides
    // the config the run was started with.
    ...(config.readyTimeoutMs === undefined
      ? {}
      : { readyTimeoutMs: config.readyTimeoutMs }),
  };
  const browser =
    options.browserFor === undefined
      ? makeRealBrowserDriver(browserOptions)
      : options.browserFor(browserOptions);
  const fs = makeFsGlob({ cwd });
  const git = makeGitReader({ cwd });
  const intakeConfig = await resolveIntakeConfig(
    git,
    config,
    options.trustedRef,
  );
  const intakeFs = overlayRequirementsFs(
    fs,
    git,
    intakeConfig,
    options.trustedRef,
  );
  const loadedRequirements = await loadRequirements(intakeFs, intakeConfig);
  const providers = makeCoreProviders();
  if (loadedRequirements.ok) {
    providers.push(...mapRequirementsToProviders(loadedRequirements.bundle));
  }
  // Intake parse failure is policy input failure, not an engine crash.
  // We keep building Deps so run() can fail closed through the gate path.

  return {
    clock: () => new Date().toISOString(),
    runnerVersion: await readRunnerVersion(),
    scannerVersions: {
      axeCore: readDependencyVersion("axe-core"),
      playwright: readDependencyVersion("playwright"),
      chromium: readChromiumVersion(),
    },
    browser,
    git,
    fs,
    // Expose the same bundle the providers were built from. Failed intake yields the empty
    // bundle here so the docs surface renders transcript artifacts without inventing content.
    requirements: loadedRequirements.ok
      ? loadedRequirements.bundle
      : { version: 1, requirements: [] },
    checkRunner: makeCheckRunner({
      browser,
      providers,
      config: intakeConfig,
      // Static-only mode denies live capability explicitly so the result records not-covered gaps.
      allowedCapabilities,
      stepRunner: makeStepRunner(),
      // The one place that knows whether this run asserted a session. Every gating surface builds
      // its Deps here, so setting it once covers the CLI, the Vite overlay, and the Stop hook.
      sessionConfigured: storageStatePath !== null,
    }),
  };
}

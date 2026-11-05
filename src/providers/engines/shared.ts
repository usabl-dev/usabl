/**
 * Shared seams for the optional commercial engines (Deque axe DevTools, Evinced).
 * The vendor packages are never dependencies of usabl. Each one is loaded by a dynamic import only
 * when the trusted config turns its engine on, through a loader a test can replace with a fake.
 * Every failure here is thrown with a reason and a fix, so the provider seam records a coverage
 * gap. Every vendor call is bounded by a timeout, so a hung license server becomes a named gap and
 * never a stalled run. Nothing here mints a verdict, and nothing here lets a credential reach a
 * message.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvidenceClass, Page, ProviderNote, ProviderOutput } from '../../contracts/index.js';

// The Playwright page behind each usabl page the real browser driver made. A vendor SDK drives the
// Playwright page itself, so an engine provider needs it. It is kept here rather than on the page,
// so it never appears in a copy of a page, in a serialized one, or in the Provider contract, and a
// page cannot claim one by naming a property. Fake pages are never registered, and an engine
// provider handed one refuses to run rather than reporting a clean page it never saw.
const playwrightPages = new WeakMap<Page, unknown>();

/** Records the Playwright page behind a usabl page. Only the real browser driver calls this. */
export function registerPlaywrightPage(page: Page, playwrightPage: unknown): void {
  playwrightPages.set(page, playwrightPage);
}

/** The Playwright page registered for this usabl page, or null when there is none. */
export function playwrightPageOf(page: Page): unknown {
  return playwrightPages.get(page) ?? null;
}

export type ModuleLoader = () => Promise<unknown>;

/** Whether findings of this class can move the verdict. The gate's rule: only deterministic gates. */
export function classGates(evidenceClass: EvidenceClass): boolean {
  return evidenceClass === 'deterministic';
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * The output of an engine that could not run while its findings cannot gate. A disclosure that can
 * never change the verdict must not block a pull request, and a vendor's license server that is
 * down must not block every pull request, so the failure is one note on the provider, and the
 * screen stays cleanly scanned. When the class gates, the caller throws instead, and the provider
 * seam records the same failure as a not-covered gap.
 */
export function couldNotRunOutput(providerId: string, message: string): ProviderOutput & { notes: ProviderNote[] } {
  return {
    drafts: [],
    notes: [
      {
        ref: `provider:${providerId}`,
        reason: `provider ${providerId} did not run: ${sentence(message)} Its findings are preview, so this does not change the verdict.`,
      },
    ],
  };
}

/**
 * Plain words for one engine, used in every message an operator reads about it. configKey is the
 * config path that turns the engine off, which is always a valid way out.
 */
export interface EngineLabel {
  vendor: string;
  packageName: string;
  configKey: string;
  registry: string;
}

// How long one vendor call may take: loading the package, setting credentials, or analyzing one
// screen. It only has to bound a call that never answers, such as a license server that accepts the
// connection and then says nothing. It matches the budget axe gets for one step in one frame, which
// is far above what a large screen measured under load.
export const ENGINE_CALL_TIMEOUT_MS = 60_000;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | null {
  const code: unknown = error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  return typeof code === 'string' ? code : null;
}

/** A vendor call that did not settle within its budget. Its message is complete as it stands. */
export class EngineTimeoutError extends Error {}

function describeBudget(ms: number): string {
  return ms >= 1_000 && ms % 1_000 === 0 ? `${ms / 1_000} seconds` : `${ms} ms`;
}

/**
 * Waits for one vendor call, at most timeoutMs. A call that does not settle in time rejects with a
 * message that names the engine and the step. The call itself cannot be cancelled, so a rejection it
 * makes later is caught here and dropped: the run has already disclosed the gap, and an unhandled
 * rejection would end the process.
 */
export async function withEngineTimeout<T>(
  label: EngineLabel,
  step: string,
  call: Promise<T>,
  timeoutMs: number = ENGINE_CALL_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new EngineTimeoutError(
          `${label.vendor} did not finish ${step} within ${describeBudget(timeoutMs)}, so it checked nothing on this screen. Check its license server and the page, or set ${label.configKey}.enabled to false.`,
        ),
      );
    }, timeoutMs);
    timer.unref();
  });
  call.catch(() => {});
  try {
    return await Promise.race([call, expired]);
  } finally {
    clearTimeout(timer);
  }
}

// ---- finding the vendor package the way the dynamic import does ----

export interface PackageProbeFs {
  isDirectory(path: string): Promise<boolean>;
  readFile(path: string): Promise<string | null>;
}

export type InstalledPackage =
  | { state: 'not-installed' }
  | { state: 'installed'; version: string; missingDependencies: string[] };

const realFs: PackageProbeFs = {
  async isDirectory(path) {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  },
  async readFile(path) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  },
};

/**
 * The folders the dynamic import looks in for a bare package name, nearest first: node_modules in
 * the starting folder and in every folder above it. Node's ES module resolver reads only these. It
 * never reads NODE_PATH or the global folders that require() also searches, so a copy found only
 * there would load under require() and still fail the import. Pure.
 */
export function packageLookupDirs(packageName: string, fromDir: string): string[] {
  const dirs: string[] = [];
  let current = fromDir;
  for (;;) {
    dirs.push(join(current, 'node_modules', packageName));
    const parent = dirname(current);
    if (parent === current) {
      return dirs;
    }
    current = parent;
  }
}

async function findPackageDir(packageName: string, fromDir: string, fs: PackageProbeFs): Promise<string | null> {
  for (const dir of packageLookupDirs(packageName, fromDir)) {
    if (await fs.isDirectory(dir)) {
      return dir;
    }
  }
  return null;
}

function stringKeys(value: unknown): string[] {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
}

// The packages a vendor package needs at load: its dependencies, and the peers it does not mark
// optional. Read from its package.json. Anything unreadable reads as needing nothing.
function neededPackages(manifest: unknown): string[] {
  const dependencies = stringKeys(manifest !== null && typeof manifest === 'object' ? Reflect.get(manifest, 'dependencies') : undefined);
  const peers = stringKeys(manifest !== null && typeof manifest === 'object' ? Reflect.get(manifest, 'peerDependencies') : undefined);
  const meta: unknown = manifest !== null && typeof manifest === 'object' ? Reflect.get(manifest, 'peerDependenciesMeta') : undefined;
  const optionalPeer = (name: string): boolean => {
    const entry: unknown = meta !== null && typeof meta === 'object' ? Reflect.get(meta, name) : undefined;
    return entry !== null && typeof entry === 'object' && Reflect.get(entry, 'optional') === true;
  };
  return [...new Set([...dependencies, ...peers.filter((name) => !optionalPeer(name))])].sort();
}

// The folder this module is in, as Node sees it. Node resolves an import from the real path of the
// importing file, not from a symlink to it, so the search starts there too.
async function ownDir(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    return await realpath(here);
  } catch {
    return here;
  }
}

/**
 * Whether a vendor package is installed where the dynamic import in this module would find it, its
 * version, and which packages it needs that do not resolve from where it is. Read from disk only:
 * no vendor code runs. A package that resolves and then throws while loading is not caught here;
 * the run reports that as "failed to load".
 */
export async function probeInstalledPackage(
  packageName: string,
  options: { fromDir?: string; fs?: PackageProbeFs } = {},
): Promise<InstalledPackage> {
  const fs = options.fs ?? realFs;
  const fromDir = options.fromDir ?? (await ownDir());
  const dir = await findPackageDir(packageName, fromDir, fs);
  if (dir === null) {
    return { state: 'not-installed' };
  }
  const raw = await fs.readFile(join(dir, 'package.json'));
  let manifest: unknown = null;
  if (raw !== null) {
    try {
      manifest = JSON.parse(raw);
    } catch {
      manifest = null;
    }
  }
  const rawVersion: unknown = manifest !== null && typeof manifest === 'object' ? Reflect.get(manifest, 'version') : undefined;
  const version = typeof rawVersion === 'string' && rawVersion.trim().length > 0 ? rawVersion.trim() : 'unknown';
  const missingDependencies: string[] = [];
  for (const needed of neededPackages(manifest)) {
    if ((await findPackageDir(needed, dir, fs)) === null) {
      missingDependencies.push(needed);
    }
  }
  return { state: 'installed', version, missingDependencies };
}

/**
 * Imports a vendor package from this module, so the import and probeInstalledPackage start from the
 * same folder. The name is a variable on purpose: the bundler must leave the import to run time,
 * because the package is not a dependency and is absent when usabl is built.
 */
export function importPackage(packageName: string): Promise<unknown> {
  return import(/* @vite-ignore */ packageName);
}

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

// The package a not-found error names, when it names a bare package. "Cannot find package 'x'" is
// what the ES module resolver says, and "Cannot find module 'x'" is what require() says inside a
// CommonJS package. A file path or anything that is not a package name reads as null.
function missingPackageNamed(error: unknown): string | null {
  const code = errorCode(error);
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') {
    return null;
  }
  const match = /Cannot find (?:package|module) '([^']+)'/.exec(errorMessage(error));
  if (match?.[1] === undefined) {
    return null;
  }
  const parts = match[1].split('/');
  const name = match[1].startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '');
  return PACKAGE_NAME.test(name) ? name : null;
}

function listNames(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export interface LoadEngineOptions {
  load: ModuleLoader;
  probe: (packageName: string) => Promise<InstalledPackage>;
  redact: (text: string) => string;
  timeoutMs?: number;
}

/**
 * Loads a vendor package and turns every way that can fail into a message with the fix. Three
 * cases read differently because they have different fixes: the package is not installed, the
 * package is installed and a package it needs is not, and the package is installed and throws.
 */
export async function loadEngineModule(label: EngineLabel, options: LoadEngineOptions): Promise<unknown> {
  try {
    return await withEngineTimeout(label, `loading ${label.packageName}`, options.load(), options.timeoutMs);
  } catch (error) {
    const missing = missingPackageNamed(error);
    const installed = await options.probe(label.packageName);
    if (installed.state === 'not-installed' || missing === label.packageName) {
      throw new Error(
        `${label.vendor} is turned on in usabl.config.json but ${label.packageName} is not installed. Install it from ${label.registry}, or set ${label.configKey}.enabled to false.`,
      );
    }
    const absent = missing !== null ? [missing] : installed.missingDependencies;
    if (absent.length > 0) {
      const which =
        absent.length === 1
          ? `${listNames(absent)}, a package it needs, is not installed`
          : `${listNames(absent)}, packages it needs, are not installed`;
      throw new Error(
        `${label.packageName} ${installed.version} is installed but could not load, because ${which}. Reinstall ${label.packageName} with its dependencies, or set ${label.configKey}.enabled to false.`,
      );
    }
    throw new Error(
      `${label.packageName} ${installed.version} is installed but failed to load: ${options.redact(errorMessage(error))}. Check the installed version, or set ${label.configKey}.enabled to false.`,
    );
  }
}

/**
 * Reads a named export from a loaded module. An ES module import of a CommonJS package puts the
 * exports on `default`, so both places are checked. Returns undefined when neither has it.
 */
export function pickExport(module: unknown, name: string): unknown {
  if (module === null || (typeof module !== 'object' && typeof module !== 'function')) {
    return undefined;
  }
  const direct: unknown = Reflect.get(module, name);
  if (direct !== undefined) {
    return direct;
  }
  const fallback: unknown = Reflect.get(module, 'default');
  if (fallback === null || (typeof fallback !== 'object' && typeof fallback !== 'function')) {
    return undefined;
  }
  return Reflect.get(fallback, name);
}

export function missingExportError(label: EngineLabel, exportName: string): Error {
  return new Error(
    `${label.packageName} loaded but does not export ${exportName}, which usabl needs to run ${label.vendor}. Check the installed version, or set ${label.configKey}.enabled to false.`,
  );
}

export function notLivePageError(label: EngineLabel): Error {
  return new Error(`${label.vendor} needs a live browser page, and this scan has no Playwright page behind it.`);
}

/**
 * Refuses to run while a switch outside the trusted config could make the engine report nothing. A
 * switched-off engine returns an empty result, and an empty result reads as a clean screen. Each
 * environment variable must be unset or hold its safe value. Each file must be absent from the
 * working folder or listed in guardedPaths, so changing it needs owner approval.
 */
export async function assertNoOutsideSwitch(
  label: EngineLabel,
  switches: {
    env: Readonly<Record<string, string | undefined>>;
    variables: ReadonlyArray<{ name: string; safe: string | null; why: string }>;
    files: readonly string[];
    why: string;
    guardedPaths: readonly string[];
    cwd: string;
    fileExists: (path: string) => Promise<boolean>;
  },
): Promise<void> {
  for (const variable of switches.variables) {
    const value = switches.env[variable.name];
    if (value !== undefined && value !== variable.safe) {
      const fix = variable.safe === null ? `unset ${variable.name}` : `unset ${variable.name} or set it to ${variable.safe}`;
      throw new Error(
        `${variable.name} is set${variable.safe === null ? '' : ` to a value other than ${variable.safe}`}, which ${variable.why}. To fix it, ${fix}, or set ${label.configKey}.enabled to false.`,
      );
    }
  }
  for (const name of switches.files) {
    if (switches.guardedPaths.includes(name)) {
      continue;
    }
    if (await switches.fileExists(join(switches.cwd, name))) {
      throw new Error(
        `${name} is in the project and ${switches.why}, but it is not guarded. To fix it, remove it, or add it to guardedPaths so changing it needs owner approval.`,
      );
    }
  }
}

export async function defaultFileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The open-source axe-core rule ids, read from the axe-core package usabl already runs. Both engines
 * bundle these rules, and usabl's own axe provider already reports them, so an engine's copy is
 * dropped (Deque) or switched off (Evinced) to keep one barrier from being reported twice.
 */
export async function openSourceAxeRuleIds(): Promise<ReadonlySet<string>> {
  const axe: unknown = await import('axe-core');
  const getRules = pickExport(axe, 'getRules');
  if (typeof getRules !== 'function') {
    throw new Error('axe-core does not export getRules, so usabl cannot tell which engine rules axe already runs.');
  }
  const rules: unknown = (getRules as () => unknown)();
  const ids = new Set<string>();
  if (Array.isArray(rules)) {
    for (const rule of rules) {
      const id: unknown = rule !== null && typeof rule === 'object' ? Reflect.get(rule, 'ruleId') : undefined;
      if (typeof id === 'string') {
        ids.add(id);
      }
    }
  }
  if (ids.size === 0) {
    throw new Error('axe-core reported no rules, so usabl cannot tell which engine rules axe already runs.');
  }
  return ids;
}

/**
 * Replaces every occurrence of each secret with a marker. Applied to every message and every string
 * a credentialed engine returns, because a vendor error can quote the token it was given.
 */
export function makeRedactor(secrets: readonly string[]): (text: string) => string {
  const values = [...new Set(secrets.filter((secret) => secret.length > 0))].sort((a, b) => b.length - a.length);
  return (text: string): string => {
    let out = text;
    for (const secret of values) {
      out = out.split(secret).join('[redacted]');
    }
    return out;
  };
}

/**
 * Real Deps builder for the live `usabl check` CLI path.
 * This unit wires adapters and providers only and must never decide verdicts.
 * Browser launch stays lazy so normal checks and type/test workflows do not open Chromium.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { Capability, Deps, UsablConfig } from '../contracts/index.js';
import { makeCheckRunner } from '../providers/check-runner.js';
import { axeProvider } from '../providers/axe/index.js';
import { makeRulepackProvider } from '../providers/rulepack/index.js';
import { makeKeyboardWalkProvider } from '../providers/keyboard-walk/index.js';
import { makeStepRunner } from '../providers/keyboard-walk/steps.js';
import { loadRequirements } from '../intake/load.js';
import { mapRequirementsToProviders } from '../intake/map-to-providers.js';
import { makeRealBrowserDriver } from './real.js';
import { makeGitReader } from './git.js';
import { makeFsGlob } from './fs.js';

const require = createRequire(import.meta.url);
const RUNNER_PACKAGE_PATH = fileURLToPath(new URL('../../package.json', import.meta.url));
const KEYBOARD_WALL_CLOCK_MS = 4_000;

function readVersion(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

async function readRunnerVersion(): Promise<string> {
  const raw = await readFile(RUNNER_PACKAGE_PATH, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('package.json must be a JSON object');
  }
  const version = readVersion(Reflect.get(parsed, 'version'));
  if (version === null) {
    throw new Error('package.json missing version');
  }
  return version;
}

function readDependencyVersion(packageName: string): string {
  try {
    const pkg: unknown = require(`${packageName}/package.json`);
    return readVersion(typeof pkg === 'object' && pkg !== null ? Reflect.get(pkg, 'version') : null) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function readChromiumVersion(): string {
  try {
    const executablePath = chromium.executablePath();
    const revisionMatch = /chromium[-_](\d+)/i.exec(executablePath);
    if (revisionMatch?.[1] !== undefined) {
      return `revision-${revisionMatch[1]}`;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function buildDeps(
  config: UsablConfig,
  options: { cwd?: string; allowedCapabilities?: Capability[]; storageStatePath?: string } = {},
): Promise<Deps> {
  const cwd = options.cwd ?? process.cwd();
  const allowedCapabilities = options.allowedCapabilities ?? ['live'];
  const browser = makeRealBrowserDriver(
    options.storageStatePath === undefined ? {} : { storageStatePath: options.storageStatePath },
  );
  const fs = makeFsGlob({ cwd });
  const loadedRequirements = await loadRequirements(fs, config);
  const providers = [
    axeProvider,
    makeRulepackProvider(),
    // Wall-clock cap limits infinite focus loops while still disclosing partial evidence.
    makeKeyboardWalkProvider({ wallClockMs: KEYBOARD_WALL_CLOCK_MS }),
  ];
  if (loadedRequirements.ok) {
    providers.push(...mapRequirementsToProviders(loadedRequirements.bundle));
  }
  // Intake parse failure is policy input failure, not an engine crash.
  // We keep building Deps so run() can fail closed through the gate path.

  return {
    clock: () => new Date().toISOString(),
    runnerVersion: await readRunnerVersion(),
    scannerVersions: {
      axeCore: readDependencyVersion('axe-core'),
      playwright: readDependencyVersion('playwright'),
      chromium: readChromiumVersion(),
    },
    browser,
    git: makeGitReader({ cwd }),
    fs,
    checkRunner: makeCheckRunner({
      browser,
      providers,
      config,
      // Static-only mode denies live capability explicitly so the result records not-covered gaps.
      allowedCapabilities,
      stepRunner: makeStepRunner(),
    }),
  };
}

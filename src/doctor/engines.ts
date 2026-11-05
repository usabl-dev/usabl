/**
 * The optional commercial engines, as `usabl doctor` reports them. An engine is off or on, which is
 * not one of the four surface states: an engine that is off is not missing anything. So the engines
 * get their own section, after the surfaces, and never change the surface counts.
 *
 * Read-only like the rest of doctor. Whether a package is installed is read from disk the way the
 * run's dynamic import resolves it, without loading vendor code. Credentials are reported as set or
 * not set by variable name, and no credential value or switch value is ever read into the report.
 * The section always says what testing the engine support has had.
 */
import type { EnginesConfig, UsablConfig } from '../contracts/index.js';
import type { EnvReader } from '../deps/session.js';
import { parseUsablConfig } from '../intake/config.js';
import {
  DEQUE_PACKAGE,
  DEQUE_RULESET_FILES,
  DEQUE_RULESET_PATH_ENV,
  DEQUE_TRACK_USAGE_ENV,
} from '../providers/engines/deque.js';
import {
  EVINCED_CONFIG_FILES,
  EVINCED_PACKAGE,
  EVINCED_SWITCH_ENV,
  evincedCredentialNames,
  evincedMode,
  missingEvincedCredentials,
} from '../providers/engines/evinced.js';
import { probeInstalledPackage, type InstalledPackage } from '../providers/engines/shared.js';

// What testing the engine support has had, in the words the docs use. Printed whether or not an
// engine is on, so nobody turns one on believing it was proven on a licensed SDK.
export const ENGINE_DISCLOSURE =
  "Tested against the vendor's documented result format. Not yet run on a licensed SDK. Engine findings are preview: shown, never blocking.";

export interface EngineReport {
  id: 'deque' | 'evinced';
  label: string;
  // "off", "unknown", or "on, " followed by the package and credentials state.
  state: string;
  // What to do next, or a plain note. Names variables, files, and config keys, never values.
  note: string;
}

export interface EngineDoctorDeps {
  // Reads a project file by its path, or null when it is absent.
  readFile: (path: string) => Promise<string | null>;
  configPath: string;
  env: EnvReader;
  probePackage?: (packageName: string) => Promise<InstalledPackage>;
}

const DEQUE_LABEL = 'deque (axe DevTools for Web, @axe-devtools/playwright)';
const EVINCED_LABEL = 'evinced (Evinced Automation for Web, @evinced/js-playwright-sdk)';
const UNTIL_THEN = 'Until then every scan reports a coverage gap for this engine.';

function isFsReadError(error: unknown): boolean {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string';
}

async function readConfig(deps: EngineDoctorDeps): Promise<{ config: UsablConfig | null } | null> {
  let raw: string | null;
  try {
    raw = await deps.readFile(deps.configPath);
  } catch (error) {
    if (!isFsReadError(error)) {
      throw error;
    }
    return null;
  }
  if (raw === null) {
    return { config: null };
  }
  try {
    return { config: parseUsablConfig(raw) };
  } catch {
    return null;
  }
}

function packageState(found: InstalledPackage): string {
  if (found.state === 'not-installed') {
    return 'package not installed';
  }
  return found.missingDependencies.length === 0
    ? `package ${found.version}`
    : `package ${found.version} (missing ${found.missingDependencies.join(', ')})`;
}

function missingDependencyStep(packageName: string, missing: readonly string[]): string {
  const which =
    missing.length === 1
      ? `${missing[0]}, a package ${packageName} needs, is not installed`
      : `${missing.join(', ')}, packages ${packageName} needs, are not installed`;
  return `${which}. Reinstall ${packageName} with its dependencies.`;
}

// The switch files a scan would refuse over: present in the project and not guarded.
async function unguardedFiles(
  deps: EngineDoctorDeps,
  names: readonly string[],
  guardedPaths: readonly string[],
): Promise<string[]> {
  const problems: string[] = [];
  for (const name of names) {
    if (guardedPaths.includes(name)) {
      continue;
    }
    try {
      if ((await deps.readFile(name)) !== null) {
        problems.push(`${name} is in the project and not in guardedPaths`);
      }
    } catch (error) {
      if (!isFsReadError(error)) {
        throw error;
      }
      problems.push(`usabl could not check whether ${name} is in the project`);
    }
  }
  return problems;
}

function refusalSentence(vendor: string, problems: readonly string[]): string {
  return `Every scan will refuse to run ${vendor} until this is fixed: ${problems.join('; ')}.`;
}

async function dequeReport(
  deps: EngineDoctorDeps,
  engines: EnginesConfig | undefined,
  guardedPaths: readonly string[],
  probe: (packageName: string) => Promise<InstalledPackage>,
): Promise<EngineReport> {
  const deque = engines?.deque;
  if (deque?.enabled !== true) {
    return {
      id: 'deque',
      label: DEQUE_LABEL,
      state: 'off',
      note: `Off. Optional: with an axe DevTools for Web Enterprise license, install ${DEQUE_PACKAGE} from Deque's registry and set engines.deque.enabled to true in ${deps.configPath}.`,
    };
  }
  const found = await probe(DEQUE_PACKAGE);
  const trackingOff = deque.trackUsage !== true;
  const problems: string[] = [];
  const tracking = deps.env[DEQUE_TRACK_USAGE_ENV];
  if (trackingOff && tracking !== undefined && tracking !== 'false') {
    problems.push(`${DEQUE_TRACK_USAGE_ENV} is set to a value other than false`);
  }
  if (deps.env[DEQUE_RULESET_PATH_ENV] !== undefined) {
    problems.push(`${DEQUE_RULESET_PATH_ENV} is set`);
  }
  problems.push(...(await unguardedFiles(deps, DEQUE_RULESET_FILES, guardedPaths)));

  const steps: string[] = [];
  if (found.state === 'not-installed') {
    steps.push(`Install ${DEQUE_PACKAGE} from Deque's registry.`);
  } else if (found.missingDependencies.length > 0) {
    steps.push(missingDependencyStep(DEQUE_PACKAGE, found.missingDependencies));
  }

  let note: string;
  if (problems.length > 0 || steps.length > 0) {
    note = [
      ...(problems.length > 0 ? [refusalSentence('Deque', problems)] : []),
      ...steps,
      ...(steps.length > 0 ? [`Or set engines.deque.enabled to false. ${UNTIL_THEN}`] : []),
    ].join(' ');
  } else if (!trackingOff) {
    note = 'Usage tracking on (opted in), so Deque sends usage data to its usage service. No credentials are needed at run time.';
  } else if (tracking === 'false') {
    note = 'Usage tracking off. No credentials are needed at run time.';
  } else {
    note = `Usage tracking off: usabl calls enableTracking(false) on the builder. Also set ${DEQUE_TRACK_USAGE_ENV}=false, so nothing is sent while the package loads. No credentials are needed at run time.`;
  }
  return {
    id: 'deque',
    label: DEQUE_LABEL,
    state: `on, ${packageState(found)}, credentials: none needed`,
    note,
  };
}

async function evincedReport(
  deps: EngineDoctorDeps,
  engines: EnginesConfig | undefined,
  guardedPaths: readonly string[],
  probe: (packageName: string) => Promise<InstalledPackage>,
): Promise<EngineReport> {
  const evinced = engines?.evinced;
  if (evinced?.enabled !== true) {
    return {
      id: 'evinced',
      label: EVINCED_LABEL,
      state: 'off',
      note: `Off. Optional: with an Evinced Automation for Web license, install ${EVINCED_PACKAGE} from Evinced's registry and set engines.evinced.enabled to true in ${deps.configPath}.`,
    };
  }
  const mode = evincedMode(evinced);
  const found = await probe(EVINCED_PACKAGE);
  const missing = missingEvincedCredentials(deps.env, mode);
  const problems: string[] = [];
  const switchOn = deps.env[EVINCED_SWITCH_ENV];
  if (switchOn !== undefined && switchOn !== 'true') {
    problems.push(`${EVINCED_SWITCH_ENV} is set to a value other than true`);
  }
  problems.push(...(await unguardedFiles(deps, EVINCED_CONFIG_FILES, guardedPaths)));

  const steps: string[] = [];
  if (found.state === 'not-installed') {
    steps.push(`Install ${EVINCED_PACKAGE} from Evinced's registry.`);
  } else if (found.missingDependencies.length > 0) {
    steps.push(missingDependencyStep(EVINCED_PACKAGE, found.missingDependencies));
  }
  if (missing.length > 0) {
    steps.push(`Set ${missing.join(' and ')} (${mode} mode reads ${evincedCredentialNames(mode).join(' and ')}).`);
  }
  const modeNote =
    mode === 'online' ? 'Online mode contacts the Evinced license server.' : 'Offline mode needs no license server.';
  const note =
    problems.length > 0 || steps.length > 0
      ? [
          ...(problems.length > 0 ? [refusalSentence('Evinced', problems)] : []),
          ...steps,
          ...(steps.length > 0 ? [`Or set engines.evinced.enabled to false. ${UNTIL_THEN}`] : []),
        ].join(' ')
      : `${modeNote} Credential values are never printed.`;
  return {
    id: 'evinced',
    label: EVINCED_LABEL,
    state: `on, ${packageState(found)}, credentials present: ${missing.length === 0 ? 'yes' : 'no'}`,
    note,
  };
}

export async function collectEngineReports(deps: EngineDoctorDeps): Promise<EngineReport[]> {
  const read = await readConfig(deps);
  if (read === null) {
    const note = `usabl could not read the engines block from ${deps.configPath}; see the usabl config line above.`;
    return [
      { id: 'deque', label: DEQUE_LABEL, state: 'unknown', note },
      { id: 'evinced', label: EVINCED_LABEL, state: 'unknown', note },
    ];
  }
  const probe = deps.probePackage ?? ((name: string) => probeInstalledPackage(name));
  const engines = read.config?.engines;
  const guardedPaths = read.config?.guardedPaths ?? [];
  return [
    await dequeReport(deps, engines, guardedPaths, probe),
    await evincedReport(deps, engines, guardedPaths, probe),
  ];
}

export function formatEngineReports(reports: EngineReport[], neutralize: (text: string) => string): string[] {
  const lines = ['optional engines (engines in the usabl config):', `  ${ENGINE_DISCLOSURE}`];
  for (const report of reports) {
    lines.push(`  [${report.state}] ${neutralize(report.label)}`);
    lines.push(`      ${neutralize(report.note)}`);
  }
  lines.push('');
  return lines;
}

/**
 * CLI surface helpers that parse flags and project a gated Result.
 * This module formats output only.
 * It must never run checks, decide a verdict, or mutate the Result.
 */
import type { Result } from '../contracts/index.js';
import { formatSummary } from '../output/summary.js';
import { scrubResult } from './scrub.js';

// The one integration each install run wires. Exactly one per invocation.
export type InstallTarget = 'overlay' | 'claude' | 'ci' | 'branch-rule';

// The flags that name an install target, in the order the refusal message lists them.
// --ci is dual-purpose: it keeps its CI-mode meaning on check and only names a target
// under the install command, so it appears here for target counting as well.
export const INSTALL_TARGET_FLAGS = ['--overlay', '--claude', '--ci', '--branch-rule'] as const;

export interface CliOptions {
  command: 'check' | 'comment' | 'enforce' | 'floor' | 'drift' | 'install' | 'stop-hook' | 'doctor' | string;
  staticOnly: boolean;
  // Render the docs artifacts as an accessible HTML page instead of JSON.
  // Only the docs command reads this; every other command ignores it.
  html: boolean;
  trustedRef: string | null;
  json: boolean;
  ci: boolean;
  configPath: string;
  selfCheck: boolean;
  force: boolean;
  enforceCheck: 'accessibility' | 'policy' | null;
  floorSubcommand: 'prune' | null;
  driftSubcommand: 'routes' | null;
  // The single install target for `usabl install`, or null when this is not an install
  // run or when zero or several target flags were given (installRefusal handles those).
  installTarget: InstallTarget | null;
}

function isFlag(value: string): boolean {
  return value.startsWith('-');
}

// Resolve the one install target from the flags actually seen. Only the install command
// consumes these as targets, so `check --ci` never becomes an install run. Zero or several
// targets resolve to null on purpose; installRefusal turns that into an honest refusal
// rather than half-wiring an integration.
function resolveInstallTarget(
  command: string,
  seen: { overlay: boolean; claude: boolean; ci: boolean; branchRule: boolean },
): InstallTarget | null {
  if (command !== 'install') {
    return null;
  }
  const selected: InstallTarget[] = [];
  if (seen.overlay) {
    selected.push('overlay');
  }
  if (seen.claude) {
    selected.push('claude');
  }
  if (seen.ci) {
    selected.push('ci');
  }
  if (seen.branchRule) {
    selected.push('branch-rule');
  }
  return selected.length === 1 ? (selected[0] ?? null) : null;
}

export function parseCliArgs(argv: string[]): CliOptions {
  let command: 'check' | 'comment' | 'enforce' | 'floor' | 'drift' | string = 'check';
  let staticOnly = false;
  let html = false;
  let trustedRef: string | null = null;
  let json = false;
  let ci = false;
  let configPath = 'usabl.config.json';
  let selfCheck = false;
  let force = false;
  let enforceCheck: 'accessibility' | 'policy' | null = null;
  let floorSubcommand: 'prune' | null = null;
  let driftSubcommand: 'routes' | null = null;
  // Install target flags are tracked separately from the command so the exactly-one rule
  // can be enforced after parsing. --ci reuses the existing `ci` boolean below.
  let overlay = false;
  let claude = false;
  let branchRule = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    if (!isFlag(token)) {
      // `usabl enforce accessibility|policy` is a projection, not a second gate.
      if (command === 'enforce' && (token === 'accessibility' || token === 'policy')) {
        enforceCheck = token;
        continue;
      }
      if (command === 'floor' && token === 'prune') {
        floorSubcommand = 'prune';
        continue;
      }
      if (command === 'drift' && token === 'routes') {
        driftSubcommand = 'routes';
        continue;
      }
      command = token;
      if (command !== 'enforce') {
        enforceCheck = null;
      }
      if (command !== 'floor') {
        floorSubcommand = null;
      }
      if (command !== 'drift') {
        driftSubcommand = null;
      }
      continue;
    }
    if (token === '--static-only') {
      staticOnly = true;
      continue;
    }
    if (token === '--html') {
      html = true;
      continue;
    }
    if (token === '--json') {
      json = true;
      continue;
    }
    if (token === '--ci') {
      ci = true;
      continue;
    }
    if (token === '--self-check') {
      selfCheck = true;
      continue;
    }
    if (token === '--overlay') {
      overlay = true;
      continue;
    }
    if (token === '--claude') {
      claude = true;
      continue;
    }
    if (token === '--branch-rule') {
      branchRule = true;
      continue;
    }
    if (token === '--force') {
      // Init-only overwrite of draft policy files. This is not a gate bypass.
      force = true;
      continue;
    }
    if (token === '--trusted-ref') {
      const value = argv[index + 1];
      if (value === undefined || isFlag(value)) {
        throw new Error('--trusted-ref requires a value');
      }
      trustedRef = value;
      index += 1;
      continue;
    }
    if (token === '--config') {
      const value = argv[index + 1];
      if (value === undefined || isFlag(value)) {
        throw new Error('--config requires a value');
      }
      configPath = value;
      index += 1;
    }
  }

  const installTarget = resolveInstallTarget(command, { overlay, claude, ci, branchRule });

  return { command, staticOnly, html, trustedRef, json, ci, configPath, selfCheck, force, enforceCheck, floorSubcommand, driftSubcommand, installTarget };
}

export function installRefusal(opts: CliOptions): { exitCode: 2; message: string } | null {
  // Only the install command has a target to resolve. Everything else passes through.
  if (opts.command !== 'install') {
    return null;
  }
  // Exactly one target is wired per run. Zero or several is ambiguous, so refuse and name
  // the four valid flags rather than half-wire an integration the operator did not choose.
  if (opts.installTarget !== null) {
    return null;
  }
  return {
    exitCode: 2,
    message: `install needs exactly one target flag. Choose one of: ${INSTALL_TARGET_FLAGS.join(', ')}`,
  };
}

export function ciRefusal(opts: CliOptions): { exitCode: 2; message: string } | null {
  // CI must pin a trusted ref so a PR cannot edit policy and self-accept in one run.
  return opts.ci && opts.trustedRef === null
    ? { exitCode: 2, message: 'CI mode requires --trusted-ref <git-ref>' }
    : null;
}

export function projectCli(result: Result): { exitCode: number; text: string; json: string } {
  // Scrub before any egress so page text and credential-shaped values cannot hijack output.
  const safe = scrubResult(result);
  return {
    exitCode: safe.exitCode,
    text: formatSummary(safe),
    json: JSON.stringify(safe, null, 2),
  };
}

export function mergeChangedPaths(diffNames: string[], statusPaths: string[]): string[] {
  const changed = new Set<string>();
  for (const path of diffNames) {
    if (path.length > 0) {
      changed.add(path);
    }
  }
  for (const path of statusPaths) {
    if (path.length > 0) {
      changed.add(path);
    }
  }
  return [...changed].sort();
}

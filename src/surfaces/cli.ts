/**
 * CLI surface helpers that parse flags and project a gated Result.
 * This module formats output only.
 * It must never run checks, decide a verdict, or mutate the Result.
 */
import type { Result } from '../contracts/index.js';
import { formatSummary } from '../output/summary.js';
import { scrubResult } from './scrub.js';

export interface CliOptions {
  command: 'check' | 'comment' | string;
  staticOnly: boolean;
  trustedRef: string | null;
  json: boolean;
  ci: boolean;
  configPath: string;
  selfCheck: boolean;
  force: boolean;
}

function isFlag(value: string): boolean {
  return value.startsWith('-');
}

export function parseCliArgs(argv: string[]): CliOptions {
  let command: 'check' | 'comment' | string = 'check';
  let staticOnly = false;
  let trustedRef: string | null = null;
  let json = false;
  let ci = false;
  let configPath = 'usabl.config.json';
  let selfCheck = false;
  let force = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    if (!isFlag(token)) {
      command = token;
      continue;
    }
    if (token === '--static-only') {
      staticOnly = true;
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

  return { command, staticOnly, trustedRef, json, ci, configPath, selfCheck, force };
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

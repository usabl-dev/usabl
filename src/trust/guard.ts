/**
 * Local trust guard utilities for policy-sensitive files and directories.
 * This unit expands guard scope and reports drift only.
 * It must never mint a verdict or hide unguarded policy edits.
 */
import type { Deps, UsablConfig } from '../contracts/index.js';
import { sha256 } from '../primitives/canonical.js';

const CONFIG_PATH = 'usabl.config.json';
const ALWAYS_GUARDED = [
  CONFIG_PATH,
  '.usabl-evidence.json',
  '.usabl-waivers.json',
  'usabl.routes.json',
];

export type SessionPins = Record<string, string>;

function normalizePrefix(prefix: string): string {
  return prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
}

/**
 * The guard always includes core policy ledgers even if guardedPaths is empty.
 * `usabl.routes.json` is load-bearing because it controls scan targets.
 */
export function buildGuardedSet(config: UsablConfig): string[] {
  const guarded = new Set<string>(ALWAYS_GUARDED);
  if (config.requirements !== undefined) {
    guarded.add(config.requirements);
  }
  for (const path of config.guardedPaths) {
    guarded.add(path);
  }
  return [...guarded].sort();
}

/**
 * Directory entries are expanded from committed files and working-tree files.
 * This catches new files under a guarded prefix so a self-edit cannot hide.
 */
export async function expandGuardedSet(deps: Deps, guardedPaths: string[]): Promise<string[]> {
  const expanded = new Set<string>();

  for (const entry of guardedPaths) {
    const prefix = normalizePrefix(entry);
    const [headFiles, workingFiles] = await Promise.all([
      deps.git.lsFiles('HEAD', prefix),
      deps.fs.glob([prefix, prefix + '/**']),
    ]);

    if (headFiles.length === 0 && workingFiles.length === 0) {
      expanded.add(entry);
      continue;
    }

    for (const path of headFiles) {
      expanded.add(path);
    }
    for (const path of workingFiles) {
      expanded.add(path);
    }
  }

  return [...expanded].sort();
}

/**
 * Config-first ordering is an honesty boundary.
 * If config bytes diverge from HEAD, we return the config path immediately and
 * refuse to trust potentially tampered guardedPaths content from the workspace.
 */
export async function checkGuard(deps: Deps, config: UsablConfig): Promise<string[]> {
  const [workingConfig, headConfig] = await Promise.all([
    deps.fs.readFile(CONFIG_PATH),
    deps.git.show('HEAD', CONFIG_PATH),
  ]);
  if (workingConfig !== headConfig) {
    return [CONFIG_PATH];
  }

  const expanded = await expandGuardedSet(deps, buildGuardedSet(config));
  const diverged: string[] = [];
  for (const path of expanded) {
    const [working, head] = await Promise.all([deps.fs.readFile(path), deps.git.show('HEAD', path)]);
    // Optional ledgers may be absent in both places early in a repo lifecycle.
    if (working === null && head === null) {
      continue;
    }
    if (working !== head) {
      diverged.push(path);
    }
  }
  return diverged.sort();
}

/**
 * Session pins fingerprint committed bytes for later stop-hook reuse.
 * This unit stays pure and does not write pin state to disk.
 */
export async function computeSessionPins(deps: Deps, config: UsablConfig): Promise<SessionPins> {
  const expanded = await expandGuardedSet(deps, buildGuardedSet(config));
  const pins: SessionPins = {};
  for (const path of expanded) {
    pins[path] = sha256((await deps.git.show('HEAD', path)) ?? '');
  }
  return pins;
}

export function diffSessionPins(previous: SessionPins, next: SessionPins): string[] {
  const changed: string[] = [];
  const allPaths = new Set<string>([...Object.keys(previous), ...Object.keys(next)]);
  for (const path of allPaths) {
    if (previous[path] !== next[path]) {
      changed.push(path);
    }
  }
  return changed.sort();
}

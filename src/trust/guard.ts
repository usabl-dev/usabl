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
type GuardConfigSource = Pick<UsablConfig, 'guardedPaths' | 'requirements'>;

function normalizePrefix(prefix: string): string {
  return prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseGuardConfigBytes(raw: string): GuardConfigSource | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return null;
    }

    const guardedRaw = parsed['guardedPaths'];
    const guardedPaths: string[] = [];
    if (guardedRaw !== undefined) {
      if (!Array.isArray(guardedRaw)) {
        return null;
      }
      for (const entry of guardedRaw) {
        if (typeof entry !== 'string') {
          return null;
        }
        guardedPaths.push(entry);
      }
    }

    const requirementsRaw = parsed['requirements'];
    if (requirementsRaw !== undefined && typeof requirementsRaw !== 'string') {
      return null;
    }

    if (requirementsRaw === undefined) {
      return { guardedPaths };
    }
    return { guardedPaths, requirements: requirementsRaw };
  } catch {
    return null;
  }
}

/**
 * The guard always includes core policy ledgers even if guardedPaths is empty.
 * `usabl.routes.json` is load-bearing because it controls scan targets.
 */
export function buildGuardedSet(config: GuardConfigSource): string[] {
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
export async function expandGuardedSet(
  deps: Deps,
  guardedPaths: string[],
  trustedRef = 'HEAD',
): Promise<string[]> {
  const expanded = new Set<string>();

  for (const entry of guardedPaths) {
    const prefix = normalizePrefix(entry);
    const [trustedFiles, workingFiles] = await Promise.all([
      deps.git.lsFiles(trustedRef, prefix),
      deps.fs.glob([prefix, prefix + '/**']),
    ]);

    if (trustedFiles.length === 0 && workingFiles.length === 0) {
      expanded.add(entry);
      continue;
    }

    for (const path of trustedFiles) {
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
 * If config bytes diverge from the trusted ref, return the config path immediately.
 * Never trust potentially tampered guardedPaths content from the workspace.
 */
export async function checkGuard(deps: Deps, config: UsablConfig, trustedRef = 'HEAD'): Promise<string[]> {
  const [workingConfig, trustedConfig] = await Promise.all([
    deps.fs.readFile(CONFIG_PATH),
    deps.git.show(trustedRef, CONFIG_PATH),
  ]);
  if (workingConfig !== trustedConfig) {
    return [CONFIG_PATH];
  }

  // Guard scope comes from the verified config bytes, not the caller object.
  // After bytes match the trusted ref, trusting in-memory config would let a caller edit
  // guardedPaths and self-approve in the same run.
  if (workingConfig === null) {
    return [CONFIG_PATH];
  }
  const verifiedConfig = parseGuardConfigBytes(workingConfig);
  if (verifiedConfig === null) {
    return [CONFIG_PATH];
  }

  const expanded = await expandGuardedSet(deps, buildGuardedSet(verifiedConfig), trustedRef);
  const diverged: string[] = [];
  for (const path of expanded) {
    const [working, trusted] = await Promise.all([deps.fs.readFile(path), deps.git.show(trustedRef, path)]);
    // Optional ledgers may be absent in both places early in a repo lifecycle.
    if (working === null && trusted === null) {
      continue;
    }
    if (working !== trusted) {
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

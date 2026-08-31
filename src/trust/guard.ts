/**
 * Local trust guard utilities for policy-sensitive files and directories.
 * This unit expands guard scope and reports drift only.
 * It must never mint a verdict or hide unguarded policy edits.
 */
import type { Deps, GitReader, UsablConfig } from '../contracts/index.js';
import { sha256 } from '../primitives/canonical.js';

const CONFIG_PATH = 'usabl.config.json';
const ALWAYS_GUARDED = [
  CONFIG_PATH,
  '.usabl-evidence.json',
  '.usabl-waivers.json',
  'usabl.docs.json',
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
    // fs.glob returns files only, so a directory entry expands to the files beneath
    // it and a file entry matches itself. lsFiles adds committed files the working
    // tree may have deleted.
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
 * Config-first scope is an honesty boundary.
 * If config bytes diverge, guarded set still comes from the trusted ref so a
 * PR cannot hide other dirty policy files by shrinking guardedPaths.
 * Every diverged guarded path is returned. The gate needs the full list so
 * CODEOWNERS approval cannot be satisfied by the config owner alone.
 */
export async function checkGuard(deps: Deps, config: UsablConfig, trustedRef = 'HEAD'): Promise<string[]> {
  const [workingConfig, trustedConfig] = await Promise.all([
    deps.fs.readFile(CONFIG_PATH),
    deps.git.show(trustedRef, CONFIG_PATH),
  ]);
  const configDiverged = workingConfig !== trustedConfig;

  // Scope is trusted-ref config when bytes diverged. Matched bytes can use
  // working-tree parse because they are the same document.
  const scopeRaw = configDiverged ? trustedConfig : workingConfig;
  const scopeConfig = scopeRaw === null ? null : parseGuardConfigBytes(scopeRaw);
  if (scopeConfig === null && !configDiverged) {
    return [CONFIG_PATH];
  }

  const expanded = await expandGuardedSet(
    deps,
    buildGuardedSet(scopeConfig ?? { guardedPaths: [] }),
    trustedRef,
  );
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
 * Same honesty as checkGuard, for CI policy enforce that only has git refs.
 * Working-tree bytes are not consulted. PR head vs trusted ref is the source of truth
 * so a forged Result cannot hide a guarded-file diff.
 */
export async function listDivergedGuardedPathsAtRefs(
  git: Pick<GitReader, 'show' | 'lsFiles'>,
  trustedRef: string,
  workingRef: string,
): Promise<string[]> {
  const [workingConfig, trustedConfig] = await Promise.all([
    git.show(workingRef, CONFIG_PATH),
    git.show(trustedRef, CONFIG_PATH),
  ]);
  const configDiverged = workingConfig !== trustedConfig;
  const scopeRaw = configDiverged ? trustedConfig : workingConfig;
  const scopeConfig = scopeRaw === null ? null : parseGuardConfigBytes(scopeRaw);
  if (scopeConfig === null && !configDiverged) {
    return [CONFIG_PATH];
  }

  const expanded = new Set<string>();
  for (const entry of buildGuardedSet(scopeConfig ?? { guardedPaths: [] })) {
    const prefix = normalizePrefix(entry);
    const [trustedFiles, workingFiles] = await Promise.all([
      git.lsFiles(trustedRef, prefix),
      git.lsFiles(workingRef, prefix),
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

  const diverged: string[] = [];
  for (const path of expanded) {
    const [working, trusted] = await Promise.all([git.show(workingRef, path), git.show(trustedRef, path)]);
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

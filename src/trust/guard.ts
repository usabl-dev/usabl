/**
 * Local trust guard utilities for policy-sensitive files and directories.
 * This unit expands guard scope and reports drift only.
 * It must never mint a verdict or hide unguarded policy edits.
 */
import type { Deps, GitReader, UsablConfig } from '../contracts/index.js';
import { sha256 } from '../primitives/canonical.js';
import { globMatcher } from '../primitives/match-glob.js';

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
 * `usabl.routes.json` is load-bearing because it controls the app scan targets, and
 * `usabl.docs.json` is equally load-bearing because it controls the docs scan surface.
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

// A guardedPaths entry with a glob character. Config load accepts only `*`, `**`, and brace
// groups, so these two characters are the only ones that make an entry a pattern.
const GLOB_CHARACTERS = /[*{]/;

function isGlobEntry(entry: string): boolean {
  return GLOB_CHARACTERS.test(normalizePrefix(entry));
}

// The folder a git listing must cover to find every file an entry can match: the entry itself
// when it is a literal path, or the literal segments before its first glob segment. An empty
// result is the whole tree.
function listingPrefix(entry: string): string {
  const prefix = normalizePrefix(entry);
  if (!GLOB_CHARACTERS.test(prefix)) {
    return prefix;
  }
  const segments = prefix.split('/');
  return segments.slice(0, segments.findIndex((segment) => GLOB_CHARACTERS.test(segment))).join('/');
}

/**
 * The one matcher for a guardedPaths entry, used on the working tree and on every ref, by the
 * local guard and by the CI policy check. A literal entry matches itself and every file under it,
 * as a folder. A glob entry matches the files the glob matches and every file under a folder it
 * matches, with Node's dot rule, so a ref listing selects what fs.glob selects on the working tree.
 */
function guardedEntryMatcher(entry: string): (path: string) => boolean {
  const prefix = normalizePrefix(entry);
  const under = prefix + '/';
  if (!GLOB_CHARACTERS.test(prefix)) {
    return (path) => path === prefix || path.startsWith(under);
  }
  const matchesFile = globMatcher(prefix, { dot: false });
  const matchesBeneath = globMatcher(prefix + '/**', { dot: false });
  return (path) => path === prefix || path.startsWith(under) || matchesFile(path) || matchesBeneath(path);
}

/**
 * The files the entries match among the listed paths. A literal entry that matches nothing is
 * kept as its own path, so a guarded file absent everywhere is still compared. A glob entry is
 * never kept as a path: no file has that name, and git show reads such a name as empty text.
 */
function selectGuarded(entries: string[], listed: Iterable<string>, alsoByEntry: string[][] = []): string[] {
  const paths = [...new Set(listed)];
  const selected = new Set<string>();
  entries.forEach((entry, index) => {
    const matches = guardedEntryMatcher(entry);
    let found = false;
    for (const path of paths) {
      if (matches(path)) {
        selected.add(path);
        found = true;
      }
    }
    for (const path of alsoByEntry[index] ?? []) {
      selected.add(path);
      found = true;
    }
    if (!found && !isGlobEntry(entry)) {
      selected.add(entry);
    }
  });
  return [...selected].sort();
}

function listingPrefixes(entries: string[]): string[] {
  return [...new Set(entries.map(listingPrefix))].sort();
}

/**
 * Guarded entries are expanded with one matcher from what git and the file system hold: the files
 * at the trusted ref and at HEAD (each listed once, with -z), the paths git status reports (new,
 * changed, deleted, renamed), and what fs.glob finds on the working tree. So a file deleted
 * locally under a glob entry is still listed, and a new file under a guarded folder cannot hide.
 * The fs.glob result is kept as found, so the guard never lists less than it did before one
 * matcher, for example a file only Node's brace ranges such as {1..3} select.
 */
export async function expandGuardedSet(
  deps: Deps,
  guardedPaths: string[],
  trustedRef = 'HEAD',
): Promise<string[]> {
  const prefixes = listingPrefixes(guardedPaths);
  const refs = trustedRef === 'HEAD' ? ['HEAD'] : [trustedRef, 'HEAD'];
  const [refListings, status, workingByEntry] = await Promise.all([
    Promise.all(refs.map((ref) => deps.git.lsFilesUnder(ref, prefixes))),
    deps.git.statusZ(),
    Promise.all(
      guardedPaths.map((entry) => {
        const prefix = normalizePrefix(entry);
        // fs.glob returns files only, so a folder entry expands to the files beneath it and a
        // file entry matches itself.
        return deps.fs.glob([prefix, prefix + '/**']);
      }),
    ),
  ]);
  const listed = [...refListings.flat(), ...status.map((entry) => entry.path)];
  return selectGuarded(guardedPaths, listed, workingByEntry);
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
  git: Pick<GitReader, 'show' | 'lsFilesUnder'>,
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

  // Each ref is listed once, and the same matcher the local guard uses selects the guarded files,
  // so a glob entry lists its files at both refs and a file the head deleted is still compared.
  const entries = buildGuardedSet(scopeConfig ?? { guardedPaths: [] });
  const prefixes = listingPrefixes(entries);
  const [trustedFiles, workingFiles] = await Promise.all([
    git.lsFilesUnder(trustedRef, prefixes),
    git.lsFilesUnder(workingRef, prefixes),
  ]);
  const expanded = selectGuarded(entries, [...trustedFiles, ...workingFiles]);

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

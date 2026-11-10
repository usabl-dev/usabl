/**
 * Local trust guard utilities for policy-sensitive files and directories.
 * This unit expands guard scope and reports drift only.
 * It must never mint a verdict or hide unguarded policy edits.
 */
import type { Deps, GitReader, UsablConfig } from '../contracts/index.js';
import { sha256 } from '../primitives/canonical.js';
import { configError } from '../intake/config-error.js';
import { braceRangeIn, expandBraces, globMatcher, UNSUPPORTED_GLOB_CHARACTERS } from '../primitives/match-glob.js';

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

/**
 * The canonical form of a guardedPaths entry, the form git prints a path in: no leading `./`, no
 * repeated or trailing `/`, and no `.` segment. A `..` segment takes away the segment before it,
 * as git does with a pathspec. `.` alone is the whole tree, written as the empty string. Every step
 * below reads this form and never the raw entry text, because git output never holds `./` or `//`,
 * and an entry compared as written would match nothing.
 */
function canonicalEntry(entry: string): string {
  if (entry.startsWith('/')) {
    throw unmatchableEntry(entry, 'it starts with /, so it does not name a path from the repository root');
  }
  const segments: string[] = [];
  for (const segment of entry.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      const parent = segments.pop();
      if (parent === undefined) {
        throw unmatchableEntry(entry, 'a .. segment leaves the repository root');
      }
      if (GLOB_CHARACTERS.test(parent)) {
        throw unmatchableEntry(entry, 'a .. segment follows a wildcard');
      }
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

// Why the matcher cannot evaluate an entry the way Node's glob does, or null when it can. Config
// load refuses these forms, but the guard also reads the trusted ref's config, which config load
// never checked, so it must not read such an entry as matching nothing.
function unmatchableForm(path: string): string | null {
  const character = UNSUPPORTED_GLOB_CHARACTERS.find((candidate) => path.includes(candidate));
  if (character !== undefined) {
    return `it uses "${character}", which the guard cannot match`;
  }
  if (path.includes('{') && expandBraces(path) === null) {
    return 'it uses a nested or unbalanced brace';
  }
  const range = braceRangeIn(path);
  if (range !== null) {
    return `it uses the brace range ${range}, which the guard cannot match; list the alternatives with commas, such as {1,2,3}`;
  }
  return null;
}

function unmatchableEntry(entry: string, reason: string): Error {
  return configError`usabl cannot read the guardedPaths entry "${entry}": ${reason}. So usabl cannot tell which guarded files changed, and it checked none. Correct the entry in usabl.config.json at the trusted ref (HEAD for a local run).`;
}

interface GuardedEntry {
  // The canonical form. The empty string is the whole tree.
  path: string;
  glob: boolean;
}

function readGuardedEntry(entry: string): GuardedEntry {
  const path = canonicalEntry(entry);
  const problem = unmatchableForm(path);
  if (problem !== null) {
    throw unmatchableEntry(entry, problem);
  }
  return { path, glob: GLOB_CHARACTERS.test(path) };
}

// The folder a git listing must cover to find every file an entry can match: the entry itself
// when it is a literal path, or the literal segments before its first glob segment. An empty
// result is the whole tree.
function listingPrefix(entry: GuardedEntry): string {
  if (!entry.glob) {
    return entry.path;
  }
  const segments = entry.path.split('/');
  return segments.slice(0, segments.findIndex((segment) => GLOB_CHARACTERS.test(segment))).join('/');
}

/**
 * The one matcher for a guardedPaths entry, used on the working tree and on every ref, by the
 * local guard and by the CI policy check. A literal entry matches itself and every file under it,
 * as a folder, and the whole tree matches every file. A glob entry matches the files the glob
 * matches and every file under a folder it matches, with Node's dot rule.
 */
function guardedEntryMatcher(entry: GuardedEntry): (path: string) => boolean {
  if (entry.path === '') {
    return () => true;
  }
  const exact = entry.path;
  const under = exact + '/';
  if (!entry.glob) {
    return (path) => path === exact || path.startsWith(under);
  }
  const matchesFile = globMatcher(exact, { dot: false });
  const matchesBeneath = globMatcher(exact + '/**', { dot: false });
  return (path) => path === exact || path.startsWith(under) || matchesFile(path) || matchesBeneath(path);
}

/**
 * The files the entries match among the listed paths. A literal entry that matches nothing is
 * kept as its own path, in canonical form, so a guarded file absent everywhere is still compared.
 * A glob entry is never kept as a path: no file has that name. The whole tree is never kept either:
 * git show reads the root as a folder listing, not as a file.
 */
function selectGuarded(entries: GuardedEntry[], listed: Iterable<string>, alsoByEntry: string[][] = []): string[] {
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
    if (!found && !entry.glob && entry.path !== '') {
      selected.add(entry.path);
    }
  });
  return [...selected].sort();
}

function listingPrefixes(entries: GuardedEntry[]): string[] {
  return [...new Set(entries.map(listingPrefix))].sort();
}

// fs.glob patterns for one entry. fs.glob returns files only, so a folder entry expands to the
// files beneath it and a file entry matches itself.
function workingTreeGlobs(entry: GuardedEntry): string[] {
  return entry.path === '' ? ['**'] : [entry.path, entry.path + '/**'];
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
  const entries = guardedPaths.map(readGuardedEntry);
  const prefixes = listingPrefixes(entries);
  const refs = trustedRef === 'HEAD' ? ['HEAD'] : [trustedRef, 'HEAD'];
  const [refListings, status, workingByEntry] = await Promise.all([
    Promise.all(refs.map((ref) => deps.git.lsFilesUnder(ref, prefixes))),
    deps.git.statusZ(),
    Promise.all(entries.map((entry) => deps.fs.glob(workingTreeGlobs(entry)))),
  ]);
  const listed = [...refListings.flat(), ...status.map((entry) => entry.path)];
  return selectGuarded(entries, listed, workingByEntry);
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
  const entries = buildGuardedSet(scopeConfig ?? { guardedPaths: [] }).map(readGuardedEntry);
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

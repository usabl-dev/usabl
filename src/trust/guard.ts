/**
 * Local trust guard utilities for policy-sensitive files and directories.
 * This unit expands guard scope and reports drift only.
 * It must never mint a verdict or hide unguarded policy edits.
 */
import type { Deps, GitReader, UsablConfig } from '../contracts/index.js';
import { sha256 } from '../primitives/canonical.js';
import { operatorText } from '../intake/config-error.js';
import { braceRangeIn, countBraceExpansions, expandBraces, globMatcher, UNSUPPORTED_GLOB_CHARACTERS } from '../primitives/match-glob.js';

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

// Why the matcher cannot evaluate an entry the way Node's glob does, or null when it can.
function unmatchableForm(path: string): string | null {
  const character = UNSUPPORTED_GLOB_CHARACTERS.find((candidate) => path.includes(candidate));
  if (character !== undefined) {
    return `it uses "${character}", which the guard cannot match`;
  }
  if (path.includes('{') && countBraceExpansions(path) === null) {
    return 'it uses a nested or unbalanced brace';
  }
  const range = braceRangeIn(path);
  if (range !== null) {
    return `it uses the brace range ${range}, which the guard cannot match`;
  }
  return null;
}

// A segment the matcher reads as a pattern, or one it cannot evaluate.
const PATTERN_SEGMENT = /[*{}[\]()?\\]/;

/**
 * Whether the guard reads a segment as a pattern. Config load uses this same test, so it refuses
 * every `..` the guard would read as following a wildcard.
 */
export function isPatternSegment(segment: string): boolean {
  return PATTERN_SEGMENT.test(segment);
}

// The literal folder above the first segment that is a pattern. The empty string is the whole tree.
function literalFolder(segments: string[]): string {
  const first = segments.findIndex((segment) => PATTERN_SEGMENT.test(segment));
  return (first === -1 ? segments : segments.slice(0, first)).join('/');
}

/** One reading of an entry. An entry with a brace group has one reading for each expansion. */
export interface GuardedEntry {
  // The entry as written.
  text: string;
  // The canonical form, or the folder an entry read wide guards. The empty string is the whole tree.
  path: string;
  glob: boolean;
  // Why the entry is read wide, as the folder above what the matcher cannot evaluate, or null.
  readWide: string | null;
}

/**
 * How the guard reads an entry. A brace group is expanded first, as Node's glob does, and each
 * expansion is read on its own, so a `.` or `..` inside a brace alternative is read as the path it
 * names once the braces are gone. A literal entry, such as the requirements folder, is a path: no
 * glob rule applies to it, and braces in it are part of its name.
 *
 * Each form is read in canonical form, the form git prints a path in: no leading `./`, no repeated
 * or trailing `/`, and no `.` segment. A `..` segment takes away the segment before it, as git does
 * with a pathspec. `.` alone is the whole tree, written as the empty string. Every step below reads
 * this form and never the raw entry text, because git output never holds `./` or `//`, and an
 * entry compared as written would match nothing.
 *
 * This never throws because of what an entry says, and never guards less because it cannot read
 * one. A form the matcher cannot evaluate (a brace range, `?`, `[ ]`, `( )`, `\`, or a bad brace)
 * is read wide: it guards the literal folder above the first segment the matcher cannot evaluate.
 * A form with no such folder guards the whole tree: one that starts with `/`, one with a `..` that
 * leaves the root, and one with a `..` anywhere after a wildcard, which can climb above any folder.
 * An entry with more than MAX_BRACE_EXPANSIONS expansions is read wide too, as the literal folder
 * above its first brace group, and is never expanded. Config load refuses these forms, but the
 * guard also reads a trusted ref's config, which config load never checked.
 */
export function readGuardedEntry(entry: string, literal = false): GuardedEntry[] {
  if (literal || !entry.includes('{')) {
    return [readForm(entry, entry, literal, false)];
  }
  // The count comes first, because the expansions of a short entry can exhaust memory.
  const count = countBraceExpansions(entry);
  if (count !== null && count > MAX_BRACE_EXPANSIONS) {
    return [readPastCap(entry)];
  }
  const expansions = count === null ? null : expandBraces(entry);
  if (expansions === null) {
    // A bad brace has no expansion. The form check names it, and the entry is read wide.
    return [readForm(entry, entry, false, true)];
  }
  return expansions.map((form) => readForm(entry, form, false, true));
}

/**
 * The most brace expansions the guard reads one by one for a single entry. The local guard lists
 * the working tree once for each expansion. At 256 a check stays well under one second; at 65,536
 * it took about 31 seconds, long enough for a Stop hook to time out and let the stop through.
 */
export const MAX_BRACE_EXPANSIONS = 256;

// Whether an expansion of the text can hold a `..`. Two dots end up side by side only when they
// are written together, or when the text between them is all left out. That text then starts and
// ends with brace syntax, so one dot comes right before a brace or comma and one right after.
function canJoinDots(text: string): boolean {
  return text.includes('..') || (/\.[{,}]/.test(text) && /[{,}]\./.test(text));
}

/**
 * An entry past the cap, read as the literal folder above its first brace group. Every expansion
 * starts with the text before that group, so the folder holds every path the entry names, unless
 * an expansion can climb out of it with a `..`. Then, and when there is no such folder, the entry
 * guards the whole tree.
 */
function readPastCap(entry: string): GuardedEntry {
  // Where the segment that holds the first brace group starts. Text before it is the same in every
  // expansion; text from it on can join into a `..` segment.
  const start = entry.slice(0, entry.indexOf('{')).lastIndexOf('/') + 1;
  const folder = canJoinDots(entry.slice(start))
    ? ''
    : literalFolder(readForm(entry, entry.slice(0, start), false, false).path.split('/'));
  return {
    text: entry,
    path: folder,
    glob: false,
    readWide: `its brace groups expand to more than ${String(MAX_BRACE_EXPANSIONS)} paths, more than the guard reads one by one`,
  };
}

// One form of an entry, in canonical form. A form that came from a brace group is a glob reading
// even when the expansion holds no glob character, as it was before the braces were expanded.
function readForm(entry: string, form: string, literal: boolean, braced: boolean): GuardedEntry {
  const wide = (path: string, reason: string): GuardedEntry => ({ text: entry, path, glob: false, readWide: reason });
  if (form.startsWith('/')) {
    return wide('', 'it starts with /, so it names no path from the repository root');
  }
  const segments: string[] = [];
  let afterPattern = false;
  for (const segment of form.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      // A wildcard can stand for any number of folders, so a later `..` can climb to any folder.
      if (afterPattern) {
        return wide('', 'a .. segment follows a wildcard, so it can name a path anywhere in the repository');
      }
      if (segments.pop() === undefined) {
        return wide('', 'a .. segment leaves the repository root');
      }
      continue;
    }
    if (!literal && PATTERN_SEGMENT.test(segment)) {
      afterPattern = true;
    }
    segments.push(segment);
  }
  const path = segments.join('/');
  if (literal) {
    return { text: entry, path, glob: false, readWide: null };
  }
  // An empty brace alternative, as in `{,}`, can leave nothing: the whole tree, which the entry
  // does not say. It is read wide, so the entry is named.
  if (braced && path === '') {
    return wide('', 'one of its brace expansions names the repository root');
  }
  const problem = unmatchableForm(path);
  if (problem !== null) {
    return wide(literalFolder(segments), problem);
  }
  return { text: entry, path, glob: braced || GLOB_CHARACTERS.test(path), readWide: null };
}

/**
 * The sentence that names an entry the guard read wide and says how to write it. The entry comes
 * from a config file, so it is scrubbed and capped before it is printed.
 */
export function readWideNotice(entry: GuardedEntry): string {
  const scope = entry.path === '' ? 'the whole repository' : `the folder ${operatorText(entry.path)}/`;
  return (
    `usabl read the guardedPaths entry "${operatorText(entry.text)}" as ${scope}, because ${entry.readWide ?? ''}, ` +
    'so a change anywhere there needs a code owner approval. Write the entry as a path from the repository root ' +
    'that uses only *, **, and {a,b} groups, and list the alternatives of a range with commas, such as {1,2,3}.'
  );
}

/**
 * How the guard reads every entry of a config: the always-guarded ledgers and the requirements
 * folder as literal paths, and each guardedPaths entry as written. The requirements value names a
 * folder, and the requirements loader accepts any folder name, so no glob rule applies to it. A
 * text that is both a literal path and a guardedPaths entry is read both ways, and the guard
 * guards what either reading matches.
 */
export function readGuardedEntries(config: GuardConfigSource): GuardedEntry[] {
  const literal = new Set<string>(ALWAYS_GUARDED);
  if (config.requirements !== undefined) {
    literal.add(config.requirements);
  }
  const listed = new Set(config.guardedPaths);
  return buildGuardedSet(config).flatMap((entry) => {
    const readings = [
      ...(literal.has(entry) ? readGuardedEntry(entry, true) : []),
      ...(listed.has(entry) ? readGuardedEntry(entry) : []),
    ];
    // A plain path reads the same both ways. Keep each reading once.
    const seen = new Set<string>();
    return readings.filter((reading) => {
      const key = JSON.stringify([reading.path, reading.glob, reading.readWide]);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  });
}

// The folder a git listing must cover to find every file an entry can match: the entry itself
// when it is a literal path, or the literal segments before its first glob segment. A brace
// expansion with no glob segment left is listed as itself. An empty result is the whole tree.
function listingPrefix(entry: GuardedEntry): string {
  const segments = entry.path.split('/');
  const first = entry.glob ? segments.findIndex((segment) => GLOB_CHARACTERS.test(segment)) : -1;
  return first === -1 ? entry.path : segments.slice(0, first).join('/');
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
 * Guarded entries are expanded from what git and the file system hold: the files the matcher
 * selects from the listings at the trusted ref and at HEAD (each listed once, with -z), joined with
 * what fs.glob finds for each entry on the working tree. The HEAD listing holds a file deleted
 * locally, and fs.glob holds a new file no commit has, so neither can hide. The fs.glob result is
 * kept as found, so the guard never lists less than it did before the matcher.
 */
export async function expandGuardedSet(
  deps: Deps,
  guardedPaths: string[],
  trustedRef = 'HEAD',
): Promise<string[]> {
  return expandEntries(
    deps,
    guardedPaths.flatMap((entry) => readGuardedEntry(entry)),
    trustedRef,
  );
}

/**
 * The guarded files for a config, with the requirements folder read as a path. Receipts, pins, the
 * debt history, and the local guard all expand through this, so each reads every entry the same way.
 */
export async function expandConfigGuardedSet(
  deps: Deps,
  config: GuardConfigSource,
  trustedRef = 'HEAD',
): Promise<string[]> {
  return expandEntries(deps, readGuardedEntries(config), trustedRef);
}

async function expandEntries(deps: Deps, entries: GuardedEntry[], trustedRef: string): Promise<string[]> {
  const prefixes = listingPrefixes(entries);
  const refs = trustedRef === 'HEAD' ? ['HEAD'] : [trustedRef, 'HEAD'];
  const [refListings, workingByEntry] = await Promise.all([
    Promise.all(refs.map((ref) => deps.git.lsFilesUnder(ref, prefixes))),
    Promise.all(entries.map((entry) => deps.fs.glob(workingTreeGlobs(entry)))),
  ]);
  return selectGuarded(entries, refListings.flat(), workingByEntry);
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

  const expanded = await expandConfigGuardedSet(deps, scopeConfig ?? { guardedPaths: [] }, trustedRef);
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
  return (await guardScopeAtRefs(git, trustedRef, workingRef)).diverged;
}

/**
 * The diverged guarded paths at two refs, and a notice for each entry the guard read wide, so the
 * policy check can name the entry and say how to write it.
 */
export async function guardScopeAtRefs(
  git: Pick<GitReader, 'show' | 'lsFilesUnder'>,
  trustedRef: string,
  workingRef: string,
): Promise<{ diverged: string[]; readWide: string[] }> {
  const [workingConfig, trustedConfig] = await Promise.all([
    git.show(workingRef, CONFIG_PATH),
    git.show(trustedRef, CONFIG_PATH),
  ]);
  const configDiverged = workingConfig !== trustedConfig;
  const scopeRaw = configDiverged ? trustedConfig : workingConfig;
  const scopeConfig = scopeRaw === null ? null : parseGuardConfigBytes(scopeRaw);
  if (scopeConfig === null && !configDiverged) {
    return { diverged: [CONFIG_PATH], readWide: [] };
  }

  // Each ref is listed once, and the same matcher the local guard uses selects the guarded files,
  // so a glob entry lists its files at both refs and a file the head deleted is still compared.
  const entries = readGuardedEntries(scopeConfig ?? { guardedPaths: [] });
  const readWide = [...new Set(entries.filter((entry) => entry.readWide !== null).map(readWideNotice))];
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
  return { diverged: diverged.sort(), readWide };
}

/**
 * Session pins fingerprint committed bytes for later stop-hook reuse.
 * This unit stays pure and does not write pin state to disk.
 */
export async function computeSessionPins(deps: Deps, config: UsablConfig): Promise<SessionPins> {
  const expanded = await expandConfigGuardedSet(deps, config);
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

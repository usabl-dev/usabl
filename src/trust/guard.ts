/**
 * Local trust guard utilities for policy-sensitive files and directories.
 * This unit expands guard scope and reports drift only.
 * It must never mint a verdict or hide unguarded policy edits.
 */
import { createHash } from 'node:crypto';
import type { Deps, FsGlob, GitReader, StoredEntry, TreeEntry, UsablConfig } from '../contracts/index.js';
import { holdsNodeGlobSyntax } from '../deps/fs-glob-reading.js';
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

/*
 * How the guard compares a guarded path.
 *
 * At a ref, a path is its tree entry: the mode and the object id from one `git ls-tree` listing
 * per ref. Two entries are equal when the mode and the id are equal, so no file content is read,
 * and a file that is not valid UTF-8, an executable bit, and a file swapped for a symbolic link
 * with the same text are all changes. On the working tree, a path is what git would store from it:
 * the file's bytes and mode, or a link's text. Its blob id is computed from those bytes, as
 * `git hash-object` does, and compared with the trusted id.
 *
 * A guarded symbolic link is compared by its link text and by what it resolves to inside the
 * repository, because every reader of a guarded file reads through the link. See resolveLink.
 */
const REGULAR_FILE_MODE = /^100[0-7]{3}$/;
const SYMLINK_MODE = '120000';

/** The most links the guard follows from a guarded link, the guarded link itself included. */
export const MAX_GUARDED_LINKS = 8;

// git's blob id for the bytes, with the hash of the id it is compared with: SHA-1 for an id of 40
// hex characters, SHA-256 for 64. Null for any other id, which then equals nothing.
function blobIdLike(bytes: Uint8Array, like: string): string | null {
  const algorithm = like.length === 40 ? 'sha1' : like.length === 64 ? 'sha256' : null;
  if (algorithm === null) {
    return null;
  }
  return createHash(algorithm).update(`blob ${String(bytes.byteLength)}\0`).update(bytes).digest('hex');
}

function decodeText(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
}

/** One step of a link walk: a link with its text, a folder, or anything else, which ends the walk. */
type LinkStep<T> = { kind: 'link'; text: string } | { kind: 'folder'; value: T } | { kind: 'leaf'; value: T };

// A link's text joined to the folder the link is in, as path segments from the repository root.
// Null for text that names no path in the repository: an absolute path, or one whose `..` leaves
// the root.
function joinLinkText(folder: readonly string[], text: string): string[] | null {
  if (text.length === 0 || text.startsWith('/')) {
    return null;
  }
  const segments = [...folder];
  for (const part of text.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      if (segments.pop() === undefined) {
        return null;
      }
      continue;
    }
    segments.push(part);
  }
  return segments;
}

/**
 * What a guarded link at `linkPath` with `text` resolves to, inside the repository: the path and
 * the step there. Each folder on the way is looked up too, so a link in the middle of the path is
 * followed as the file system follows it. At most MAX_GUARDED_LINKS links are followed, the
 * guarded one included. Null when the link resolves outside the repository, loops, passes the
 * limit, or names nothing, and the guard then reads the link as changed. The repository root is
 * not a path the guard compares, so a link to it is null too.
 */
async function resolveLink<T>(
  linkPath: string,
  text: string,
  lookup: (path: string) => Promise<LinkStep<T> | null>,
): Promise<{ path: string; step: LinkStep<T> } | null> {
  let followed = 1;
  let segments = joinLinkText(linkPath.split('/').slice(0, -1), text);
  while (segments !== null && segments.length > 0) {
    let next: string[] | null = null;
    for (let i = 0; i < segments.length; i += 1) {
      const path = segments.slice(0, i + 1).join('/');
      const step = await lookup(path);
      const last = i === segments.length - 1;
      if (step === null) {
        return null;
      }
      if (step.kind === 'link') {
        if (followed >= MAX_GUARDED_LINKS) {
          return null;
        }
        followed += 1;
        const joined = joinLinkText(segments.slice(0, i), step.text);
        next = joined === null ? null : [...joined, ...segments.slice(i + 1)];
        break;
      }
      if (last) {
        return { path, step };
      }
      if (step.kind === 'leaf') {
        // A file or a submodule holds no path below it.
        return null;
      }
    }
    segments = next;
  }
  return null;
}

/**
 * The part of a git reader the guard compares refs with: the tree entry listing. Every text the
 * guard reads at a ref, a link's text or the config, comes from the listing itself, read by the
 * id the listing gave, so the text and the id are always from the same tree.
 */
type EntryReader = Pick<GitReader, 'listEntries'>;

// A link's text as its listing read it. A link listed without its text has no text the guard can
// trust, so it reads as empty text, which resolves to nothing and compares as changed.
function linkTextOf(entry: TreeEntry): string {
  return entry.text ?? '';
}

// A lookup of one path at a ref for resolveLink.
function refLookup(git: EntryReader, ref: string): (path: string) => Promise<LinkStep<TreeEntry> | null> {
  return async (path) => {
    const entry = (await git.listEntries(ref, [path], { recursive: false, text: 'links' })).get(path);
    if (entry === undefined) {
      return null;
    }
    if (entry.mode === SYMLINK_MODE) {
      return { kind: 'link', text: linkTextOf(entry) };
    }
    return entry.type === 'tree' ? { kind: 'folder', value: entry } : { kind: 'leaf', value: entry };
  };
}

type WorkingFile = { mode: string; bytes: Uint8Array };

// A lookup of one path on the working tree for resolveLink.
function workingLookup(readBytes: (path: string) => Promise<StoredEntry | null>): (path: string) => Promise<LinkStep<WorkingFile | null> | null> {
  return async (path) => {
    const entry = await readBytes(path);
    if (entry === null) {
      return null;
    }
    if (entry.kind === 'symlink') {
      return { kind: 'link', text: decodeText(entry.target) };
    }
    return entry.kind === 'folder' ? { kind: 'folder', value: null } : { kind: 'leaf', value: entry };
  };
}

/**
 * What a path at a ref stores, as text that is equal for two paths exactly when they store the
 * same thing: nothing, or the mode and the id, and for a link also the path it resolves to and
 * the mode and id there. `resolved` is false for a link that does not resolve, which compares as
 * changed even against itself. The session pins hash this same text. The entry comes from a
 * listing asked for link text, so a link's text is the one its id names.
 */
async function refIdentity(
  git: EntryReader,
  ref: string,
  path: string,
  entry: TreeEntry | null,
): Promise<{ text: string; resolved: boolean }> {
  if (entry === null) {
    return { text: JSON.stringify(['absent']), resolved: true };
  }
  if (entry.mode !== SYMLINK_MODE) {
    return { text: JSON.stringify([entry.mode, entry.id]), resolved: true };
  }
  const target = await resolveLink(path, linkTextOf(entry), refLookup(git, ref));
  if (target === null || target.step.kind === 'link') {
    return { text: JSON.stringify([entry.mode, entry.id, 'unresolved']), resolved: false };
  }
  return {
    text: JSON.stringify([entry.mode, entry.id, target.path, target.step.value.mode, target.step.value.id]),
    resolved: true,
  };
}

/** The reads the local guard compares with, and git's core.fileMode. */
interface LocalReads {
  git: EntryReader;
  readBytes: (path: string) => Promise<StoredEntry | null>;
  trustedRef: string;
  tracksMode: boolean;
}

// A working tree file against a trusted entry. With core.fileMode false, git ignores the executable
// bit on disk and keeps the mode it recorded for a regular file, so the guard compares the bytes
// only, and a file system with no executable bit does not read every guarded file as changed.
function sameFile(reads: LocalReads, file: WorkingFile, trusted: TreeEntry): boolean {
  if (!REGULAR_FILE_MODE.test(trusted.mode)) {
    return false;
  }
  if (reads.tracksMode && file.mode !== trusted.mode) {
    return false;
  }
  return blobIdLike(file.bytes, trusted.id) === trusted.id;
}

/**
 * A working tree path against its trusted entry. A folder on disk is nothing, as git stores no
 * folder. A link is equal only when its text is equal and both sides resolve, inside the
 * repository, to the same path holding the same file. A link to a folder compares as changed: the
 * folder's content cannot be compared without reading all of it.
 */
async function sameLocal(reads: LocalReads, path: string, working: StoredEntry | null, trusted: TreeEntry | null): Promise<boolean> {
  const onDisk = working?.kind === 'folder' ? null : working;
  if (onDisk === null || trusted === null) {
    return onDisk === null && trusted === null;
  }
  if (onDisk.kind === 'file') {
    return sameFile(reads, onDisk, trusted);
  }
  if (trusted.mode !== SYMLINK_MODE || blobIdLike(onDisk.target, trusted.id) !== trusted.id) {
    return false;
  }
  // The link texts are equal, so both sides resolve the same text.
  const text = decodeText(onDisk.target);
  const [local, atRef] = await Promise.all([
    resolveLink(path, text, workingLookup(reads.readBytes)),
    resolveLink(path, text, refLookup(reads.git, reads.trustedRef)),
  ]);
  if (local === null || atRef === null || local.path !== atRef.path) {
    return false;
  }
  if (local.step.kind !== 'leaf' || atRef.step.kind !== 'leaf' || local.step.value === null) {
    return false;
  }
  return sameFile(reads, local.step.value, atRef.step.value);
}

/**
 * A reader of guarded paths at refs, for the CI policy check. The tree entry read is required, so
 * every guarded path is compared by mode and id. There is no text compare to fall back to: text
 * reads two byte sequences that are not valid UTF-8, and a link and a file with the same text, as
 * the same.
 */
type RefReader = EntryReader;

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
 * the working tree once for each expansion. At 256 a check took about 0.4 seconds on an idle
 * machine and up to 1.5 seconds on a loaded one; at 65,536 it took about 31 seconds, long enough
 * for a Stop hook to time out and let the stop through. The time depends on the machine.
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

// The dot names under an entry that guards every file under its path: a literal entry and a wide
// reading. The matcher and the git listings take dot-named files there, but fs.glob skips a dot
// name under `**` unless the pattern names one. A glob reading keeps Node's dot rule, so it has
// none. Under a file the patterns match nothing.
function workingTreeDotGlobs(entry: GuardedEntry): string[] {
  if (entry.glob && entry.readWide === null) {
    return [];
  }
  const under = entry.path === '' ? '' : entry.path + '/';
  return [under + '**/.*', under + '**/.*/**'];
}

// Git never tracks a path with a `.git` segment, so such a path is git's own data and never
// guarded content. The dot listing would otherwise list every file in `.git/`.
function trackablePaths(paths: string[]): string[] {
  return paths.filter((path) => !path.split('/').includes('.git'));
}

// Every file under a folder, listed from the folder itself: the plain names, and the dot-named
// files and the files in dot-named folders, which fs.glob skips under `**` unless a pattern names
// a dot.
const EVERY_FILE_UNDER = ['**', '**/.*', '**/.*/**'];

/**
 * What the working tree holds at a literal entry, with its name read as plain text. Node's glob
 * has no escape, so a name such as `reqs[1]` put into a pattern lists `reqs1`, and a name past the
 * glob reading bound lists nothing. So the files under the entry are listed with the entry as the
 * walk's start, less git's own data below it. The entry itself is looked up by name in its folder:
 * a file or a link there is listed, as a pattern that names it lists it, and a folder is not.
 *
 * Null when the reader cannot list a folder that way and the name holds no glob syntax: the
 * patterns then read the name as written. When the name does hold glob syntax, no pattern can
 * name it, so this throws rather than list another folder. A guard that throws blocks the stop.
 */
async function literalEntryFiles(fs: FsGlob, path: string): Promise<string[] | null> {
  const globUnder = fs.globUnder;
  if (globUnder === undefined) {
    if (holdsNodeGlobSyntax(path)) {
      throw new Error(
        `usabl cannot list the guarded path ${operatorText(path)} on the working tree: its name holds characters a ` +
          'glob reads as a pattern, and this file reader lists files only with patterns.',
      );
    }
    return null;
  }
  const slash = path.lastIndexOf('/');
  const folder = slash === -1 ? '' : path.slice(0, slash);
  const name = path.slice(slash + 1);
  const [under, beside] = await Promise.all([
    globUnder.call(fs, path, EVERY_FILE_UNDER),
    globUnder.call(fs, folder, [name.startsWith('.') ? '.*' : '*']),
  ]);
  const prefix = path + '/';
  // Only the part below the entry is checked for `.git`, so an entry inside such a folder still
  // lists its plain files, as its patterns did. Node lists the walk's start as `<path>/` when it is
  // not a folder; the lookup by name finds it instead.
  const files = under.filter(
    (found) => found.startsWith(prefix) && found.length > prefix.length && !found.slice(prefix.length).split('/').includes('.git'),
  );
  return [...new Set([...(beside.includes(path) ? [path] : []), ...files])].sort();
}

// What fs.glob finds for one entry. A literal entry is listed by its name. Any other entry gets the
// plain listing as found, as before, joined with the dot listing less git's own data. Listing more
// can only report more.
async function workingTreeFiles(deps: Deps, entry: GuardedEntry): Promise<string[]> {
  if (!entry.glob && entry.path !== '') {
    const byName = await literalEntryFiles(deps.fs, entry.path);
    if (byName !== null) {
      return byName;
    }
  }
  const dotGlobs = workingTreeDotGlobs(entry);
  const [plain, dots] = await Promise.all([
    deps.fs.glob(workingTreeGlobs(entry)),
    dotGlobs.length === 0 ? Promise.resolve([]) : deps.fs.glob(dotGlobs),
  ]);
  return [...new Set([...plain, ...trackablePaths(dots)])].sort();
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
    Promise.all(entries.map((entry) => workingTreeFiles(deps, entry))),
  ]);
  return selectGuarded(entries, refListings.flat(), workingByEntry);
}

/**
 * The same expansion as expandEntries, from tree entry listings instead of name listings, so one
 * listing per ref gives both the guarded paths and what each ref stores at them.
 */
async function expandWithListings(
  deps: Deps,
  entries: GuardedEntry[],
  refs: readonly string[],
): Promise<{ paths: string[]; listings: Map<string, Map<string, TreeEntry>> }> {
  const prefixes = listingPrefixes(entries);
  const unique = [...new Set(refs)];
  const [refListings, workingByEntry] = await Promise.all([
    Promise.all(unique.map((ref) => deps.git.listEntries(ref, prefixes, { recursive: true, text: 'links' }))),
    Promise.all(entries.map((entry) => workingTreeFiles(deps, entry))),
  ]);
  const listings = new Map(unique.map((ref, index) => [ref, refListings[index] ?? new Map<string, TreeEntry>()]));
  const paths = selectGuarded(
    entries,
    refListings.flatMap((listing) => [...listing.keys()]),
    workingByEntry,
  );
  return { paths, listings };
}

// The scope config, or null when the config the guard must read from does not parse. With the
// config unchanged, that means the guard cannot know what it guards, so it reports the config.
// With the config changed, the scope comes from the trusted ref even if that read fails, so a pull
// request cannot hide other guarded files by breaking the config.
function scopeConfigFrom(configDiverged: boolean, scopeRaw: string | null): GuardConfigSource | 'config-unreadable' {
  const scopeConfig = scopeRaw === null ? null : parseGuardConfigBytes(scopeRaw);
  if (scopeConfig === null && !configDiverged) {
    return 'config-unreadable';
  }
  return scopeConfig ?? { guardedPaths: [] };
}

/**
 * Config-first scope is an honesty boundary.
 * If config bytes diverge, guarded set still comes from the trusted ref so a
 * PR cannot hide other dirty policy files by shrinking guardedPaths.
 * Every diverged guarded path is returned. The gate needs the full list so
 * CODEOWNERS approval cannot be satisfied by the config owner alone.
 */
export async function checkGuard(deps: Deps, trustedRef = 'HEAD'): Promise<string[]> {
  const fs = deps.fs;
  const readBytes = fs.readBytes;
  if (readBytes === undefined) {
    return checkGuardAsText(deps, trustedRef);
  }
  const reads: LocalReads = {
    git: deps.git,
    // Called on the reader itself, so a reader whose byte read calls its own readFile still does.
    readBytes: (path) => readBytes.call(fs, path),
    trustedRef,
    tracksMode: await deps.git.tracksFileMode(),
  };
  const [workingConfig, trustedConfigs] = await Promise.all([
    reads.readBytes(CONFIG_PATH),
    deps.git.listEntries(trustedRef, [CONFIG_PATH], { recursive: false, text: 'blobs' }),
  ]);
  const trustedConfig = trustedConfigs.get(CONFIG_PATH) ?? null;
  const configDiverged = !(await sameLocal(reads, CONFIG_PATH, workingConfig, trustedConfig));

  // Scope is trusted-ref config when the config diverged, read by the id the compare used. An
  // unchanged config can use the working-tree parse because it is the same document. A config that
  // is a link is read through the link, as the config loader reads it; the compare above checked
  // what it resolves to.
  const scopeRaw = configDiverged
    ? (trustedConfig?.text ?? null)
    : workingConfig?.kind === 'file'
      ? decodeText(workingConfig.bytes)
      : workingConfig?.kind === 'symlink'
        ? await fs.readFile(CONFIG_PATH)
        : null;
  const scope = scopeConfigFrom(configDiverged, scopeRaw);
  if (scope === 'config-unreadable') {
    return [CONFIG_PATH];
  }

  // The file reader has no git, so a guarded submodule reads as a folder or as nothing on the
  // working tree side, never as a commit, and the local guard reports it as changed on every run.
  // That fails safe. Reading the commit checked out in the submodule needs git run inside it, and
  // a wrong "unchanged" here would let a stop take the fast path past a moved submodule. The CI
  // policy check compares two refs, where git records the commit, so it reads a submodule at the
  // same commit as unchanged.
  const { paths, listings } = await expandWithListings(deps, readGuardedEntries(scope), [trustedRef, 'HEAD']);
  const trustedEntries = listings.get(trustedRef) ?? new Map<string, TreeEntry>();
  const diverged: string[] = [];
  for (const path of paths) {
    const working = await reads.readBytes(path);
    const trusted = trustedEntries.get(path) ?? null;
    // Optional ledgers may be absent in both places early in a repo lifecycle.
    if (!(await sameLocal(reads, path, working, trusted))) {
      diverged.push(path);
    }
  }
  return diverged.sort();
}

// The local guard for a file reader without a byte read, such as one a test builds: both sides
// read as text, as the guard did before it compared what git stores. Every file reader usabl
// itself builds has the byte read. It stays optional in the file reader type because the run also
// builds a file reader of that type with readFile and glob only, for coverage, which never reaches
// the guard.
async function checkGuardAsText(deps: Deps, trustedRef: string): Promise<string[]> {
  const [workingConfig, trustedConfig] = await Promise.all([
    deps.fs.readFile(CONFIG_PATH),
    deps.git.show(trustedRef, CONFIG_PATH),
  ]);
  const configDiverged = workingConfig !== trustedConfig;
  const scope = scopeConfigFrom(configDiverged, configDiverged ? trustedConfig : workingConfig);
  if (scope === 'config-unreadable') {
    return [CONFIG_PATH];
  }
  const expanded = await expandConfigGuardedSet(deps, scope, trustedRef);
  const diverged: string[] = [];
  for (const path of expanded) {
    const [working, trusted] = await Promise.all([deps.fs.readFile(path), deps.git.show(trustedRef, path)]);
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
  git: RefReader,
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
  git: RefReader,
  trustedRef: string,
  workingRef: string,
): Promise<{ diverged: string[]; readWide: string[] }> {
  // The type requires the tree entry read. A reader built past the type without one is refused,
  // never compared as text.
  if (typeof git.listEntries !== 'function') {
    throw new Error(
      'usabl cannot check guarded policy files: the git reader it was given cannot list tree entries, ' +
        'so usabl checked nothing. This is a fault in usabl itself, not in the repository.',
    );
  }
  const reader: EntryReader = {
    listEntries: (ref, paths, options) => git.listEntries(ref, paths, options),
  };
  // The config's entry, with its text read by the id the listing gave, and what the ref stores
  // there. The scope is parsed from that same text, so the compare and the parse read one tree.
  const configAt = async (ref: string) => {
    const entry = (await reader.listEntries(ref, [CONFIG_PATH], { recursive: false, text: 'blobs' })).get(CONFIG_PATH) ?? null;
    return { text: entry?.text ?? null, identity: await refIdentity(reader, ref, CONFIG_PATH, entry) };
  };
  const [workingConfig, trustedConfig] = await Promise.all([configAt(workingRef), configAt(trustedRef)]);
  const configDiverged = !sameIdentity(workingConfig.identity, trustedConfig.identity);
  const scope = scopeConfigFrom(configDiverged, configDiverged ? trustedConfig.text : workingConfig.text);
  if (scope === 'config-unreadable') {
    return { diverged: [CONFIG_PATH], readWide: [] };
  }

  // Each ref is listed once, and the same matcher the local guard uses selects the guarded files,
  // so a glob entry lists its files at both refs and a file the head deleted is still compared.
  // The same listing gives each path's mode and id, so no file content is read.
  const entries = readGuardedEntries(scope);
  const readWide = [...new Set(entries.filter((entry) => entry.readWide !== null).map(readWideNotice))];
  const prefixes = listingPrefixes(entries);
  const [trustedEntries, workingEntries] = await Promise.all([
    reader.listEntries(trustedRef, prefixes, { recursive: true, text: 'links' }),
    reader.listEntries(workingRef, prefixes, { recursive: true, text: 'links' }),
  ]);
  const expanded = selectGuarded(entries, [...trustedEntries.keys(), ...workingEntries.keys()]);

  const diverged: string[] = [];
  for (const path of expanded) {
    const working = workingEntries.get(path) ?? null;
    const trusted = trustedEntries.get(path) ?? null;
    if (working === null && trusted === null) {
      continue;
    }
    const [atWorking, atTrusted] = await Promise.all([
      refIdentity(reader, workingRef, path, working),
      refIdentity(reader, trustedRef, path, trusted),
    ]);
    if (!sameIdentity(atWorking, atTrusted)) {
      diverged.push(path);
    }
  }
  return { diverged: diverged.sort(), readWide };
}

// Two refs store the same thing at a path. A link that does not resolve is never the same.
function sameIdentity(a: { text: string; resolved: boolean }, b: { text: string; resolved: boolean }): boolean {
  return a.resolved && b.resolved && a.text === b.text;
}

/**
 * The pin format. Each pin is `v4:` and a sha256 over a fixed label and what HEAD stores at the
 * path, as refIdentity gives it: nothing, or the mode and the object id, and for a link also the
 * path it resolves to and the mode and id there. That text is JSON of short strings, so two
 * different entries never give the same input. Earlier releases stored the bare hash of the
 * decoded text, where two bytes that are not valid UTF-8, a file and a link with the same text, or
 * a file and a submodule could pin the same. A stored pin of any other format never equals a pin
 * of this one; see pinsAreCurrent for what the Stop hook does with such pins.
 */
export const SESSION_PIN_FORMAT = 'v4';
const PIN_PREFIX = `${SESSION_PIN_FORMAT}:`;

function pinOf(identity: { text: string }): string {
  return `${PIN_PREFIX}${createHash('sha256').update(`usabl session pin\n${identity.text}`, 'utf8').digest('hex')}`;
}

/**
 * Whether every stored pin is in the current format. Pins an older usabl wrote say nothing this
 * usabl can compare, so the Stop hook cannot tell whether policy changed in the session. It blocks
 * and says so, and never takes the current state as the baseline.
 */
export function pinsAreCurrent(pins: SessionPins): boolean {
  return Object.values(pins).every((pin) => pin.startsWith(PIN_PREFIX));
}

/**
 * Session pins fingerprint committed state for later stop-hook reuse: one listing of HEAD gives
 * each guarded path's mode and id. A link that does not resolve pins the same on every stop, and
 * the local guard reports it as changed on every stop instead.
 *
 * The pins also carry the local checkout state, by the names git.checkoutState gives: the sparse
 * checkout settings and pattern file, and the empty submodule folders. The changed list reads a
 * missing file as left out on purpose under that state, so an agent that wrote its own patterns,
 * or emptied a submodule folder, and deleted a screen file got a list without it. Only the pins
 * remember the state from the start of the session, so a change to it is drift, as a changed
 * guarded file is. A guarded path with the same name pins both texts, so neither one hides the
 * other.
 * This unit stays pure and does not write pin state to disk.
 */
export async function computeSessionPins(deps: Deps, config: UsablConfig): Promise<SessionPins> {
  const { paths, listings } = await expandWithListings(deps, readGuardedEntries(config), ['HEAD']);
  const head = listings.get('HEAD') ?? new Map<string, TreeEntry>();
  const texts = new Map<string, string>();
  for (const path of paths) {
    texts.set(path, (await refIdentity(deps.git, 'HEAD', path, head.get(path) ?? null)).text);
  }
  for (const [name, state] of Object.entries(await deps.git.checkoutState())) {
    texts.set(name, JSON.stringify(['checkout state', state, texts.get(name) ?? null]));
  }
  const pins: SessionPins = {};
  for (const name of [...texts.keys()].sort()) {
    pins[name] = pinOf({ text: texts.get(name) ?? '' });
  }
  return pins;
}

/**
 * The paths whose pins differ, or that one side lacks. A stored pin of another format is changed
 * even if its text matched, so an old pin never vouches for a path.
 */
export function diffSessionPins(previous: SessionPins, next: SessionPins): string[] {
  const changed: string[] = [];
  const allPaths = new Set<string>([...Object.keys(previous), ...Object.keys(next)]);
  for (const path of allPaths) {
    const before = previous[path];
    if (before !== next[path] || before === undefined || !before.startsWith(PIN_PREFIX)) {
      changed.push(path);
    }
  }
  return changed.sort();
}

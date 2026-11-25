/**
 * Real GitReader adapter backed by git CLI commands.
 * This unit reports repository facts only and must never decide coverage or verdicts.
 * Missing HEAD blobs return null so the guard can disclose not-covered work honestly.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { GitReader, TreeEntry } from '../contracts/index.js';
import { operatorText } from '../intake/config-error.js';
import { GIT_ENVIRONMENT, gitProcessEnvironment } from './git-environment.js';
import { makeWorktreeReader, NoHeadError } from './worktree.js';

const execFileAsync = promisify(execFile);
const NUL = '\0';
const MISSING_SHOW_PATTERNS = [
  /does not exist in/i,
  /exists on disk, but not in/i,
  /pathspec .* did not match/i,
];

function readErrorCode(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) {
    return null;
  }
  const code = Reflect.get(err, 'code');
  return typeof code === 'number' ? code : null;
}

function readErrorStderr(err: unknown): string {
  if (typeof err !== 'object' || err === null) {
    return '';
  }
  const stderr = Reflect.get(err, 'stderr');
  return typeof stderr === 'string' ? stderr : '';
}

function isMissingShow(stderr: string): boolean {
  return MISSING_SHOW_PATTERNS.some((pattern) => pattern.test(stderr));
}

/** The error for a repository with no last commit, such as a new one or an orphan branch. */
export const NO_HEAD_MESSAGE =
  'git cannot read HEAD. If this repository has no commits yet, make a first commit, then run ' +
  'usabl again. usabl compares policy files with the last commit.';

// The ref itself does not exist. Still an error, never a missing file: reading no policy at all
// as "no policy" would let a run pass against nothing. The message names the fix, because a new
// repository with no commits and a CI checkout without the trusted ref both land here.
async function missingRefError(ref: string, stderr: string, listRemotes: () => Promise<string[]>): Promise<Error | null> {
  if (!/invalid object name/i.test(stderr)) {
    return null;
  }
  return refNotFoundError(ref, listRemotes);
}

// The remote names are read only for a ref whose hint may name a remote: never for HEAD or a
// commit id.
async function refNotFoundError(ref: string, listRemotes: () => Promise<string[]>): Promise<Error> {
  if (ref === 'HEAD') {
    return new Error(NO_HEAD_MESSAGE);
  }
  if (COMMIT_ID.test(ref)) {
    return new Error(
      `git cannot read ${operatorText(ref)}. usabl reads trusted policy from that commit. Check the commit id. ` +
        'A shallow checkout often lacks it, so fetch more history, such as fetch-depth: 0 in actions/checkout, ' +
        'then run usabl again.',
    );
  }
  return new Error(
    `git cannot read ${operatorText(ref)}. usabl reads trusted policy from that ref. Check its name, ` +
      `or fetch it first (${fetchExample(ref, await listRemotes())}), then run usabl again.`,
  );
}

// A commit id, whole or shortened, as the CI workflow passes the base commit. git fetch takes no
// fixed form for it that works on every host, so the hint for it gives no fetch command.
const COMMIT_ID = /^[0-9a-f]{7,64}$/iu;

/**
 * The fetch example for a missing branch ref. A ref such as upstream/develop is the branch develop
 * on the remote upstream only when upstream is a remote. A ref such as feature/foo, whose first
 * part names no remote, is a branch with a slash in its name, so the example fetches it by its
 * whole name into a branch of that name. With no remote to compare against, both readings are
 * given, each with its own command. A ref with no slash names no remote, so the example says how
 * to find the default branch instead of guessing that it is called main.
 *
 * Each name from the ref or a remote goes through operatorText on its own, so only a long name is
 * capped and the fixed text of the example is always printed whole.
 */
function fetchExample(ref: string, remotes: readonly string[]): string {
  const branchRef = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/u.test(ref) && !ref.startsWith('refs/');
  if (!branchRef) {
    return 'git remote show origin prints the default branch as HEAD branch; fetch it with git fetch origin <branch>';
  }
  const shownRef = operatorText(ref);
  // The longest remote name that the ref starts with, since a remote name may hold a slash.
  const remote = [...remotes].sort((a, b) => b.length - a.length).find((name) => ref.startsWith(`${name}/`));
  if (remote !== undefined) {
    return `for example git fetch ${operatorText(remote)} ${operatorText(ref.slice(remote.length + 1))}`;
  }
  const slash = ref.indexOf('/');
  const first = operatorText(ref.slice(0, slash));
  const asRemote = `git fetch ${first} ${operatorText(ref.slice(slash + 1))}`;
  const asBranch = (name: string): string => `git fetch ${operatorText(name)} ${shownRef}:${shownRef}`;
  if (remotes.length === 0) {
    return `for example ${asRemote} if ${first} is a remote, or ${asBranch('origin')} if ${shownRef} is a branch on origin`;
  }
  const from = remotes.includes('origin') ? 'origin' : [...remotes].sort()[0] ?? 'origin';
  return `for example ${asBranch(from)}`;
}

// usabl accepts no ref that is empty, starts with a dash or a caret, or holds two dots, a colon,
// *, ?, [, a backslash, white space, or a control character. White space here includes non-ASCII
// spaces that git itself allows in a ref name, and control characters include U+0080 to U+009F.
// git reads such a value another way: a dash starts an option, a leading caret or two dots make a
// negative or range revision, a colon starts a path inside a commit, and a glob character makes
// git show HEAD filtered by a pathspec. Each of those can come back as an empty or absent file
// for a ref usabl never read. So every function that takes a ref from a person refuses one of
// these before it calls git.
const UNREADABLE_REF = /^[-^]|\.\.|[:*?[\\\s\u0000-\u001f\u007f-\u009f]/u;

/** The error for a value usabl cannot use as a ref. Its message names the value and the fix. */
export class RefRefusedError extends Error {
  override name = 'RefRefusedError';
}

/** Throws when git would read the ref as something other than a ref. Call it before any git call. */
export function assertReadableRef(ref: string): void {
  if (ref.length === 0 || UNREADABLE_REF.test(ref)) {
    throw new RefRefusedError(
      `usabl cannot use "${operatorText(ref)}" as a git ref. A ref name cannot be empty, start with a dash ` +
        'or a caret, or hold two dots, a colon, *, ?, [, a backslash, white space, or a control character. ' +
        'Name a branch, a tag, or a commit id, then run usabl again.',
    );
  }
}

// HEAD does not exist, so the working tree cannot be read against it. A new repository with no
// commits, or an orphan branch with none yet, lands here. git's own text is left out: the message
// says what happened and the step that clears it.
function noHeadForTreeError(stderr: string): Error | null {
  if (!/not a valid object name|invalid object name/i.test(stderr)) {
    return null;
  }
  return firstCommitError();
}

function firstCommitError(): Error {
  return new Error(
    'git cannot read HEAD, so usabl cannot read the working tree to check it. This repository has ' +
      'no commits yet, or the branch has none. Make a first commit, then run usabl again.',
  );
}

// Every listing runs with -z. Without it git quotes and escapes a name that holds a byte above
// 0x7f, a newline, a tab, or a double quote, and a quoted name matches no glob, so a changed
// screen could read as nothing to check. Names are split on NUL and never trimmed: a name may
// start or end with a space, and it is still the file git stores.
function splitNul(output: string): string[] {
  return output.split(NUL).filter((entry) => entry.length > 0);
}

// `git ls-tree -z` prints "MODE TYPE SHA\tNAME\0". The name is everything after the first tab.
// Each name maps to "MODE SHA": the mode is kept next to the id, so an executable bit or a file
// swapped for a symbolic link with the same text, which keeps the id, still changes the policy
// hash. The names are collected in a Map, and Object.fromEntries defines each one as its own key.
// An assignment on a plain object would drop a file named __proto__ at the repository root, and
// that file would fall out of the policy hash.
function parseLsTree(output: string): Record<string, string> {
  const blobs = new Map<string, string>();
  for (const entry of splitNul(output)) {
    const tab = entry.indexOf('\t');
    if (tab < 0) {
      continue;
    }
    const [mode, , sha] = entry.slice(0, tab).split(' ');
    if (mode !== undefined && sha !== undefined) {
      blobs.set(entry.slice(tab + 1), `${mode} ${sha}`);
    }
  }
  return Object.fromEntries(blobs);
}

function parseLsFiles(output: string): string[] {
  return [...new Set(splitNul(output))].sort();
}

function parseNameOnly(output: string): string[] {
  return [...new Set(splitNul(output))];
}

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

// Every git command here gets GIT_ENVIRONMENT (see git-environment.ts): English messages, literal
// paths, and objects and parents read as stored.

async function runGit(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  maxBuffer: number = DEFAULT_MAX_BUFFER,
): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer,
    env: { ...gitProcessEnvironment(), ...env, ...GIT_ENVIRONMENT },
  });
  return stdout;
}

function isMaxBufferError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && Reflect.get(err, 'code') === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
}

// The remote names, for a fetch hint only. A failure gives no names, and the hint then gives both
// readings of the ref.
async function listRemotes(cwd: string): Promise<string[]> {
  try {
    return (await runGit(cwd, ['remote']))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

// What to do when a change listing is too long: it most often holds a large folder of new files.
const CHANGED_FILES_ADVICE =
  'This most often means a large folder of new files that .gitignore does not cover. Add that folder to ' +
  '.gitignore, or commit it, then run usabl again.';

// What to do when the guarded path listing is too long. It lists committed files, so .gitignore
// does not shorten it. A guarded glob that starts with a wildcard, such as **/x.json, lists every file.
const GUARDED_LISTING_ADVICE =
  'A guarded glob lists too many files: a guardedPaths entry that starts with a wildcard, such as ' +
  '**/x.json, lists every file in the repository. Start the entry with a folder name, such as ' +
  'policy/**/x.json, then run usabl again.';

// A listing longer than the buffer makes execFile throw with a terse message. usabl then cannot
// know which files changed, so the run must stop with an error a person can act on. It never
// reads a cut-off list as the whole list.
async function runListing(
  cwd: string,
  args: string[],
  maxBuffer: number,
  advice: string = CHANGED_FILES_ADVICE,
): Promise<string> {
  try {
    return await runGit(cwd, args, undefined, maxBuffer);
  } catch (err) {
    if (isMaxBufferError(err)) {
      throw listingTooLongError(args[0] ?? '', advice);
    }
    throw err;
  }
}

function listingTooLongError(command: string, advice: string): Error {
  return new Error(
    `git ${command} printed more than usabl reads, so usabl could not list the files it needs ` +
      `and checked nothing. ${advice}`,
  );
}

// A file too large to read as text. usabl stops and says so, never with a raw buffer error and
// never with a cut-off text.
function tooLargeToReadError(path: string, ref: string, maxBuffer: number): Error {
  return new Error(
    `usabl could not read ${operatorText(path)} at ${operatorText(ref)}: it is larger than the ` +
      `${String(Math.floor(maxBuffer / (1024 * 1024)))} MiB usabl reads as text, so usabl checked nothing. ` +
      'Keep a policy file that usabl parses under that size, then run usabl again. The guard ' +
      'compares a large guarded file without reading it as text.',
  );
}

// True when the ref names a commit in this repository. With --verify --quiet, git exits 1 and
// prints nothing when it does not. Any other failure is not an answer, so it is thrown.
async function namesCommit(cwd: string, ref: string): Promise<boolean> {
  try {
    await runGit(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
    return true;
  } catch (err) {
    if (readErrorCode(err) === 1) {
      return false;
    }
    throw err;
  }
}

// The type git gives the object, such as blob or tree, or null when git cannot say.
async function objectType(cwd: string, object: string): Promise<string | null> {
  try {
    return (await runGit(cwd, ['cat-file', '-t', '--end-of-options', object])).trim();
  } catch {
    return null;
  }
}

// How show reads a submodule path: this prefix, then the commit id the tree records for it. It
// starts with a lone surrogate (U+D800). Decoding bytes as UTF-8 never gives one, so no file read
// can return this text. A hash of the UTF-8 bytes does not keep this apart: encoding turns the lone
// surrogate into U+FFFD, which a file can hold. So no compare or hash of guarded paths uses this
// text. The guard reads guarded paths with listEntries, where a submodule has its own mode.
const SUBMODULE_READ_PREFIX = '\ud800submodule commit ';

// What a failed `cat-file blob` read means: nothing at the path, a folder, or a submodule. Any
// other failure is thrown, so a read usabl could not make never passes as an absent file.
async function readFailedBlob(
  cwd: string,
  ref: string,
  path: string,
  err: unknown,
): Promise<{ kind: 'absent' } | { kind: 'folder' } | { kind: 'submodule'; commit: string }> {
  const code = readErrorCode(err);
  const stderr = readErrorStderr(err);
  if (code !== null && isMissingShow(stderr)) {
    // For a full commit id git gives the missing-file text even when the commit itself is
    // not in the repository, as in a shallow clone. The file is absent only when the ref
    // names a commit here. Otherwise usabl could not read the ref at all.
    if (await namesCommit(cwd, ref)) {
      return { kind: 'absent' };
    }
    throw await refNotFoundError(ref, () => listRemotes(cwd));
  }
  // cat-file blob refuses a folder and a submodule entry. So the guard reads a policy file that
  // became a folder, or the reverse, as a change an approval can clear.
  if (code !== null && /bad file/i.test(stderr)) {
    if ((await objectType(cwd, `${ref}:${path}`)) === 'tree') {
      return { kind: 'folder' };
    }
    const commit = await submoduleCommit(cwd, ref, path);
    if (commit !== null) {
      return { kind: 'submodule', commit };
    }
  }
  throw (await missingRefError(ref, stderr, () => listRemotes(cwd))) ?? err;
}

const FULL_OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

// `git ls-tree -z` entries as a Map by name, so a name such as __proto__ is kept as its own key.
// With `only`, just the entries with one of those exact names. With GIT_LITERAL_PATHSPECS each
// path after -- is its exact name, never a pattern or pathspec magic.
function parseTreeEntries(output: string, only?: ReadonlySet<string>): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  for (const line of splitNul(output)) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const name = line.slice(tab + 1);
    if (only !== undefined && !only.has(name)) continue;
    const [mode, type, id] = line.slice(0, tab).split(' ');
    if (mode !== undefined && type !== undefined && id !== undefined && FULL_OBJECT_ID.test(id)) {
      entries.set(name, { mode, type, id });
    }
  }
  return entries;
}

// The commit id the tree at the ref records for a submodule at the path, or null when the path is
// not a submodule there. ls-tree reads the tree entry only, so the answer is the same whether or not
// the submodule's commit is in the repository, which it usually is not, and it does not depend on
// the working tree. ls-tree matches each path given after -- by its exact name, never as a pattern.
// --full-tree reads the path from the root of the tree, as <ref>:<path> does. Without it, ls-tree
// run from a subfolder reads the path under that subfolder.
async function submoduleCommit(cwd: string, ref: string, path: string): Promise<string | null> {
  let output: string;
  try {
    output = await runGit(cwd, ['ls-tree', '-z', '--full-tree', '--end-of-options', ref, '--', path]);
  } catch {
    return null;
  }
  for (const entry of splitNul(output)) {
    const tab = entry.indexOf('\t');
    if (tab < 0 || entry.slice(tab + 1) !== path) continue;
    const [mode, type, id] = entry.slice(0, tab).split(' ');
    if (mode === '160000' && type === 'commit' && id !== undefined && FULL_OBJECT_ID.test(id)) {
      return id;
    }
  }
  return null;
}

export function makeGitReader(options: { cwd?: string; maxBuffer?: number } = {}): GitReader {
  const cwd = options.cwd ?? process.cwd();
  // The buffer size is an option only so tests can reach the over-limit path with a small repository.
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  // One working tree reader for the life of this git reader, so its hash cache spans the reads of
  // one run and of one stop, and no longer.
  const worktree = makeWorktreeReader({ cwd, maxBuffer, tooLong: (command) => listingTooLongError(command, CHANGED_FILES_ADVICE) });

  return {
    async statusZ() {
      // The changed list comes from the bytes on disk, compared with HEAD: see worktree.ts. A
      // repository with no commits yet has no HEAD, so every file there is new.
      return worktree.changes();
    },
    async diffNameOnly(ref) {
      assertReadableRef(ref);
      // Triple-dot compares merge-base..HEAD so CI sees PR-impact files even when status is clean.
      // The closing -- keeps git from reading <ref>...HEAD as a path when a file has that name.
      const output = await runListing(
        cwd,
        ['diff', '--name-only', '-z', '--end-of-options', `${ref}...HEAD`, '--'],
        maxBuffer,
      );
      return parseNameOnly(output);
    },
    async show(ref, path) {
      assertReadableRef(ref);
      try {
        // cat-file reads objects only. git show reads <ref>:<path> as a path when it names no
        // object and a working tree file has that exact name, so a file a pull request commits
        // could stand in for a trusted read. --end-of-options keeps a ref that starts with a dash
        // from being read as an option.
        const output = await runGit(cwd, ['cat-file', 'blob', '--end-of-options', `${ref}:${path}`], undefined, maxBuffer);
        return output;
      } catch (err) {
        if (isMaxBufferError(err)) {
          throw tooLargeToReadError(path, ref, maxBuffer);
        }
        const failed = await readFailedBlob(cwd, ref, path, err);
        if (failed.kind === 'absent') {
          return null;
        }
        // git show prints a folder's listing, which is never the bytes of a file. The closing --
        // makes git read the argument as an object name only, so a working tree file with that
        // name is never read in its place.
        if (failed.kind === 'folder') {
          return runGit(cwd, ['show', '--end-of-options', `${ref}:${path}`, '--']);
        }
        return `${SUBMODULE_READ_PREFIX}${failed.commit}\n`;
      }
    },
    async listEntries(ref, paths, { recursive, text = 'none' }) {
      // One ls-tree for every path, so a ref is read once. The mode and the object id say what the
      // ref stores, so no file content is read. --full-tree reads each path from the root of the
      // tree, whatever folder usabl runs in.
      assertReadableRef(ref);
      if (paths.length === 0) {
        return new Map();
      }
      const unique = [...new Set(paths)].sort();
      const args = ['ls-tree', '-z', '--full-tree', ...(recursive ? ['-r'] : []), '--end-of-options', ref];
      if (!(recursive && unique.includes(''))) {
        args.push('--', ...unique);
      }
      let output: string;
      try {
        output = await runListing(cwd, args, maxBuffer, GUARDED_LISTING_ADVICE);
      } catch (err) {
        // A ref git cannot read is the same error show gives for it, never an empty listing that
        // would read as no guarded files.
        if (/not a valid object name|invalid object name|not a tree object|bad object/i.test(readErrorStderr(err))) {
          throw await refNotFoundError(ref, () => listRemotes(cwd));
        }
        throw err;
      }
      // Without recursion, ls-tree also lists what is in a folder named with a trailing slash, so
      // only the exact names asked for are kept.
      const entries = parseTreeEntries(output, recursive ? undefined : new Set(unique));
      // Text is read by the id this listing gave, never by <ref>:<path> again, so it comes from the
      // same tree as the mode and the id even if the ref moves in between.
      for (const [path, entry] of entries) {
        if (entry.type === 'blob' && (text === 'blobs' || (text === 'links' && entry.mode === '120000'))) {
          try {
            entry.text = await runGit(cwd, ['cat-file', 'blob', entry.id], undefined, maxBuffer);
          } catch (err) {
            throw isMaxBufferError(err) ? tooLargeToReadError(path, ref, maxBuffer) : err;
          }
        }
      }
      return entries;
    },
    async tracksFileMode() {
      // git exits 1 when the setting is not there, and then reads the executable bit. Any other
      // failure also reads as true, so the guard reports a mode change rather than miss one.
      try {
        return (await runGit(cwd, ['config', '--bool', '--get', 'core.fileMode'])).trim() !== 'false';
      } catch {
        return true;
      }
    },
    async lsTree(ref, paths) {
      assertReadableRef(ref);
      if (paths.length === 0) {
        return {};
      }
      const output = await runListing(cwd, ['ls-tree', '-z', '--end-of-options', ref, '--', ...paths], maxBuffer);
      return parseLsTree(output);
    },
    async lsFiles(ref, prefix) {
      assertReadableRef(ref);
      const output = await runListing(
        cwd,
        ['ls-tree', '-r', '--name-only', '-z', '--end-of-options', ref, '--', prefix],
        maxBuffer,
      );
      return parseLsFiles(output);
    },
    async lsFilesUnder(ref, prefixes) {
      // One listing for every prefix, so a ref is read once however many guarded entries share it.
      // ls-tree matches each prefix as a path or a folder, never as a pattern.
      assertReadableRef(ref);
      if (prefixes.length === 0) {
        return [];
      }
      const unique = [...new Set(prefixes)].sort();
      const args = ['ls-tree', '-r', '--name-only', '-z', '--end-of-options', ref];
      if (!unique.includes('')) {
        args.push('--', ...unique);
      }
      return parseLsFiles(await runListing(cwd, args, maxBuffer, GUARDED_LISTING_ADVICE));
    },
    async writeTree() {
      // The tree of the bytes on disk, as the checks read them: see worktree.ts.
      try {
        return await worktree.tree();
      } catch (err) {
        if (err instanceof NoHeadError) {
          throw firstCommitError();
        }
        throw err;
      }
    },
    async indexedTree() {
      // The tree git add -A would commit, read through git's filters and attributes. Only the
      // history of main scans records it, from a CI checkout, so one commit keeps one tree id on
      // every runner. The receipt and the changed list never read it.
      const tempDir = await mkdtemp(join(tmpdir(), 'usabl-index-'));
      const env = { GIT_INDEX_FILE: join(tempDir, 'index') };
      try {
        try {
          await runGit(cwd, ['read-tree', 'HEAD'], env);
        } catch (err) {
          throw noHeadForTreeError(readErrorStderr(err)) ?? err;
        }
        await runGit(cwd, ['add', '-A', '--', '.'], env);
        return (await runGit(cwd, ['write-tree'], env)).trim();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    async headRef() {
      return (await runGit(cwd, ['rev-parse', 'HEAD'])).trim();
    },
  };
}

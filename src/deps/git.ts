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
import type { GitReader } from '../contracts/index.js';
import { operatorText } from '../intake/config-error.js';

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
function missingRefError(ref: string, stderr: string): Error | null {
  if (!/invalid object name/i.test(stderr)) {
    return null;
  }
  return refNotFoundError(ref);
}

function refNotFoundError(ref: string): Error {
  if (ref === 'HEAD') {
    return new Error(NO_HEAD_MESSAGE);
  }
  return new Error(
    `git cannot read ${operatorText(ref)}. usabl reads trusted policy from that ref. Check its name, ` +
      `or fetch it first (${fetchExample(ref)}), then run usabl again.`,
  );
}

// A remote-tracking ref such as upstream/develop names its own fetch, so the example uses it. Any
// other ref names no remote, so the example says how to find the default branch instead of
// guessing that it is called main.
function fetchExample(ref: string): string {
  const remoteBranch = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._/-]+)$/u.exec(ref);
  if (remoteBranch?.[1] !== undefined && remoteBranch[2] !== undefined && remoteBranch[1] !== 'refs') {
    return `for example git fetch ${remoteBranch[1]} ${remoteBranch[2]}`;
  }
  return 'git remote show origin prints the default branch as HEAD branch; fetch it with git fetch origin <branch>';
}

// HEAD does not exist, so the working tree cannot be read against it. A new repository with no
// commits, or an orphan branch with none yet, lands here. git's own text is left out: the message
// says what happened and the step that clears it.
function noHeadForTreeError(stderr: string): Error | null {
  if (!/not a valid object name|invalid object name/i.test(stderr)) {
    return null;
  }
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

// `git status --porcelain -z` prints a rename or copy as "XY NEW\0OLD\0": the new name comes
// first and the old one follows as its own entry. The new name is the file in the tree, so it is
// the one reported, and the old name is skipped.
function parseStatus(output: string): Array<{ code: string; path: string }> {
  const parsed: Array<{ code: string; path: string }> = [];
  const entries = splitNul(output);

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] ?? '';
    const status = entry.slice(0, 2);
    const statusCode = status.trim();
    const path = entry.slice(3);
    if (statusCode.length === 0) {
      continue;
    }
    parsed.push({ code: statusCode, path });
    if (status.includes('R') || status.includes('C')) {
      i += 1;
    }
  }

  return parsed;
}

// `git ls-tree -z` prints "MODE TYPE SHA\tNAME\0". The name is everything after the first tab.
// The names are collected in a Map, and Object.fromEntries defines each one as its own key. An
// assignment on a plain object would drop a file named __proto__ at the repository root, and that
// file would fall out of the policy hash.
function parseLsTree(output: string): Record<string, string> {
  const blobs = new Map<string, string>();
  for (const entry of splitNul(output)) {
    const tab = entry.indexOf('\t');
    if (tab < 0) {
      continue;
    }
    const sha = entry.slice(0, tab).split(' ')[2];
    if (sha !== undefined) {
      blobs.set(entry.slice(tab + 1), sha);
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

// usabl tells a missing file from a failure by git's error text, and git translates that text
// into the user's language. LC_ALL=C keeps it in English whatever the locale, so a missing policy
// file never reads as a crash on one machine and as absent on another. With -z, file names are
// raw bytes, so the locale does not change how they are listed.
const ENGLISH_MESSAGES = { LC_ALL: 'C' };

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
    env: { ...process.env, ...env, ...ENGLISH_MESSAGES },
  });
  return stdout;
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
    if (typeof err === 'object' && err !== null && Reflect.get(err, 'code') === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new Error(
        `git ${args[0] ?? ''} printed more than usabl reads, so usabl could not list the files it needs ` +
          `and checked nothing. ${advice}`,
      );
    }
    throw err;
  }
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

export function makeGitReader(options: { cwd?: string; maxBuffer?: number } = {}): GitReader {
  const cwd = options.cwd ?? process.cwd();
  // The buffer size is an option only so tests can reach the over-limit path with a small repository.
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;

  return {
    async statusZ() {
      // --untracked-files=all lists each new file on its own. Without it git lists a new folder as
      // the folder alone, and a user's status.showUntrackedFiles=no hides new files completely, so
      // a new screen file would match no UI glob and read as nothing to check.
      const output = await runListing(cwd, ['status', '--porcelain', '-z', '--untracked-files=all'], maxBuffer);
      return parseStatus(output);
    },
    async diffNameOnly(ref) {
      // Triple-dot compares merge-base..HEAD so CI sees PR-impact files even when status is clean.
      const output = await runListing(cwd, ['diff', '--name-only', '-z', `${ref}...HEAD`], maxBuffer);
      return parseNameOnly(output);
    },
    async show(ref, path) {
      try {
        // --end-of-options keeps a ref that starts with a dash from being read as an option.
        const output = await runGit(cwd, ['show', '--end-of-options', `${ref}:${path}`]);
        return output;
      } catch (err) {
        const code = readErrorCode(err);
        const stderr = readErrorStderr(err);
        if (code !== null && isMissingShow(stderr)) {
          // For a full commit id git gives the missing-file text even when the commit itself is
          // not in the repository, as in a shallow clone. The file is absent only when the ref
          // names a commit here. Otherwise usabl could not read the ref at all.
          if (await namesCommit(cwd, ref)) {
            return null;
          }
          throw refNotFoundError(ref);
        }
        throw missingRefError(ref, stderr) ?? err;
      }
    },
    async lsTree(ref, paths) {
      if (paths.length === 0) {
        return {};
      }
      const output = await runListing(cwd, ['ls-tree', '-z', ref, '--', ...paths], maxBuffer);
      return parseLsTree(output);
    },
    async lsFiles(ref, prefix) {
      const output = await runListing(cwd, ['ls-tree', '-r', '--name-only', '-z', ref, '--', prefix], maxBuffer);
      return parseLsFiles(output);
    },
    async lsFilesUnder(ref, prefixes) {
      // One listing for every prefix, so a ref is read once however many guarded entries share it.
      // ls-tree matches each prefix as a path or a folder, never as a pattern.
      if (prefixes.length === 0) {
        return [];
      }
      const unique = [...new Set(prefixes)].sort();
      const args = ['ls-tree', '-r', '--name-only', '-z', ref];
      if (!unique.includes('')) {
        args.push('--', ...unique);
      }
      return parseLsFiles(await runListing(cwd, args, maxBuffer, GUARDED_LISTING_ADVICE));
    },
    async writeTree() {
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

/**
 * The working tree as the checks see it: the bytes on disk, compared with the blobs HEAD stores.
 *
 * The tree a receipt binds and the list of changed files both come from one walk. git lists the
 * paths, usabl reads the kind and the bytes of each path itself, and the bytes are hashed with no
 * filter at all. git is never asked whether a file changed, and never asked to convert bytes for
 * that answer. So no setting or file the agent can write from inside the repository can make an
 * edited file read unchanged: not an index flag, the index's saved file info (core.trustctime,
 * core.ignoreStat), an fsmonitor hook, an attribute (ident, working-tree-encoding, filter), a filter
 * driver, or a sparse pattern for a file that is on disk. No filter program and no hook runs.
 *
 * This unit reports repository facts only and never decides coverage or verdicts.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, type BigIntStats } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { operatorText } from '../intake/config-error.js';
import { GIT_ENVIRONMENT } from './git-environment.js';

/** One changed path, from the repository root, with a status letter like git status prints. */
export interface WorktreeChange {
  code: string;
  path: string;
}

/** Thrown when the working tree cannot be read against HEAD because HEAD does not exist. */
export class NoHeadError extends Error {
  override name = 'NoHeadError';
}

// Listings that git may never make long enough to need a limit, such as the HEAD tree, are read in
// full. The new-file listing has the same limit and advice as the other change listings.
export interface WorktreeOptions {
  cwd: string;
  maxBuffer: number;
  tooLong: (command: string) => Error;
}

// Settings forced on every listing. git walks the folders itself and never asks the agent's
// fsmonitor hook, and never trusts the untracked cache. An empty core.fsmonitor turns the hook off
// in every git usabl supports: older git reads the value as a hook path, newer git as true or false.
const LISTING_SETTINGS = ['-c', 'core.fsmonitor=', '-c', 'core.untrackedCache=false'];

interface GitResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  overLimit: boolean;
}

function runGit(
  cwd: string,
  args: readonly string[],
  options: { input?: Buffer; env?: Record<string, string>; maxBuffer?: number } = {},
): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', [...args], {
      cwd,
      env: { ...process.env, ...options.env, ...GIT_ENVIRONMENT },
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let overLimit = false;
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (options.maxBuffer !== undefined && size > options.maxBuffer) {
        overLimit = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => resolve({ code: null, stdout: Buffer.alloc(0), stderr: err.message, overLimit }));
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(chunks), stderr, overLimit }));
    if (options.input !== undefined && child.stdin !== null) {
      // A command that ends before it reads all of stdin closes the pipe. Its exit code says so.
      child.stdin.on('error', () => {});
      child.stdin.end(options.input);
    }
  });
}

function firstLineOf(text: string): string {
  return operatorText(text.split('\n')[0] ?? '');
}

async function mustGit(cwd: string, args: readonly string[], what: string, input?: Buffer): Promise<Buffer> {
  const result = await runGit(cwd, args, input === undefined ? {} : { input });
  if (result.code !== 0) {
    throw new Error(`git ${what} failed, so usabl could not read the working tree. ${firstLineOf(result.stderr)}`.trim());
  }
  return result.stdout;
}

function splitNul(output: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  let end = output.indexOf(0, start);
  while (end >= 0) {
    if (end > start) {
      parts.push(output.subarray(start, end));
    }
    start = end + 1;
    end = output.indexOf(0, start);
  }
  if (start < output.length) {
    parts.push(output.subarray(start));
  }
  return parts;
}

// A name in git's C quoting: every byte outside printable ASCII as three octal digits, and " and
// \ escaped. git hash-object --stdin-paths reads a line that starts with a double quote this way,
// so every name, one with a newline or with bytes that are not UTF-8 included, reaches it whole.
function cQuote(raw: Buffer): string {
  let quoted = '"';
  for (const byte of raw) {
    if (byte === 0x22 || byte === 0x5c) {
      quoted += `\\${String.fromCharCode(byte)}`;
    } else if (byte >= 0x20 && byte <= 0x7e) {
      quoted += String.fromCharCode(byte);
    } else {
      quoted += `\\${byte.toString(8).padStart(3, '0')}`;
    }
  }
  return `${quoted}"`;
}

/** The repository the reader works in, as git reports it, after the root check. */
interface Repository {
  top: string;
  topBytes: Buffer;
  format: 'sha1' | 'sha256';
  sparsePatterns: string;
  fileMode: boolean;
  sparse: boolean;
}

/**
 * The repository root, from git, as a physical path. The folder usabl was given must be the root
 * or a folder inside it. When it is not, a setting such as core.worktree has pointed git at another
 * folder, so git would list and hash files the dev server does not serve, and the reader stops with
 * an error rather than read them.
 */
async function openRepository(cwd: string): Promise<Repository> {
  const lines = (
    await mustGit(
      cwd,
      ['rev-parse', '--show-toplevel', '--show-object-format', '--git-path', 'info/sparse-checkout'],
      'rev-parse',
    )
  )
    .toString('utf8')
    .split('\n');
  const [shownTop = '', format = '', sparsePatterns = ''] = lines;
  let top: string;
  let here: string;
  try {
    top = realpathSync.native(shownTop);
    here = realpathSync.native(cwd);
  } catch {
    throw new Error(`usabl could not read the folder git names as the repository root, ${operatorText(shownTop)}.`);
  }
  const inside = relative(top, here);
  if (inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(
      'git reads the working tree from a folder outside the one usabl runs in, so usabl would check files the ' +
        'dev server does not serve and checked nothing. This most often means core.worktree is set in .git/config. ' +
        'Remove it with git config --unset core.worktree, then run usabl again.',
    );
  }
  const config = async (key: string): Promise<string> =>
    (await runGit(top, ['config', '--bool', '--get', key])).stdout.toString('utf8').trim();
  return {
    top,
    topBytes: Buffer.from(`${top}/`),
    format: format.trim() === 'sha256' ? 'sha256' : 'sha1',
    // git prints the pattern file's path from the folder it ran in when it is not absolute.
    sparsePatterns: isAbsolute(sparsePatterns) ? sparsePatterns : join(cwd, sparsePatterns),
    // git reads the executable bit unless core.fileMode is false. The bit changes no byte a check
    // reads, so the setting decides only the mode the tree records.
    fileMode: (await config('core.fileMode')) !== 'false',
    sparse: (await config('core.sparseCheckout')) === 'true',
  };
}

interface Entry {
  raw: Buffer;
  headMode?: string;
  headId?: string;
  indexMode?: string;
  inIndex: boolean;
  skipWorktree: boolean;
}

type Kind = 'missing' | 'file' | 'link' | 'folder' | 'other';

function kindOf(path: Buffer): { kind: Kind; stats?: BigIntStats } {
  try {
    const stats = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (stats === undefined) {
      return { kind: 'missing' };
    }
    const kind = stats.isFile() ? 'file' : stats.isSymbolicLink() ? 'link' : stats.isDirectory() ? 'folder' : 'other';
    return { kind, stats };
  } catch (err) {
    // A path below a file is not there either. Any other failure is a path usabl cannot read.
    return { kind: typeof err === 'object' && err !== null && Reflect.get(err, 'code') === 'ENOTDIR' ? 'missing' : 'other' };
  }
}

const TAB = 0x09;
const FULL_OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/u;

/**
 * Every path the walk reads: each entry of the base tree (HEAD, or the commit a submodule's outer
 * repository records), each entry of the index, and each new file git does not ignore. The index is
 * read only for the names it holds and its skip-worktree tag. Its ids and its saved file info are
 * never trusted.
 */
async function listPaths(repo: Repository, base: string | null, options: WorktreeOptions): Promise<{ entries: Entry[]; untracked: Buffer[] }> {
  const byName = new Map<string, Entry>();
  const entries: Entry[] = [];
  const entryFor = (raw: Buffer): Entry => {
    const key = raw.toString('latin1');
    let entry = byName.get(key);
    if (entry === undefined) {
      entry = { raw: Buffer.from(raw), inIndex: false, skipWorktree: false };
      byName.set(key, entry);
      entries.push(entry);
    }
    return entry;
  };
  if (base !== null) {
    const listed = await runGit(repo.top, ['ls-tree', '-r', '-z', '--full-tree', '--end-of-options', base]);
    if (listed.code !== 0) {
      if (base === 'HEAD' && /not a valid object name|invalid object name/iu.test(listed.stderr)) {
        throw new NoHeadError(listed.stderr);
      }
      throw new Error(`git ls-tree failed, so usabl could not read the working tree. ${firstLineOf(listed.stderr)}`.trim());
    }
    for (const record of splitNul(listed.stdout)) {
      const tab = record.indexOf(TAB);
      if (tab < 0) continue;
      const [mode, , id] = record.subarray(0, tab).toString('latin1').split(' ');
      if (mode === undefined || id === undefined || !FULL_OBJECT_ID.test(id)) continue;
      const entry = entryFor(record.subarray(tab + 1));
      entry.headMode = mode;
      entry.headId = id;
    }
  }
  // "TAG MODE ID STAGE\tNAME". S, or a lower case s, is the skip-worktree tag.
  for (const record of splitNul(await mustGit(repo.top, [...LISTING_SETTINGS, 'ls-files', '-v', '-s', '-z'], 'ls-files'))) {
    const tab = record.indexOf(TAB);
    if (tab < 0) continue;
    const entry = entryFor(record.subarray(tab + 1));
    entry.inIndex = true;
    const indexMode = record.subarray(2, tab).toString('latin1').split(' ')[0];
    if (indexMode !== undefined) entry.indexMode = indexMode;
    const tag = record[0];
    entry.skipWorktree ||= tag === 0x53 || tag === 0x73;
  }
  // New files one by one. A user's status.showUntrackedFiles does not apply to ls-files.
  const others = await runGit(repo.top, [...LISTING_SETTINGS, 'ls-files', '-z', '--others', '--exclude-standard'], {
    maxBuffer: options.maxBuffer,
  });
  if (others.overLimit) {
    throw options.tooLong('ls-files');
  }
  if (others.code !== 0) {
    throw new Error(`git ls-files failed, so usabl could not list new files. ${firstLineOf(others.stderr)}`.trim());
  }
  const untracked: Buffer[] = [];
  for (const raw of splitNul(others.stdout)) {
    if (!byName.has(raw.toString('latin1'))) {
      untracked.push(Buffer.from(raw));
    }
  }
  return { entries, untracked };
}

function blobId(repo: Repository, bytes: Buffer): string {
  return createHash(repo.format).update(`blob ${String(bytes.length)}\0`).update(bytes).digest('hex');
}

// Files hashed by one git process at most. Larger sets are split over a few processes at once.
const HASH_CHUNK = 2000;
const HASH_PROCESSES = 4;

async function hashWith(repo: Repository, raws: readonly Buffer[], args: readonly string[], env?: Record<string, string>): Promise<Array<string | null>> {
  if (raws.length === 0) {
    return [];
  }
  const parts = raws.length <= HASH_CHUNK ? 1 : HASH_PROCESSES;
  const size = Math.ceil(raws.length / parts);
  const chunks = Array.from({ length: parts }, (_, index) => raws.slice(index * size, (index + 1) * size));
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      if (chunk.length === 0) return [];
      const input = Buffer.from(chunk.map((raw) => `${cQuote(raw)}\n`).join(''), 'latin1');
      const result = await runGit(repo.top, args, { input, ...(env === undefined ? {} : { env }) });
      // A failure, such as a file removed in between, gives null for every file in the chunk.
      if (result.code !== 0) return chunk.map(() => null);
      const lines = result.stdout.toString('latin1').split('\n');
      return chunk.map((_, index) => {
        const line = lines[index];
        return line !== undefined && FULL_OBJECT_ID.test(line) ? line : null;
      });
    }),
  );
  return results.flat();
}

// The blob ids of the bytes on disk, with no filter, no attribute, and no line ending rule.
function rawIds(repo: Repository, raws: readonly Buffer[]): Promise<Array<string | null>> {
  return hashWith(repo, raws, ['hash-object', '--no-filters', '--stdin-paths']);
}

// The blob ids of the bytes on disk with each CR LF read as LF, and nothing else changed. git does
// the work, in a scratch repository: its own attributes file turns off every filter, ident, and
// encoding for every path and asks for line ending conversion only, and the repository's own
// .git/config and .git/info/attributes are never read.
async function lineEndingIds(repo: Repository, raws: readonly Buffer[]): Promise<Array<string | null>> {
  if (raws.length === 0) {
    return [];
  }
  const scratch = await mkdtemp(join(tmpdir(), 'usabl-line-endings-'));
  try {
    const gitDir = join(scratch, 'repository');
    const made = await runGit(scratch, ['init', '-q', '--bare', gitDir]);
    if (made.code !== 0) {
      return raws.map(() => null);
    }
    await writeFile(join(gitDir, 'info', 'attributes'), '* text -filter -ident -working-tree-encoding\n');
    return await hashWith(
      repo,
      raws,
      ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', 'hash-object', '--stdin-paths'],
      { GIT_DIR: gitDir, GIT_WORK_TREE: repo.top },
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// Blobs read for the last compare: an LFS pointer or a file with an $Id$ marker. Larger blobs are
// never one of those, and the file then counts as changed.
const BLOB_READ_LIMIT = 8 * 1024 * 1024;

async function readBlobs(repo: Repository, ids: readonly string[]): Promise<Map<string, Buffer>> {
  const blobs = new Map<string, Buffer>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return blobs;
  }
  const checked = await runGit(repo.top, ['cat-file', '--batch-check'], { input: Buffer.from(unique.map((id) => `${id}\n`).join('')) });
  if (checked.code !== 0) {
    return blobs;
  }
  const sizes = checked.stdout.toString('latin1').split('\n');
  const small = unique.filter((_, index) => {
    const [, type, size] = (sizes[index] ?? '').split(' ');
    return type === 'blob' && Number(size) <= BLOB_READ_LIMIT;
  });
  if (small.length === 0) {
    return blobs;
  }
  const read = await runGit(repo.top, ['cat-file', '--batch'], { input: Buffer.from(small.map((id) => `${id}\n`).join('')) });
  if (read.code !== 0) {
    return blobs;
  }
  let at = 0;
  for (const id of small) {
    const newline = read.stdout.indexOf(0x0a, at);
    if (newline < 0) break;
    const [shownId, type, size] = read.stdout.subarray(at, newline).toString('latin1').split(' ');
    const length = Number(size);
    if (shownId !== id || type !== 'blob' || !Number.isInteger(length)) break;
    blobs.set(id, Buffer.from(read.stdout.subarray(newline + 1, newline + 1 + length)));
    at = newline + 1 + length + 1;
  }
  return blobs;
}

const CRLF = Buffer.from([0x0d, 0x0a]);

function crlfToLf(bytes: Buffer): Buffer {
  let at = bytes.indexOf(CRLF);
  if (at < 0) {
    return bytes;
  }
  const out = Buffer.allocUnsafe(bytes.length);
  let length = 0;
  let from = 0;
  while (at >= 0) {
    length += bytes.copy(out, length, from, at);
    from = at + 1;
    at = bytes.indexOf(CRLF, from);
  }
  length += bytes.copy(out, length, from);
  return out.subarray(0, length);
}

// An LFS pointer, exactly: the version line, the sha256 of the content, its size, and nothing else.
const LFS_POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (0|[1-9][0-9]*)\n$/u;

function sha256OfFile(path: Buffer): Promise<{ hex: string; size: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let size = 0;
    createReadStream(path)
      .on('data', (chunk) => {
        const bytes = chunk as Buffer;
        size += bytes.length;
        hash.update(bytes);
      })
      .on('end', () => resolve({ hex: hash.digest('hex'), size }))
      .on('error', reject);
  });
}

// What checkout writes for the $Id$ markers in a blob: each one holds the blob id. It is a function
// of the blob alone, so a file matches it only when it holds exactly those bytes. Text inside a
// marker can never change unseen.
function identExpanded(blob: Buffer, id: string): Buffer {
  const text = blob.toString('latin1');
  if (!text.includes('$Id')) {
    return blob;
  }
  return Buffer.from(text.replace(/\$Id(?::[^$\n]*)?\$/gu, `$Id: ${id} $`), 'latin1');
}

/**
 * Whether bytes on disk that are not the blob's bytes are still the committed content: the content
 * an LFS pointer names, or the blob with its $Id$ markers as checkout writes them, line endings
 * aside. Each form follows from the blob alone, so each accepts one content only.
 */
async function sameContent(path: Buffer, id: string, blob: Buffer | undefined): Promise<boolean> {
  if (blob === undefined) {
    return false;
  }
  const pointer = LFS_POINTER.exec(blob.toString('latin1'));
  if (pointer !== null) {
    const { hex, size } = await sha256OfFile(path);
    return hex === pointer[1] && String(size) === pointer[2];
  }
  if (!blob.includes('$Id')) {
    return false;
  }
  const disk = readFileSync(path);
  if (disk.length > BLOB_READ_LIMIT * 2) {
    return false;
  }
  return crlfToLf(disk).equals(crlfToLf(identExpanded(blob, id)));
}

/**
 * The hashes one reader keeps between its own reads, in memory only, for one process. A file's
 * entry is used only while usabl's own lstat gives the same device, inode, size, modification time,
 * and change time, to the nanosecond. A process that is not root cannot set the change time, so an
 * edit that keeps the size and restores the modification time still reads as an edit. A file
 * changed within two seconds of the read is never kept, because a second edit within one clock tick
 * of the file system would not move its times.
 */
interface CachedHash {
  signature: string;
  raw: string;
  lineEndings: string | null;
  // The HEAD blob these bytes were found to be the content of (an LFS pointer, or $Id$ markers),
  // so a large LFS file is not read again on every read.
  sameAs?: string;
}

export type HashCache = Map<string, CachedHash>;

const RACY_WINDOW_NS = 2_000_000_000n;

function signatureOf(stats: BigIntStats): string {
  return `${String(stats.dev)}:${String(stats.ino)}:${String(stats.size)}:${String(stats.mtimeNs)}:${String(stats.ctimeNs)}`;
}

/** One record of the tree: its mode, its blob id, and its name from the repository root. */
interface TreeRecord {
  mode: string;
  id: string;
  raw: Buffer;
}

interface Walk {
  records: TreeRecord[];
  changes: Array<{ code: string; raw: Buffer }>;
}

const REGULAR_MODES: ReadonlySet<string> = new Set(['100644', '100755']);
const LINK_MODE = '120000';
const SUBMODULE_MODE = '160000';
// Submodules inside submodules are walked too, to this depth.
const MAX_DEPTH = 8;

// A blob id that never matches any earlier read, for a path usabl could not read. A tree that holds
// one never equals a stored receipt's tree, so that stop checks again.
function unreadableId(repo: Repository): string {
  return blobId(repo, Buffer.from(`usabl: a path usabl could not read ${String(process.hrtime.bigint())} ${String(Math.random())}`));
}

/**
 * The missing skip-worktree files that git says are outside the sparse set, by name in hex. Used
 * only when core.sparseCheckout is true. git reads the patterns itself (`git sparse-checkout
 * check-rules`, git 2.41 or later). When git cannot answer, no file is outside: a missing pattern
 * file, one with no pattern line, a folder in its place, a failure, or an older git. A pattern
 * file with no pattern made check-rules call every file outside, so a deletion read as no change.
 */
async function outsideSparseSet(repo: Repository, raws: readonly Buffer[]): Promise<Set<string>> {
  const outside = new Set<string>();
  if (raws.length === 0) {
    return outside;
  }
  let patterns: string;
  try {
    const kind = kindOf(Buffer.from(repo.sparsePatterns));
    if (kind.kind !== 'file') return outside;
    patterns = readFileSync(repo.sparsePatterns, 'latin1');
  } catch {
    return outside;
  }
  if (!patterns.split('\n').some((line) => line.trim().length > 0 && !line.startsWith('#'))) {
    return outside;
  }
  const input = Buffer.concat(raws.flatMap((raw) => [raw, Buffer.from([0])]));
  const result = await runGit(repo.top, ['sparse-checkout', 'check-rules', '-z'], { input });
  if (result.code !== 0) {
    return outside;
  }
  const inside = new Set(splitNul(result.stdout).map((raw) => raw.toString('hex')));
  for (const raw of raws) {
    if (!inside.has(raw.toString('hex'))) {
      outside.add(raw.toString('hex'));
    }
  }
  return outside;
}

// Entries read with one synchronous lstat each, between two turns of the event loop, so a deadline
// timer still fires on time in a large repository.
const LSTAT_CHUNK = 2000;

/**
 * Walks one repository: the top one against HEAD, or a submodule against the commit its outer
 * repository records (null when that commit is not there, so every file is new). Names in the
 * result are from this repository's root; `prefix` is the path of this repository in the top one.
 */
async function walk(
  repo: Repository,
  base: string | null,
  prefix: Buffer,
  cache: HashCache,
  options: WorktreeOptions,
  depth: number,
): Promise<Walk> {
  const started = BigInt(Date.now()) * 1_000_000n;
  const { entries, untracked } = await listPaths(repo, base, options);
  const records: TreeRecord[] = [];
  const changes: Walk['changes'] = [];
  const named = (raw: Buffer): Buffer => (prefix.length === 0 ? raw : Buffer.concat([prefix, raw]));
  const onDisk = (raw: Buffer): Buffer => Buffer.concat([repo.topBytes, raw]);

  // A folder found missing once answers for every file in it, as sparse checkout leaves whole
  // folders out. Only a missing folder is kept: a folder that is there says nothing about the file.
  const missingFolders = new Set<string>();
  const kindAt = (raw: Buffer): { kind: Kind; stats?: BigIntStats } => {
    const slash = raw.lastIndexOf(0x2f);
    if (slash > 0) {
      const folder = raw.subarray(0, slash).toString('latin1');
      if (missingFolders.has(folder)) return { kind: 'missing' };
      const found = kindOf(onDisk(raw));
      if (found.kind === 'missing' && kindOf(onDisk(raw.subarray(0, slash))).kind === 'missing') {
        missingFolders.add(folder);
      }
      return found;
    }
    return kindOf(onDisk(raw));
  };

  const files: Array<{ raw: Buffer; stats: BigIntStats; entry: Entry | null }> = [];
  const missingSkipped: Entry[] = [];
  const nested: Array<{ raw: Buffer; entry: Entry | null }> = [];
  const all: Array<{ raw: Buffer; entry: Entry | null }> = [
    ...entries.map((entry) => ({ raw: entry.raw, entry })),
    ...untracked.map((raw) => ({ raw, entry: null })),
  ];
  for (let start = 0; start < all.length; start += LSTAT_CHUNK) {
    if (start > 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    for (const { raw: listed, entry } of all.slice(start, start + LSTAT_CHUNK)) {
      // git lists a nested repository as its folder with a trailing slash.
      const raw = listed[listed.length - 1] === 0x2f ? listed.subarray(0, listed.length - 1) : listed;
      const tracked = entry?.headId !== undefined;
      const found = kindAt(raw);
      if (found.kind === 'missing') {
        if (!tracked) continue;
        if (entry !== null && entry.skipWorktree && repo.sparse) {
          missingSkipped.push(entry);
        } else {
          changes.push({ code: 'D', raw });
        }
      } else if (found.kind === 'file' && found.stats !== undefined) {
        files.push({ raw, stats: found.stats, entry });
      } else if (found.kind === 'link') {
        let id: string;
        try {
          id = blobId(repo, readLinkBytes(onDisk(raw)));
        } catch {
          id = unreadableId(repo);
        }
        records.push({ mode: LINK_MODE, id, raw: named(raw) });
        if (!(entry?.headMode === LINK_MODE && entry.headId === id)) {
          changes.push({ code: tracked ? 'M' : entry?.inIndex === true ? 'A' : '??', raw });
        }
      } else if (
        found.kind === 'folder' &&
        (entry?.headMode === SUBMODULE_MODE || entry?.indexMode === SUBMODULE_MODE || (entry === null && listed[listed.length - 1] === 0x2f))
      ) {
        nested.push({ raw, entry });
      } else if (found.kind === 'folder') {
        // A folder where a tracked file was. The files in it are listed as new files on their own.
        if (tracked) changes.push({ code: 'M', raw });
      } else {
        // A pipe, a socket, or a path usabl cannot read: nothing a check reads, never the same twice.
        records.push({ mode: '100644', id: unreadableId(repo), raw: named(raw) });
        changes.push({ code: tracked ? 'M' : '??', raw });
      }
    }
  }

  // Hashes this reader already has for a file whose lstat did not change, and the rest from git.
  const raws: Array<string | null> = new Array<string | null>(files.length).fill(null);
  const lineEndings: Array<string | null> = new Array<string | null>(files.length).fill(null);
  const signatures = files.map((file) => signatureOf(file.stats));
  const keys = files.map((file) => onDisk(file.raw).toString('latin1'));
  const toHash: number[] = [];
  files.forEach((_, index) => {
    const hit = cache.get(keys[index] ?? '');
    if (hit !== undefined && hit.signature === signatures[index]) {
      raws[index] = hit.raw;
      lineEndings[index] = hit.lineEndings;
    } else {
      toHash.push(index);
    }
  });
  const hashed = await rawIds(repo, toHash.map((index) => files[index]?.raw ?? Buffer.alloc(0)));
  toHash.forEach((index, at) => {
    raws[index] = hashed[at] ?? null;
  });
  const needLineEndings = toHash.filter((index) => {
    const headId = files[index]?.entry?.headId;
    return raws[index] !== null && headId !== undefined && raws[index] !== headId;
  });
  const lf = await lineEndingIds(repo, needLineEndings.map((index) => files[index]?.raw ?? Buffer.alloc(0)));
  needLineEndings.forEach((index, at) => {
    lineEndings[index] = lf[at] ?? null;
  });
  for (const index of toHash) {
    const file = files[index];
    const raw = raws[index];
    if (file === undefined || raw === null || raw === undefined) continue;
    const newest = file.stats.mtimeNs > file.stats.ctimeNs ? file.stats.mtimeNs : file.stats.ctimeNs;
    if (newest < started - RACY_WINDOW_NS) {
      cache.set(keys[index] ?? '', { signature: signatures[index] ?? '', raw, lineEndings: lineEndings[index] ?? null });
    }
  }

  const differing: Array<{ raw: Buffer; headId: string; key: string; signature: string }> = [];
  files.forEach((file, index) => {
    const entry = file.entry;
    const raw = raws[index] ?? unreadableId(repo);
    const executable = repo.fileMode ? (Number(file.stats.mode) & 0o100) !== 0 : entry?.headMode === '100755';
    records.push({ mode: executable ? '100755' : '100644', id: raw, raw: named(file.raw) });
    if (entry === null || entry.headId === undefined) {
      changes.push({ code: entry?.inIndex === true ? 'A' : '??', raw: file.raw });
    } else if (entry.headMode === undefined || !REGULAR_MODES.has(entry.headMode)) {
      changes.push({ code: 'M', raw: file.raw });
    } else if (raws[index] !== entry.headId && lineEndings[index] !== entry.headId) {
      differing.push({ raw: file.raw, headId: entry.headId, key: keys[index] ?? '', signature: signatures[index] ?? '' });
    }
  });
  const unknown = differing.filter((file) => {
    const hit = cache.get(file.key);
    return !(hit !== undefined && hit.signature === file.signature && hit.sameAs === file.headId);
  });
  if (unknown.length > 0) {
    const blobs = await readBlobs(repo, unknown.map((file) => file.headId));
    for (const file of unknown) {
      const same = await sameContent(onDisk(file.raw), file.headId, blobs.get(file.headId)).catch(() => false);
      if (!same) {
        changes.push({ code: 'M', raw: file.raw });
        continue;
      }
      // Kept only on an entry the cache already holds, which is outside the two-second window.
      const hit = cache.get(file.key);
      if (hit !== undefined && hit.signature === file.signature) {
        hit.sameAs = file.headId;
      }
    }
  }

  const outside = await outsideSparseSet(repo, missingSkipped.map((entry) => entry.raw));
  for (const entry of missingSkipped) {
    if (!outside.has(entry.raw.toString('hex'))) {
      changes.push({ code: 'D', raw: entry.raw });
    }
  }

  for (const { raw, entry } of nested) {
    const inner = await nestedWalk(repo, raw, entry, named(raw), cache, options, depth);
    records.push(...inner.records);
    changes.push(...inner.changes.map((change) => ({ code: change.code, raw: Buffer.concat([raw, Buffer.from('/'), change.raw]) })));
  }
  return { records, changes };
}

// The link text as the bytes the file system stores.
function readLinkBytes(path: Buffer): Buffer {
  return readlinkSync(path, { encoding: 'buffer' });
}

/**
 * A submodule, or a repository inside the working tree that is not one: its own files by the same
 * rule, under its path. A submodule folder that holds no repository is a submodule that was never
 * set up, and the tree keeps the commit the outer repository records. One that holds files but no
 * repository cannot be compared, so the read stops with an error.
 */
async function nestedWalk(
  outer: Repository,
  raw: Buffer,
  entry: Entry | null,
  prefix: Buffer,
  cache: HashCache,
  options: WorktreeOptions,
  depth: number,
): Promise<Walk> {
  const folder = Buffer.concat([outer.topBytes, raw]).toString('utf8');
  const recorded = entry?.headMode === SUBMODULE_MODE ? entry.headId ?? null : null;
  const shown = await runGit(folder, ['rev-parse', '--show-toplevel']);
  let isRepository = false;
  try {
    isRepository = shown.code === 0 && realpathSync.native(shown.stdout.toString('utf8').replace(/\n$/u, '')) === realpathSync.native(folder);
  } catch {
    isRepository = false;
  }
  if (!isRepository) {
    if (folderIsEmpty(folder)) {
      return recorded === null ? { records: [], changes: [] } : { records: [{ mode: SUBMODULE_MODE, id: recorded, raw: prefix }], changes: [] };
    }
    throw new Error(
      `${operatorText(raw.toString('utf8'))} holds files but no git repository, so usabl cannot tell which of them ` +
        'changed and checked nothing. Set the submodule up again with git submodule update --init, then run usabl again.',
    );
  }
  if (depth >= MAX_DEPTH) {
    throw new Error('Submodules are nested deeper than usabl reads, so usabl checked nothing.');
  }
  const inner = await openRepository(folder);
  let base: string | null = null;
  if (recorded !== null && (await runGit(inner.top, ['cat-file', '-e', `${recorded}^{commit}`])).code === 0) {
    base = recorded;
  }
  return walk(inner, base, Buffer.concat([prefix, Buffer.from('/')]), cache, options, depth + 1);
}

function folderIsEmpty(folder: string): boolean {
  try {
    return readdirSync(folder).length === 0;
  } catch {
    return false;
  }
}

/** A reader of the working tree with a hash cache of its own, for the life of the git reader. */
export interface WorktreeReader {
  /** The tree id of the bytes on disk. */
  tree(): Promise<string>;
  /** The paths whose content on disk is not what HEAD holds, from the repository root, sorted. */
  changes(): Promise<WorktreeChange[]>;
}

export function makeWorktreeReader(options: WorktreeOptions): WorktreeReader {
  const cache: HashCache = new Map();
  const read = async (): Promise<{ repo: Repository; result: Walk }> => {
    const repo = await openRepository(options.cwd);
    return { repo, result: await walk(repo, 'HEAD', Buffer.alloc(0), cache, options, 0) };
  };
  return {
    async tree() {
      const { repo, result } = await read();
      const scratch = await mkdtemp(join(tmpdir(), 'usabl-index-'));
      try {
        const env = { GIT_INDEX_FILE: join(scratch, 'index') };
        const input = Buffer.concat(result.records.flatMap((record) => [Buffer.from(`${record.mode} ${record.id}\t`), record.raw, Buffer.from([0])]));
        const built = await runGit(repo.top, ['update-index', '-z', '--index-info'], { input, env });
        if (built.code !== 0) {
          throw new Error(`git update-index failed, so usabl could not read the working tree. ${firstLineOf(built.stderr)}`.trim());
        }
        // Only tree objects are written. No blob is added to the repository.
        const written = await runGit(repo.top, ['write-tree', '--missing-ok'], { env });
        if (written.code !== 0) {
          throw new Error(`git write-tree failed, so usabl could not read the working tree. ${firstLineOf(written.stderr)}`.trim());
        }
        return written.stdout.toString('latin1').trim();
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
    async changes() {
      const repo = await openRepository(options.cwd);
      let result: Walk;
      try {
        result = await walk(repo, 'HEAD', Buffer.alloc(0), cache, options, 0);
      } catch (err) {
        // A repository with no commits yet: every file in it is new.
        if (!(err instanceof NoHeadError)) throw err;
        result = await walk(repo, null, Buffer.alloc(0), cache, options, 0);
      }
      const seen = new Set<string>();
      const changes: WorktreeChange[] = [];
      for (const change of result.changes) {
        const key = change.raw.toString('latin1');
        if (seen.has(key)) continue;
        seen.add(key);
        changes.push({ code: change.code, path: change.raw.toString('utf8') });
      }
      // Plain code-unit order, so the list never depends on the order the reads finished in.
      return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    },
  };
}

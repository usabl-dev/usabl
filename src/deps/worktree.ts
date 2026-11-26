/**
 * The working tree as the checks see it: the bytes on disk, compared with the blobs HEAD stores.
 *
 * The tree a receipt binds and the list of changed files both come from one walk. usabl reads the
 * HEAD commit and its trees itself, checking each object's id, takes the index's names and the new
 * files from git, reads the kind and the bytes of each path itself, and hashes the bytes with no
 * filter at all. git is never asked whether a file changed, and never asked to convert bytes for
 * that answer. None of these changes the answer: an index flag, the index's saved file info
 * (core.trustctime, core.ignoreStat), an fsmonitor hook, core.ignorecase, an attribute (ident,
 * working-tree-encoding, filter), a filter driver, a replace ref or a graft, a variable that points
 * git elsewhere, or an object file overwritten with other bytes. No filter program and no hook
 * runs. What it does not cover is stated in the threat model: new files that .git/info/exclude
 * hides, a deletion under sparse patterns the agent wrote, and a submodule folder emptied of its
 * repository. A tree usabl cannot build from the bytes the checks read (a name git will not store,
 * or a link whose target the walk does not hash) is a tree id that never repeats.
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
import { GIT_ENVIRONMENT, gitProcessEnvironment } from './git-environment.js';

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
// core.ignorecase=false: with it true on a file system that tells case apart, git left out a new
// file whose name differs from a tracked one only in case, and a folder named .GIT. On a file
// system that does not tell case apart, false can only list more names, never fewer.
const LISTING_SETTINGS = ['-c', 'core.fsmonitor=', '-c', 'core.untrackedCache=false', '-c', 'core.ignorecase=false'];

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
      env: { ...gitProcessEnvironment(), ...options.env, ...GIT_ENVIRONMENT },
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

const ELSEWHERE_MESSAGE =
  'git reads the working tree from a folder other than the repository usabl runs in, so usabl would check files ' +
  'the dev server does not serve and checked nothing. This most often means core.worktree is set in .git/config. ' +
  'Remove it with git config --unset core.worktree, then run usabl again.';

// A real path, or null when it cannot be resolved.
function realOrNull(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/**
 * The repository root, from git, as a physical path. Three checks keep git on the repository the
 * folder usabl was given belongs to. That folder must be the root or a folder inside it. git run in
 * the root must find the same repository as git run in that folder: core.worktree naming a parent
 * folder that is a repository of its own passed the first check, and every read then listed the
 * parent's files. And core.worktree, when it is set at all, must name the root. When any check
 * fails, git would list and hash files the dev server does not serve, and the reader stops with an
 * error rather than read them.
 */
async function openRepository(cwd: string): Promise<Repository> {
  const lines = (
    await mustGit(
      cwd,
      ['rev-parse', '--show-toplevel', '--show-object-format', '--git-path', 'info/sparse-checkout', '--absolute-git-dir'],
      'rev-parse',
    )
  )
    .toString('utf8')
    .split('\n');
  const [shownTop = '', format = '', sparsePatterns = '', shownGitDir = ''] = lines;
  const top = realOrNull(shownTop);
  const here = realOrNull(cwd);
  if (top === null || here === null) {
    throw new Error(`usabl could not read the folder git names as the repository root, ${operatorText(shownTop)}.`);
  }
  const inside = relative(top, here);
  if (inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(ELSEWHERE_MESSAGE);
  }
  const gitDir = realOrNull(shownGitDir);
  const fromTop = await runGit(top, ['rev-parse', '--absolute-git-dir']);
  if (gitDir === null || fromTop.code !== 0 || realOrNull(fromTop.stdout.toString('utf8').replace(/\n$/u, '')) !== gitDir) {
    throw new Error(ELSEWHERE_MESSAGE);
  }
  // git reads a relative core.worktree from the repository folder.
  const worktree = (await runGit(top, ['config', '--path', '--get', 'core.worktree'])).stdout.toString('utf8').replace(/\n$/u, '');
  if (worktree.length > 0 && realOrNull(isAbsolute(worktree) ? worktree : join(gitDir, worktree)) !== top) {
    throw new Error(ELSEWHERE_MESSAGE);
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

// behindLink: a path with a link in its folder part. git never lists a path through a link, so a
// file reached that way is not the file the tree records.
type Kind = 'missing' | 'file' | 'link' | 'folder' | 'other' | 'behindLink';

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
const LINK_MODE = '120000';
const SUBMODULE_MODE = '160000';
const TREE_MODE = '040000';
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
    for (const record of await readBaseTree(repo, base)) {
      const entry = entryFor(record.raw);
      entry.headMode = record.mode;
      entry.headId = record.id;
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

function objectId(repo: Repository, type: string, bytes: Buffer): string {
  return createHash(repo.format).update(`${type} ${String(bytes.length)}\0`).update(bytes).digest('hex');
}

function blobId(repo: Repository, bytes: Buffer): string {
  return objectId(repo, 'blob', bytes);
}

/** One object git cat-file --batch printed: its id, its type, and its bytes, or null when missing. */
type StoredObject = { id: string; type: string; bytes: Buffer } | null;

// Objects by name, in the order asked, as git stores them. git does not check an object's id
// against its bytes when it reads it, so the caller checks.
async function readObjects(repo: Repository, names: readonly string[]): Promise<StoredObject[]> {
  if (names.length === 0) {
    return [];
  }
  const read = await runGit(repo.top, ['cat-file', '--batch'], { input: Buffer.from(names.map((name) => `${name}\n`).join('')) });
  if (read.code !== 0) {
    throw new Error(`git cat-file failed, so usabl could not read the working tree. ${firstLineOf(read.stderr)}`.trim());
  }
  const objects: StoredObject[] = [];
  let at = 0;
  for (let index = 0; index < names.length; index += 1) {
    const newline = read.stdout.indexOf(0x0a, at);
    if (newline < 0) break;
    const header = read.stdout.subarray(at, newline).toString('latin1').split(' ');
    const [id = '', type = '', size = ''] = header;
    if (header.length !== 3 || !FULL_OBJECT_ID.test(id) || !/^(0|[1-9][0-9]*)$/u.test(size)) {
      objects.push(null);
      at = newline + 1;
      continue;
    }
    const length = Number(size);
    objects.push({ id, type, bytes: Buffer.from(read.stdout.subarray(newline + 1, newline + 1 + length)) });
    at = newline + 1 + length + 1;
  }
  if (objects.length !== names.length) {
    throw new Error('git cat-file printed less than usabl asked for, so usabl could not read the working tree.');
  }
  return objects;
}

class ObjectMismatchError extends Error {
  constructor(id: string) {
    super(
      `The object ${id} in .git/objects does not hold the bytes its id names, so usabl cannot tell what the commits ` +
        'it compares hold and checked nothing. Run git fsck to find the damaged objects, then run usabl again.',
    );
  }
}

// An object of the type asked for whose bytes hash to its id. Anything else stops the read.
function verified(repo: Repository, object: StoredObject, type: string, what: string): { id: string; bytes: Buffer } {
  if (object === null || object.type !== type) {
    throw new Error(`git could not read ${what} as a ${type}, so usabl could not read the working tree.`);
  }
  if (objectId(repo, type, object.bytes) !== object.id) {
    throw new ObjectMismatchError(object.id);
  }
  return object;
}

// The mode git prints for a tree entry: the kind of entry, and the executable bit of a file. Any
// other mode reads as a submodule, as git reads it.
function canonicalMode(octal: string): string {
  const mode = Number.parseInt(octal, 8);
  switch (mode & 0o170000) {
    case 0o100000:
      return (mode & 0o100) !== 0 ? '100755' : '100644';
    case 0o120000:
      return LINK_MODE;
    case 0o040000:
      return TREE_MODE;
    default:
      return SUBMODULE_MODE;
  }
}

// HEAD that git cannot read: a damaged object when HEAD resolves to an id, never a new repository.
async function headUnreadable(repo: Repository): Promise<Error> {
  if ((await runGit(repo.top, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0) {
    return new Error(
      'HEAD names a commit that git cannot read, so .git/objects holds a damaged or overwritten object and usabl ' +
        'checked nothing. Run git fsck to find the damaged objects, then run usabl again.',
    );
  }
  return new NoHeadError('HEAD does not name a commit yet.');
}

// The tree a checked commit's bytes name on their first line.
function treeOfCommit(commit: { id: string; bytes: Buffer }): string {
  const treeLine = /^tree ([0-9a-f]{40}|[0-9a-f]{64})\n/u.exec(commit.bytes.subarray(0, 80).toString('latin1'));
  if (treeLine === null || treeLine[1] === undefined) {
    throw new Error(`usabl could not find the tree of the commit ${commit.id}, so it could not read the working tree.`);
  }
  return treeLine[1];
}

/** One entry of a tree object: its name inside the tree, its mode as git prints it, and its id. */
interface TreeItem {
  name: Buffer;
  mode: string;
  id: string;
}

// The entries of a tree object's bytes, in the order the tree holds them.
function treeItems(repo: Repository, id: string, tree: Buffer): TreeItem[] {
  const idLength = repo.format === 'sha256' ? 32 : 20;
  const items: TreeItem[] = [];
  let at = 0;
  while (at < tree.length) {
    const space = tree.indexOf(0x20, at);
    const nul = space < 0 ? -1 : tree.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 1 + idLength > tree.length) {
      throw new Error(`usabl could not read the tree ${id}, so it could not read the working tree.`);
    }
    items.push({
      mode: canonicalMode(tree.subarray(at, space).toString('latin1')),
      name: tree.subarray(space + 1, nul),
      id: tree.subarray(nul + 1, nul + 1 + idLength).toString('hex'),
    });
    at = nul + 1 + idLength;
  }
  return items;
}

// Tree objects by id, read with one git process and each checked against its id. A tree two
// folders share is read once.
async function readTrees(repo: Repository, ids: readonly string[]): Promise<Map<string, Buffer>> {
  const unique = [...new Set(ids)];
  const objects = await readObjects(repo, unique);
  const byId = new Map<string, Buffer>();
  unique.forEach((id, index) => {
    const object = verified(repo, objects[index] ?? null, 'tree', id);
    if (object.id !== id) throw new ObjectMismatchError(id);
    byId.set(id, object.bytes);
  });
  return byId;
}

/**
 * Every entry of a commit's tree, read in Node so that each object is checked against its id: the
 * commit, and every tree below it. An object in .git/objects whose bytes do not hash to its id
 * stops the read. Overwriting the HEAD tree with one that lists an edited blob made the edit read
 * unchanged, because git ls-tree prints what a tree object holds without checking its id.
 */
async function readBaseTree(repo: Repository, base: string): Promise<Array<{ raw: Buffer; mode: string; id: string }>> {
  const [commit] = await readObjects(repo, [base]);
  if (commit === null || commit === undefined) {
    if (base === 'HEAD') {
      throw await headUnreadable(repo);
    }
    throw new Error(`git could not read the commit ${operatorText(base)}, so usabl could not read the working tree.`);
  }
  const entries: Array<{ raw: Buffer; mode: string; id: string }> = [];
  let level: Array<{ id: string; prefix: Buffer }> = [{ id: treeOfCommit(verified(repo, commit, 'commit', operatorText(base))), prefix: Buffer.alloc(0) }];
  // One git process per level of folders.
  while (level.length > 0) {
    const byId = await readTrees(
      repo,
      level.map((tree) => tree.id),
    );
    const next: typeof level = [];
    for (const { id, prefix } of level) {
      for (const item of treeItems(repo, id, byId.get(id) ?? Buffer.alloc(0))) {
        const raw = Buffer.concat([prefix, item.name]);
        if (item.mode === TREE_MODE) {
          next.push({ id: item.id, prefix: Buffer.concat([raw, Buffer.from('/')]) });
        } else {
          entries.push({ raw, mode: item.mode, id: item.id });
        }
      }
    }
    level = next;
  }
  return entries;
}

/** Thrown when the trusted ref names no commit git can read. */
export class MissingCommitError extends Error {
  override name = 'MissingCommitError';
}

// Tags a trusted ref may pass through on its way to a commit, as git peels them. A longer chain is
// read as a ref that names no commit.
const MAX_TAG_DEPTH = 10;

/**
 * The commit a ref names, read in Node and checked against its id. A tag is peeled one checked
 * object at a time. git peels with a read that checks the id and answers "missing" when it does
 * not match, so the ref itself is read as stored and every object on the way is checked here,
 * which names the damaged object instead.
 */
async function checkedCommit(repo: Repository, ref: string): Promise<{ id: string; bytes: Buffer }> {
  let name = ref;
  for (let depth = 0; depth <= MAX_TAG_DEPTH; depth += 1) {
    const [object] = await readObjects(repo, [name]);
    if (object === null || object === undefined) {
      if (ref === 'HEAD') throw await headUnreadable(repo);
      throw new MissingCommitError(`git cannot read the commit ${operatorText(ref)}.`);
    }
    if (object.type === 'commit') {
      return verified(repo, object, 'commit', operatorText(ref));
    }
    if (object.type !== 'tag') {
      throw new MissingCommitError(`${operatorText(ref)} names a ${operatorText(object.type)}, not a commit.`);
    }
    const tag = verified(repo, object, 'tag', operatorText(ref));
    const target = /^object ([0-9a-f]{40}|[0-9a-f]{64})\n/u.exec(tag.bytes.subarray(0, 80).toString('latin1'))?.[1];
    if (target === undefined) {
      throw new MissingCommitError(`usabl could not read the tag ${tag.id} that ${operatorText(ref)} names.`);
    }
    name = target;
  }
  throw new MissingCommitError(`${operatorText(ref)} names a chain of tags longer than usabl reads.`);
}

/**
 * The names that differ between two trees, read in Node with every tree object checked against
 * its id. Two folders with the same tree id hold the same files, so only folders whose ids differ
 * are read: one git process per level of folders. A file counts as changed when its mode or its id
 * differs, or when one side lacks it; every file in a folder that only one side has is listed. A
 * name that a tree holds twice is listed, with everything under it.
 */
async function treeDifference(repo: Repository, before: string, after: string): Promise<Buffer[]> {
  const names: Buffer[] = [];
  let level: Array<{ before: string | null; after: string | null; prefix: Buffer }> = [{ before, after, prefix: Buffer.alloc(0) }];
  while (level.length > 0) {
    const pairs = level.filter((pair) => pair.before !== pair.after);
    const ids = pairs.flatMap((pair) => [pair.before, pair.after].filter((id): id is string => id !== null));
    const trees = await readTrees(repo, ids);
    const next: typeof level = [];
    for (const pair of pairs) {
      const sides = new Map<string, { name: Buffer; before: TreeItem[]; after: TreeItem[] }>();
      const add = (items: TreeItem[], side: 'before' | 'after'): void => {
        for (const item of items) {
          const key = item.name.toString('latin1');
          let entry = sides.get(key);
          if (entry === undefined) {
            entry = { name: item.name, before: [], after: [] };
            sides.set(key, entry);
          }
          entry[side].push(item);
        }
      };
      add(pair.before === null ? [] : treeItems(repo, pair.before, trees.get(pair.before) ?? Buffer.alloc(0)), 'before');
      add(pair.after === null ? [] : treeItems(repo, pair.after, trees.get(pair.after) ?? Buffer.alloc(0)), 'after');
      for (const entry of sides.values()) {
        const full = Buffer.concat([pair.prefix, entry.name]);
        const folder = Buffer.concat([full, Buffer.from('/')]);
        if (entry.before.length > 1 || entry.after.length > 1) {
          names.push(full);
          for (const item of entry.before) if (item.mode === TREE_MODE) next.push({ before: item.id, after: null, prefix: folder });
          for (const item of entry.after) if (item.mode === TREE_MODE) next.push({ before: null, after: item.id, prefix: folder });
          continue;
        }
        const [old] = entry.before;
        const now = entry.after[0];
        const oldTree = old?.mode === TREE_MODE ? old.id : null;
        const nowTree = now?.mode === TREE_MODE ? now.id : null;
        if (oldTree !== nowTree) {
          next.push({ before: oldTree, after: nowTree, prefix: folder });
        }
        const oldFile = old !== undefined && old.mode !== TREE_MODE ? old : null;
        const nowFile = now !== undefined && now.mode !== TREE_MODE ? now : null;
        if ((oldFile !== null || nowFile !== null) && (oldFile?.mode !== nowFile?.mode || oldFile?.id !== nowFile?.id)) {
          names.push(full);
        }
      }
    }
    level = next;
  }
  return names;
}

/**
 * The files that differ between the merge base of the ref and HEAD, and HEAD: what git diff
 * --name-only <ref>...HEAD lists, with a rename listed by both names. The trusted commit, HEAD,
 * the merge base and every tree the compare reads are checked against their ids in Node, so an
 * object overwritten in .git/objects stops the read. git diff read the trees as stored, so a tree
 * only the trusted side holds, rewritten to list a committed edit, hid that edit.
 *
 * git still finds the merge base, from the commit parents as stored. A commit rewritten between
 * the two can move the merge base, which is what moving the trusted branch with git update-ref
 * does too.
 */
async function committedChanges(repo: Repository, ref: string): Promise<Buffer[]> {
  const tip = await checkedCommit(repo, ref);
  const head = await checkedCommit(repo, 'HEAD');
  const found = await runGit(repo.top, ['merge-base', tip.id, head.id]);
  const base = found.stdout.toString('latin1').trim();
  if (found.code === 1) {
    throw new Error(
      `git finds no commit that HEAD shares with ${operatorText(ref)}, so usabl cannot tell which committed files ` +
        'changed and checked nothing. In a shallow clone, fetch more history, such as fetch-depth: 0 in ' +
        'actions/checkout or git fetch --unshallow, then run usabl again.',
    );
  }
  if (found.code !== 0 || !FULL_OBJECT_ID.test(base)) {
    throw new Error(`git merge-base failed, so usabl could not list the committed changes. ${firstLineOf(found.stderr)}`.trim());
  }
  if (base === head.id) {
    return [];
  }
  const start = base === tip.id ? tip : await checkedCommit(repo, base);
  return treeDifference(repo, treeOfCommit(start), treeOfCommit(head));
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
    const bytes = Buffer.from(read.stdout.subarray(newline + 1, newline + 1 + length));
    // git does not check a blob's id against its bytes when it reads it. A blob whose bytes are not
    // the ones its id names, such as an object file overwritten with an LFS pointer to edited
    // bytes, is never compared, and the file counts as changed.
    if (blobId(repo, bytes) === id) {
      blobs.set(id, bytes);
    }
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

/** How one walk uses the cache: the changed list reads and writes it, the tree only writes it. */
type CacheView = Pick<HashCache, 'get' | 'set'>;

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
  // Each link on disk, by its name from the top repository and its path on disk, and whether HEAD
  // holds that name.
  links: Array<{ raw: Buffer; disk: Buffer; tracked: boolean }>;
}

const REGULAR_MODES: ReadonlySet<string> = new Set(['100644', '100755']);
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
  cache: CacheView,
  options: WorktreeOptions,
  depth: number,
): Promise<Walk> {
  const started = BigInt(Date.now()) * 1_000_000n;
  const { entries, untracked } = await listPaths(repo, base, options);
  const records: TreeRecord[] = [];
  const changes: Walk['changes'] = [];
  const links: Walk['links'] = [];
  const named = (raw: Buffer): Buffer => (prefix.length === 0 ? raw : Buffer.concat([prefix, raw]));
  const onDisk = (raw: Buffer): Buffer => Buffer.concat([repo.topBytes, raw]);

  // What each folder on a path is, read once with lstat and kept: a folder, a link (so every path
  // below it is reached through the link), missing (so every file below it is missing, as sparse
  // checkout leaves whole folders out), or a path usabl cannot read.
  const folders = new Map<string, 'folder' | 'link' | 'missing' | 'unknown'>();
  const folderAt = (raw: Buffer): 'folder' | 'link' | 'missing' | 'unknown' => {
    const key = raw.toString('latin1');
    const known = folders.get(key);
    if (known !== undefined) return known;
    const slash = raw.lastIndexOf(0x2f);
    let state = slash > 0 ? folderAt(raw.subarray(0, slash)) : 'folder';
    if (state === 'folder') {
      const kind = kindOf(onDisk(raw)).kind;
      state = kind === 'folder' ? 'folder' : kind === 'link' ? 'link' : kind === 'other' ? 'unknown' : 'missing';
    }
    folders.set(key, state);
    return state;
  };
  const kindAt = (raw: Buffer): { kind: Kind; stats?: BigIntStats } => {
    const slash = raw.lastIndexOf(0x2f);
    const folder = slash > 0 ? folderAt(raw.subarray(0, slash)) : 'folder';
    if (folder === 'link') return { kind: 'behindLink' };
    if (folder === 'missing') return { kind: 'missing' };
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
      if (found.kind === 'behindLink') {
        // Never hashed through the link. A committed file there is gone from the tree, as git sees
        // it, and the link itself is a path of its own.
        if (tracked) changes.push({ code: 'D', raw });
      } else if (found.kind === 'missing') {
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
        links.push({ raw: named(raw), disk: onDisk(raw), tracked });
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
    links.push(...inner.links);
    changes.push(...inner.changes.map((change) => ({ code: change.code, raw: Buffer.concat([raw, Buffer.from('/'), change.raw]) })));
  }
  return { records, changes, links };
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
  cache: CacheView,
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
      return recorded === null
        ? { records: [], changes: [], links: [] }
        : { records: [{ mode: SUBMODULE_MODE, id: recorded, raw: prefix }], changes: [], links: [] };
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

// What the sparse pattern file is, as the walk reads it: missing, a regular file by the sha256 of
// its bytes (an empty file included), a link by its text, or another kind. The walk takes an answer
// from the patterns only when the file is regular and holds a pattern line.
function patternFileState(path: string): string[] {
  const found = kindOf(Buffer.from(path));
  try {
    if (found.kind === 'file') return ['file', createHash('sha256').update(readFileSync(path)).digest('hex')];
    if (found.kind === 'link') return ['link', readLinkBytes(Buffer.from(path)).toString('hex')];
  } catch {
    return ['unreadable'];
  }
  return [found.kind];
}

/** The checkout state of one repository and the submodules below it, gathered for checkoutState. */
interface CheckoutState {
  sparse: Array<[string, boolean, string, string[]]>;
  emptySubmodules: string[];
}

/**
 * The sparse checkout state of a repository, and its submodule folders: an empty one is recorded,
 * and one that holds a repository is read the same way, as the walk reads it. A submodule is any
 * gitlink entry of HEAD or of the index.
 */
async function gatherCheckoutState(repo: Repository, prefix: string, state: CheckoutState, depth: number): Promise<void> {
  const cone = (await runGit(repo.top, ['config', '--bool', '--get', 'core.sparseCheckoutCone'])).stdout.toString('utf8').trim();
  const patterns = patternFileState(repo.sparsePatterns);
  if (repo.sparse || cone.length > 0 || patterns[0] !== 'missing') {
    state.sparse.push([prefix, repo.sparse, cone, patterns]);
  }
  const gitlinks = new Map<string, Buffer>();
  try {
    for (const entry of await readBaseTree(repo, 'HEAD')) {
      if (entry.mode === SUBMODULE_MODE) gitlinks.set(entry.raw.toString('latin1'), entry.raw);
    }
  } catch (err) {
    // A repository with no commits yet has gitlinks in its index only.
    if (!(err instanceof NoHeadError)) throw err;
  }
  for (const record of splitNul(await mustGit(repo.top, [...LISTING_SETTINGS, 'ls-files', '-s', '-z'], 'ls-files'))) {
    const tab = record.indexOf(TAB);
    if (tab < 0 || !record.subarray(0, tab).toString('latin1').startsWith(`${SUBMODULE_MODE} `)) continue;
    const raw = Buffer.from(record.subarray(tab + 1));
    gitlinks.set(raw.toString('latin1'), raw);
  }
  for (const raw of [...gitlinks.values()].sort(Buffer.compare)) {
    const folder = Buffer.concat([repo.topBytes, raw]).toString('utf8');
    const name = `${prefix}${raw.toString('utf8')}`;
    if (kindOf(Buffer.from(folder)).kind !== 'folder') continue;
    const shown = await runGit(folder, ['rev-parse', '--show-toplevel']);
    const holdsRepository = shown.code === 0 && realOrNull(shown.stdout.toString('utf8').replace(/\n$/u, '')) === realOrNull(folder);
    if (!holdsRepository) {
      if (folderIsEmpty(folder)) state.emptySubmodules.push(name);
      continue;
    }
    if (depth >= MAX_DEPTH) {
      throw new Error('Submodules are nested deeper than usabl reads, so usabl checked nothing.');
    }
    await gatherCheckoutState(await openRepository(folder), `${name}/`, state, depth + 1);
  }
}

/** The name checkoutState gives the sparse checkout state: git's own pattern file. */
export const SPARSE_STATE_NAME = '.git/info/sparse-checkout';
/** The name checkoutState gives the empty submodule folders. */
export const EMPTY_SUBMODULES_NAME = '.git/modules';

/** A reader of the working tree with a hash cache of its own, for the life of the git reader. */
export interface WorktreeReader {
  /** The tree id of the bytes on disk, hashed fresh on every call. */
  tree(): Promise<string>;
  /** The paths whose content on disk is not what HEAD holds, from the repository root, sorted. */
  changes(): Promise<WorktreeChange[]>;
  /** The files that differ between the merge base of the ref and HEAD, and HEAD, sorted. */
  committed(ref: string): Promise<string[]>;
  /** The sparse checkout state and the empty submodule folders, as GitReader.checkoutState. */
  checkoutState(): Promise<Record<string, string>>;
}

// A tree id that never matches any earlier read, for a tree usabl cannot build from the bytes the
// checks read. No stored receipt answers for it, and a run that reads it twice sees two trees.
function neverRepeatingTree(repo: Repository): string {
  return objectId(repo, 'tree', Buffer.from(`usabl: a tree usabl could not build ${String(process.hrtime.bigint())} ${String(Math.random())}`));
}

/** Thrown when a link points at something outside the files usabl hashes that it cannot bind. */
export class UnboundLinkError extends Error {
  override name = 'UnboundLinkError';
  /** The link's name from the repository root. It comes from the repository, so it is untrusted. */
  readonly link: string;
  constructor(link: string) {
    super(
      `${operatorText(link)} is a link to a folder, or to something else that is not a file, outside the files usabl ` +
        'hashes, so usabl cannot bind what the dev server serves through it and checked nothing. ' +
        'Commit what it points to, or replace the link with the files it points to, then run usabl again.',
    );
    this.link = link;
  }
}

/**
 * What each link on disk points at, against the files the walk hashes. A link binds its link text,
 * and the dev server serves its target's bytes, so the target must be bound too:
 * - a link that points nowhere serves nothing, and its text binds it;
 * - a link to a file the walk hashes, or to a folder that holds one, is bound by that file's own
 *   record;
 * - a link to any other file (outside the repository, in an ignored folder, or in .git) is bound
 *   by its text and the file's bytes, hashed fresh;
 * - a link to anything else (a folder outside the hashed files, or a pipe) cannot be bound.
 */
type LinkTarget = { kind: 'bound' } | { kind: 'file'; target: Buffer } | { kind: 'unbound' };

// realpath's codes for a link that points nowhere: a missing path, a path below a file, or a loop.
const POINTS_NOWHERE: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);

function linkTargets(repo: Repository, walked: Walk): LinkTarget[] {
  if (walked.links.length === 0) {
    return [];
  }
  // The names the walk hashes, built only when a link points inside the repository.
  let hashed: { files: Set<string>; folders: Set<string> } | null = null;
  const hashedNames = (): { files: Set<string>; folders: Set<string> } => {
    if (hashed !== null) return hashed;
    const files = new Set<string>();
    const folders = new Set<string>();
    for (const record of walked.records) {
      if (!REGULAR_MODES.has(record.mode)) continue;
      const name = record.raw.toString('latin1');
      files.add(name);
      for (let slash = name.indexOf('/'); slash > 0; slash = name.indexOf('/', slash + 1)) {
        folders.add(name.slice(0, slash));
      }
    }
    hashed = { files, folders };
    return hashed;
  };
  const root = repo.topBytes.subarray(0, repo.topBytes.length - 1);
  return walked.links.map((link): LinkTarget => {
    let target: Buffer;
    try {
      target = realpathSync.native(link.disk, { encoding: 'buffer' });
    } catch (err) {
      const code = typeof err === 'object' && err !== null ? Reflect.get(err, 'code') : null;
      return typeof code === 'string' && POINTS_NOWHERE.has(code) ? { kind: 'bound' } : { kind: 'unbound' };
    }
    if (target.equals(root)) return { kind: 'bound' };
    if (target.subarray(0, repo.topBytes.length).equals(repo.topBytes)) {
      const name = target.subarray(repo.topBytes.length).toString('latin1');
      const { files, folders } = hashedNames();
      if (files.has(name) || folders.has(name)) return { kind: 'bound' };
    }
    const found = kindOf(target);
    return found.kind === 'file' ? { kind: 'file', target } : { kind: 'unbound' };
  });
}

/**
 * What git ls-files -s -z prints for an index that holds exactly these records: one line per name,
 * with its mode, its id and stage 0, in git's index order, which is byte order of the names. A later
 * record for a name replaces an earlier one, as git update-index does.
 */
function expectedListing(records: readonly TreeRecord[]): Buffer {
  const byName = new Map<string, TreeRecord>();
  for (const record of records) {
    byName.set(record.raw.toString('latin1'), record);
  }
  const sorted = [...byName.values()].sort((a, b) => Buffer.compare(a.raw, b.raw));
  return Buffer.concat(sorted.flatMap((record) => [Buffer.from(`${record.mode} ${record.id} 0\t`, 'latin1'), record.raw, Buffer.from([0])]));
}

export function makeWorktreeReader(options: WorktreeOptions): WorktreeReader {
  const cache: HashCache = new Map();
  return {
    async tree() {
      const repo = await openRepository(options.cwd);
      // The tree a receipt binds is hashed fresh, never from the cache. A write through a memory map
      // can change a file's bytes and keep both of its times, so only the changed list, which
      // decides what to check and binds nothing, reads the cache. The tree read still fills it.
      const writeOnly: CacheView = {
        get: () => undefined,
        set: (key, value) => cache.set(key, value),
      };
      const result = await walk(repo, 'HEAD', Buffer.alloc(0), writeOnly, options, 0);
      const targets = linkTargets(repo, result);
      if (targets.some((target) => target.kind === 'unbound')) {
        // changes(), which every stop and check reads, names the link. No receipt answers here.
        return neverRepeatingTree(repo);
      }
      // A link to a file outside the hashed files is recorded by its text and the file's bytes,
      // hashed fresh on every read and never taken from the cache.
      const outside = result.links.flatMap((link, index) => {
        const target = targets[index];
        return target?.kind === 'file' ? [{ raw: link.raw, target: target.target }] : [];
      });
      if (outside.length > 0) {
        const ids = await rawIds(repo, outside.map((link) => link.target));
        const byName = new Map(outside.map((link, index) => [link.raw.toString('latin1'), ids[index] ?? null]));
        for (const record of result.records) {
          if (record.mode !== LINK_MODE || !byName.has(record.raw.toString('latin1'))) continue;
          const id = byName.get(record.raw.toString('latin1')) ?? null;
          record.id = id === null ? unreadableId(repo) : blobId(repo, Buffer.from(`usabl: link ${record.id} to a file ${id}`));
        }
      }
      const scratch = await mkdtemp(join(tmpdir(), 'usabl-index-'));
      try {
        const env = { GIT_INDEX_FILE: join(scratch, 'index') };
        const input = Buffer.concat(result.records.flatMap((record) => [Buffer.from(`${record.mode} ${record.id}\t`), record.raw, Buffer.from([0])]));
        const built = await runGit(repo.top, ['update-index', '-z', '--index-info'], { input, env });
        if (built.code !== 0) {
          throw new Error(`git update-index failed, so usabl could not read the working tree. ${firstLineOf(built.stderr)}`.trim());
        }
        const listed = await runGit(repo.top, ['ls-files', '-s', '-z'], { env });
        if (listed.code !== 0) {
          throw new Error(`git ls-files failed, so usabl could not read the working tree. ${firstLineOf(listed.stderr)}`.trim());
        }
        // git update-index --index-info skips a name it will not store, such as a folder named GIT~1
        // or .GIT, prints a line, and exits 0. It also drops a record that clashes with another one.
        // So the index must hold exactly the records sent, name by name, with each mode and id.
        if (built.stderr.trim().length > 0 || !listed.stdout.equals(expectedListing(result.records))) {
          return neverRepeatingTree(repo);
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
      const targets = linkTargets(repo, result);
      const unbound = result.links.filter((_, index) => targets[index]?.kind === 'unbound');
      if (unbound.length > 0) {
        const first = unbound.map((link) => link.raw).sort(Buffer.compare)[0] ?? Buffer.alloc(0);
        throw new UnboundLinkError(first.toString('utf8'));
      }
      // HEAD holds only the text of a link to a file outside the hashed files, so nothing says its
      // target is the file checked before. Such a link is always in the list.
      const linkChanges = result.links.flatMap((link, index) =>
        targets[index]?.kind === 'file' ? [{ code: link.tracked ? 'M' : '??', raw: link.raw }] : [],
      );
      const seen = new Set<string>();
      const changes: WorktreeChange[] = [];
      for (const change of [...result.changes, ...linkChanges]) {
        const key = change.raw.toString('latin1');
        if (seen.has(key)) continue;
        seen.add(key);
        changes.push({ code: change.code, path: change.raw.toString('utf8') });
      }
      // Plain code-unit order, so the list never depends on the order the reads finished in.
      return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    },
    async committed(ref) {
      const repo = await openRepository(options.cwd);
      const names = await committedChanges(repo, ref);
      // The same limit git diff's listing had: the names and one separator each.
      if (names.reduce((size, name) => size + name.length + 1, 0) > options.maxBuffer) {
        throw options.tooLong('diff');
      }
      const unique = [...new Set(names.map((name) => name.toString('utf8')))];
      return unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    },
    async checkoutState() {
      const state: CheckoutState = { sparse: [], emptySubmodules: [] };
      await gatherCheckoutState(await openRepository(options.cwd), '', state, 0);
      const result: Record<string, string> = {};
      if (state.sparse.length > 0) result[SPARSE_STATE_NAME] = JSON.stringify(state.sparse);
      if (state.emptySubmodules.length > 0) result[EMPTY_SUBMODULES_NAME] = JSON.stringify(state.emptySubmodules);
      return result;
    },
  };
}

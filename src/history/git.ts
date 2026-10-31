/**
 * The real history port, backed by git plumbing. It reads the history branch as objects and writes
 * a new commit without touching the working tree or the index the developer uses.
 *
 * This unit reports and writes repository facts only. It must never decide a verdict.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { HistoryWriter } from './append.js';
import { HISTORY_REMOTE_REF } from './record.js';

const execFileAsync = promisify(execFile);
// A month of records for a large application can pass the 10 MiB the other git reads allow.
const MAX_BUFFER = 256 * 1024 * 1024;
// History commits are written by a machine, so they carry a fixed identity rather than whoever
// happens to be configured on the runner.
const COMMIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'usabl',
  GIT_AUTHOR_EMAIL: 'usabl@localhost',
  GIT_COMMITTER_NAME: 'usabl',
  GIT_COMMITTER_EMAIL: 'usabl@localhost',
};

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    env: env === undefined ? process.env : { ...process.env, ...env },
  });
  return stdout;
}

function gitWithInput(cwd: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`git ${args[0] ?? ''} exited ${code ?? 'without a code'}`));
    });
    child.stdin.end(input, 'utf8');
  });
}

function exitCodeOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const code = Reflect.get(err, 'code');
  return typeof code === 'number' ? code : null;
}

/**
 * `ref` is where the history is read from, as a run names it, for example "origin/usabl/history".
 */
export function makeHistoryGit(options: { cwd?: string; ref?: string } = {}): HistoryWriter {
  const cwd = options.cwd ?? process.cwd();
  const ref = options.ref ?? HISTORY_REMOTE_REF;
  // One rev-list per descendant, so a history of many records costs one git call, not one each.
  const ancestors = new Map<string, Promise<Set<string>>>();

  async function resolveCommit(name: string): Promise<string | null> {
    try {
      const out = await git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${name}^{commit}`]);
      const sha = out.trim();
      return sha.length === 0 ? null : sha;
    } catch (err) {
      // --quiet exits 1 with no output when the name does not resolve. Anything else is a failure.
      if (exitCodeOf(err) === 1) return null;
      throw err;
    }
  }

  return {
    ref,
    resolveCommit,
    async listFiles(commit) {
      const out = await git(cwd, ['ls-tree', '--name-only', commit]);
      return out.split('\n').filter((line) => line.length > 0).sort();
    },
    async readFile(commit, path) {
      try {
        return await git(cwd, ['cat-file', 'blob', `${commit}:${path}`]);
      } catch (err) {
        if (exitCodeOf(err) === 128) return null;
        throw err;
      }
    },
    async isAncestor(commit, of) {
      let set = ancestors.get(of);
      if (set === undefined) {
        set = git(cwd, ['rev-list', of]).then((out) => new Set(out.split('\n').filter((line) => line.length > 0)));
        ancestors.set(of, set);
      }
      return (await set).has(commit);
    },
    async commitFile(parent, path, contents, message) {
      const blob = (await gitWithInput(cwd, ['hash-object', '-w', '--stdin'], contents)).trim();
      const dir = await mkdtemp(join(tmpdir(), 'usabl-history-'));
      const env = { GIT_INDEX_FILE: join(dir, 'index') };
      try {
        await git(cwd, parent === null ? ['read-tree', '--empty'] : ['read-tree', parent], env);
        await git(cwd, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], env);
        const tree = (await git(cwd, ['write-tree'], env)).trim();
        const args = ['commit-tree', tree, ...(parent === null ? [] : ['-p', parent]), '-m', message];
        return (await git(cwd, args, COMMIT_IDENTITY)).trim();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async setBranch(branch, commit) {
      await git(cwd, ['update-ref', `refs/heads/${branch}`, commit]);
    },
  };
}

/**
 * What `usabl install --ci` reads from the app's git repository, for its report and for the one
 * branch name the history workflow carries. It reads only local refs: nothing here fetches from
 * the network. Every question has a "cannot say" answer, and the report treats that as a step to
 * do, never as done.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { InstallFs } from './index.js';
import { CONFIG_PATH } from './app-origin.js';

const execFileAsync = promisify(execFile);

/** A read-only git port. run returns git's stdout, or null when git fails or is missing. */
export interface InstallGit {
  run(args: readonly string[]): Promise<string | null>;
}

/** A git that cannot answer anything, for callers and tests with no repository. */
export const NO_GIT: InstallGit = { run: async () => null };

/** git, run in cwd with an argument list (never a shell string). */
export function gitRunner(cwd: string): InstallGit {
  return {
    run: async (args) => {
      try {
        const { stdout } = await execFileAsync('git', [...args], { cwd, encoding: 'utf8' });
        return stdout;
      } catch {
        return null;
      }
    },
  };
}

// The judge reads both files at the base commit. The routes file is a fixed sidecar name.
export const ROUTES_PATH = 'usabl.routes.json';

// A branch name goes into a workflow file, so only a plain name is taken: letters, digits, and
// . _ - /. Anything else is treated as not found, never escaped and written. Every workflow usabl
// writes takes its branch through this one rule.
const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/;

export function isSafeBranchName(name: string): boolean {
  return SAFE_BRANCH.test(name);
}

// The one trigger form usabl writes: the event line, then its branch filter naming one quoted name.
const TRIGGER_BRANCH_LINE = /^ {4}branches: \["([^"]*)"\]$/;

/**
 * The branch a usabl workflow names in its trigger for `event`: the line `  <event>:` followed
 * straight away by `    branches: ["<name>"]`. Null when the file has no such pair, or when the name
 * is not a plain name. A file whose trigger is in any other form names no branch usabl can read.
 */
export function workflowTriggerBranch(raw: string | null, event: 'pull_request' | 'push'): string | null {
  if (raw === null) return null;
  const lines = raw.split('\n');
  const at = lines.indexOf(`  ${event}:`);
  if (at === -1) return null;
  const match = TRIGGER_BRANCH_LINE.exec(lines[at + 1] ?? '');
  const name = match?.[1] ?? '';
  return isSafeBranchName(name) ? name : null;
}

export type DefaultBranch = { kind: 'found'; name: string } | { kind: 'unknown'; reason: string };

const ORIGIN_HEAD = 'refs/remotes/origin/HEAD';
const ORIGIN_PREFIX = 'refs/remotes/origin/';

/**
 * The default branch of origin, as the local clone records it in refs/remotes/origin/HEAD. A clone
 * sets that ref. When it is not set, there is no origin, or git is missing, the branch is unknown.
 */
export async function findDefaultBranch(git: InstallGit): Promise<DefaultBranch> {
  const out = await git.run(['symbolic-ref', '--quiet', ORIGIN_HEAD]);
  if (out === null) {
    return {
      kind: 'unknown',
      reason: `git has no default branch recorded for origin (${ORIGIN_HEAD} is not set; "git remote set-head origin --auto" records it)`,
    };
  }
  const ref = out.endsWith('\n') ? out.slice(0, -1) : out;
  const name = ref.startsWith(ORIGIN_PREFIX) ? ref.slice(ORIGIN_PREFIX.length) : '';
  if (name === '' || name === 'HEAD' || !isSafeBranchName(name)) {
    return {
      kind: 'unknown',
      reason: 'the default branch git records for origin has a name usabl does not write into a workflow (only letters, digits, and . _ - / are taken)',
    };
  }
  return { kind: 'found', name };
}

/**
 * The files the judge reads at the base commit that this app has: every required file, and each
 * optional one only when the working tree holds it.
 */
export async function presentFiles(fs: InstallFs, required: readonly string[], optional: readonly string[]): Promise<string[]> {
  const present: string[] = [...required];
  for (const path of optional) {
    if ((await fs.readFile(path)) !== null) present.push(path);
  }
  return present;
}

/**
 * Whether origin's default branch already holds each of `files` with the same bytes as the working
 * tree. False whenever git cannot show it: no default branch, a file missing there or in the working
 * tree, or different bytes.
 */
export async function filesOnDefaultBranch(fs: InstallFs, git: InstallGit, files: readonly string[]): Promise<boolean> {
  const branch = await findDefaultBranch(git);
  if (branch.kind !== 'found') return false;
  for (const path of files) {
    const contents = await fs.readFile(path);
    if (contents === null) return false;
    // The ./ makes the path relative to the folder git runs in, which is the app folder.
    const onBranch = await git.run(['show', `${ORIGIN_PREFIX}${branch.name}:./${path}`]);
    if (onBranch !== contents) return false;
  }
  return true;
}

/**
 * Whether origin's default branch already holds usabl.config.json, and usabl.routes.json when the
 * working tree has one, with the same bytes as the working tree. False whenever git cannot show
 * it: no default branch, no such file there, different bytes, or no config in the working tree.
 */
export async function configOnDefaultBranch(fs: InstallFs, git: InstallGit): Promise<boolean> {
  return filesOnDefaultBranch(fs, git, await presentFiles(fs, [CONFIG_PATH], [ROUTES_PATH]));
}

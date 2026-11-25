/**
 * What a Stop hook checks: the commit where this branch left the trusted branch, found with git.
 *
 * CI checks every file changed since the pull request left its base branch. The hook checks the
 * same set, plus changes that are not committed yet, so an agent that commits its work and then
 * stops is still checked. The trusted branch is the default branch git records for origin, in
 * refs/remotes/origin/HEAD. The starting commit is the merge base of that branch and HEAD.
 *
 * This unit reads git and reports what it found. It never decides a verdict, and it never guesses:
 * a starting commit it cannot find is reported as not found, never as "no commits to check".
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitReader } from '../contracts/index.js';
import { boundField } from '../output/bounded-text.js';
import { isSafeBranchName } from '../primitives/branch-name.js';
import { firstLine } from '../primitives/first-line.js';
import { listChangedFiles } from './cli.js';
import { frameUntrustedBlock } from './scrub.js';

const execFileAsync = promisify(execFile);

/** The ref git sets on clone to name the default branch of origin. */
export const TRUSTED_BRANCH_POINTER = 'refs/remotes/origin/HEAD';

/** Why a trusted branch is named but its starting commit could not be used. */
export type StartingCommitProblem =
  | 'not-remote-branch'
  | 'branch-missing'
  | 'no-common-commit'
  | 'not-ancestor'
  | 'trusted-branch-may-be-stale'
  | 'git-failed';

/**
 * Where a check with a starting commit reads policy, chosen by where usabl.config.json is.
 *
 * `starting-commit`: the starting commit holds a config, so policy is read and guarded there, as
 * CI reads it at the base of the pull request. `branch-sets-usabl-up`: neither the starting commit
 * nor the tip of any branch of origin holds one, so this branch is the one that sets usabl up, and
 * its own policy is the only policy there is. The check reads it, and says it is not approved yet.
 * `branch-older-than-setup`: the trusted branch holds a config but the starting commit does not,
 * so the branch left the trusted branch before usabl was set up there, and checks nothing until it
 * is updated.
 */
export type PolicySource = 'starting-commit' | 'branch-sets-usabl-up' | 'branch-older-than-setup';

/**
 * What the hook found. `found` carries the trusted branch as git names it (for example
 * origin/main), the full commit id where HEAD left it, where policy is read, and whether the tip of
 * the trusted branch holds a config. `no-trusted-branch`
 * means git records no default branch for origin. `not-found` means a trusted branch is named and
 * its starting commit could not be found or used; `detail` is git's first line for a git failure,
 * and for `trusted-branch-may-be-stale` the other branch of origin that holds a config, or null
 * when no such branch has a plain name.
 */
export type StartingCommit =
  | { kind: 'found'; branch: string; commit: string; policy: PolicySource; configOnTrustedBranch: boolean }
  | { kind: 'no-trusted-branch' }
  | { kind: 'not-found'; branch: string; problem: StartingCommitProblem; detail: string | null };

/** One git call: its exit code (null when git did not run) and what it printed. */
export interface ScopeGitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** One git call. `input`, when given, is written to git's standard input. */
export type ScopeGit = (args: readonly string[], input?: string) => Promise<ScopeGitResult>;

// usabl reads git's exit codes here, never its words, but the detail it prints is kept in English.
const ENGLISH_MESSAGES = { LC_ALL: 'C' };

/** git, run in `cwd` with an argument list, never a shell string. */
export function scopeGit(cwd: string): ScopeGit {
  return async (args, input) => {
    try {
      const pending = execFileAsync('git', [...args], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, ...ENGLISH_MESSAGES },
      });
      if (input !== undefined) {
        // A git that stops before it reads all of its input reports that with its exit code. The
        // broken pipe on this side is not a second error.
        pending.child.stdin?.on('error', () => {});
        pending.child.stdin?.end(input);
      }
      const { stdout, stderr } = await pending;
      return { code: 0, stdout, stderr };
    } catch (err) {
      const code: unknown = typeof err === 'object' && err !== null ? Reflect.get(err, 'code') : null;
      const stdout: unknown = typeof err === 'object' && err !== null ? Reflect.get(err, 'stdout') : '';
      const stderr: unknown = typeof err === 'object' && err !== null ? Reflect.get(err, 'stderr') : '';
      return {
        code: typeof code === 'number' ? code : null,
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : err instanceof Error ? err.message : String(err),
      };
    }
  };
}

// A full commit id, SHA-1 or SHA-256. Anything else is not read as a commit.
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function oneLine(stdout: string): string {
  return stdout.replace(/\r?\n$/, '');
}

function gitFailed(branch: string, result: ScopeGitResult): StartingCommit {
  const detail = firstLine(result.stderr);
  return { kind: 'not-found', branch, problem: 'git-failed', detail: detail.length > 0 ? detail : 'git did not run' };
}

const ORIGIN_BRANCHES = 'refs/remotes/origin/';

// refs/remotes/origin/<name>, and never origin/HEAD itself.
function isOriginBranch(ref: string): boolean {
  return ref.startsWith(ORIGIN_BRANCHES) && ref.length > ORIGIN_BRANCHES.length && ref !== TRUSTED_BRANCH_POINTER;
}

// The branch as a person names it: refs/remotes/origin/main reads as origin/main.
function branchName(ref: string): string {
  return ref.startsWith('refs/remotes/') ? ref.slice('refs/remotes/'.length) : ref;
}

/**
 * The commit where HEAD left the trusted branch, or why there is none to use.
 *
 * Each step reads one git exit code. Exit 1 is git's answer "no" for each of these commands, and
 * every other failure is a git failure, never read as "no".
 */
export async function findStartingCommit(git: ScopeGit): Promise<StartingCommit> {
  const pointer = await git(['symbolic-ref', '--quiet', TRUSTED_BRANCH_POINTER]);
  if (pointer.code === 1) {
    return { kind: 'no-trusted-branch' };
  }
  if (pointer.code !== 0 || oneLine(pointer.stdout).length === 0) {
    return gitFailed('origin/HEAD', pointer);
  }
  const ref = oneLine(pointer.stdout);
  // Only a branch of origin is a trusted branch. A local branch or a tag can sit on HEAD, which
  // would make HEAD its own starting commit and committed work read as nothing to check.
  if (!isOriginBranch(ref)) {
    return { kind: 'not-found', branch: ref, problem: 'not-remote-branch', detail: null };
  }
  const branch = branchName(ref);

  const tip = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (tip.code === 1) {
    return { kind: 'not-found', branch, problem: 'branch-missing', detail: null };
  }
  const tipCommit = oneLine(tip.stdout);
  if (tip.code !== 0 || !COMMIT_ID.test(tipCommit)) {
    return gitFailed(branch, tip);
  }

  const base = await git(['merge-base', tipCommit, 'HEAD']);
  if (base.code === 1) {
    return { kind: 'not-found', branch, problem: 'no-common-commit', detail: null };
  }
  const commit = oneLine(base.stdout);
  if (base.code !== 0 || !COMMIT_ID.test(commit)) {
    return gitFailed(branch, base);
  }

  // A merge base is an ancestor of HEAD by definition. This is checked anyway, because the scope
  // and the receipt both rest on it, and a commit that is not one would scope the wrong changes.
  const ancestor = await git(['merge-base', '--is-ancestor', commit, 'HEAD']);
  if (ancestor.code === 1) {
    return { kind: 'not-found', branch, problem: 'not-ancestor', detail: null };
  }
  if (ancestor.code !== 0) {
    return gitFailed(branch, ancestor);
  }

  // Where policy is read. Both commits are asked, and a lookup that fails is a git failure, never
  // "no config".
  const atStart = await holdsConfig(git, commit);
  if ('failed' in atStart) {
    return gitFailed(branch, atStart.failed);
  }
  const atTip = await holdsConfig(git, tipCommit);
  if ('failed' in atTip) {
    return gitFailed(branch, atTip.failed);
  }
  if (!atStart.held && !atTip.held) {
    // origin/HEAD can name an old branch after the project moves its default branch, because a
    // fetch does not move it. A config at the tip of any other branch of origin means usabl is set
    // up in this repository, so this branch is not read as the one that sets it up.
    const elsewhere = await configOnOtherBranch(git, tipCommit);
    if ('failed' in elsewhere) {
      return gitFailed(branch, elsewhere.failed);
    }
    if (elsewhere.held) {
      return { kind: 'not-found', branch, problem: 'trusted-branch-may-be-stale', detail: elsewhere.name };
    }
  }
  const policy: PolicySource = atStart.held
    ? 'starting-commit'
    : atTip.held
      ? 'branch-older-than-setup'
      : 'branch-sets-usabl-up';
  return { kind: 'found', branch, commit, policy, configOnTrustedBranch: atTip.held };
}

/** The config file whose place decides where policy is read. */
const CONFIG_FILE = 'usabl.config.json';

/**
 * Whether a commit holds usabl.config.json at the repository root.
 *
 * The commit's tree must be readable first: `git cat-file -e` fails for a missing or broken tree,
 * where a lookup of a path in it would answer the same as for a path that is not there. Then
 * `git ls-tree` lists that one root entry; `--full-tree` reads the path from the root wherever git
 * runs. A listing that names the file means held, an empty listing with exit 0 means absent, and
 * every other answer is a git failure, never "no config". Anything at that path, a file, a link, a
 * folder, or a submodule, counts as held, so a strange entry keeps the strict reading.
 */
async function holdsConfig(git: ScopeGit, commit: string): Promise<{ held: boolean } | { failed: ScopeGitResult }> {
  const tree = await git(['cat-file', '-e', `${commit}^{tree}`]);
  if (tree.code !== 0) {
    return { failed: tree };
  }
  const listed = await git(['ls-tree', '--full-tree', '--name-only', '-z', commit, '--', CONFIG_FILE]);
  if (listed.code !== 0) {
    return { failed: listed };
  }
  if (listed.stdout.length === 0) {
    return { held: false };
  }
  if (listed.stdout.split('\0').includes(CONFIG_FILE)) {
    return { held: true };
  }
  return { failed: { ...listed, stderr: `git listed an unexpected entry for ${CONFIG_FILE}` } };
}

// One line of git cat-file --batch-check for a tree that is there.
const TREE_LINE = /^(?:[0-9a-f]{40}|[0-9a-f]{64}) tree \d+$/;

const LOCAL_BRANCHES = 'refs/heads/';

/**
 * Branch names that are a project's default branch so often that a config at their tip on origin
 * always counts as usabl set up elsewhere, even when this branch is named after one of them or
 * tracks one.
 */
const ALWAYS_COUNTED: ReadonlySet<string> = new Set(['main', 'master', 'trunk', 'develop']);

// One line of the listing: object id, ref, "*" for the branch checked out here or a space, and the
// upstream git records for a local branch, or nothing. git forbids a tab in a ref name.
const LISTING_LINE = /^((?:[0-9a-f]{40}|[0-9a-f]{64}))\t(refs\/[^\t]+)\t([* ])\t((?:refs\/[^\t]+)?)$/;

/**
 * Whether the tip of any branch of origin other than the trusted one holds usabl.config.json at
 * the root, and the first such branch with a plain name, in name order.
 *
 * It reads local refs only, never the network. git lists the branches of origin and the local
 * branches once, and one batch lookup asks each tip for its tree and for the config, so a clone
 * with many branches costs two git calls. A tree that is missing, a line git was not expected to
 * print, and a call that fails are a git failure, never "no config". Anything at the config path
 * counts as held, as in holdsConfig. A branch name reaches output only when it is a plain name,
 * and no branch name is ever passed to git.
 *
 * This branch's own copy on origin is not evidence that usabl is set up elsewhere, so a branch
 * that sets usabl up and is pushed still reads as one. The branch of origin with the current
 * branch's name, and the current branch's upstream when it is a branch of origin, are skipped,
 * unless the name on origin is one of ALWAYS_COUNTED. With a detached HEAD nothing is skipped.
 */
async function configOnOtherBranch(
  git: ScopeGit,
  trustedTip: string,
): Promise<{ held: false } | { held: true; name: string | null } | { failed: ScopeGitResult }> {
  const listed = await git([
    'for-each-ref',
    '--format=%(objectname)%09%(refname)%09%(HEAD)%09%(upstream)',
    ORIGIN_BRANCHES,
    LOCAL_BRANCHES,
  ]);
  if (listed.code !== 0) {
    return { failed: listed };
  }
  const unexpected = (result: ScopeGitResult, what: string) => ({ failed: { ...result, stderr: `git printed an unexpected line for ${what}` } });
  const originRefs: { commit: string; ref: string }[] = [];
  const ownCopies = new Set<string>();
  for (const line of listed.stdout.split('\n')) {
    if (line.length === 0) {
      continue;
    }
    const match = LISTING_LINE.exec(line);
    if (match === null) {
      return unexpected(listed, 'the branches');
    }
    const [, commit = '', ref = '', head = '', upstream = ''] = match;
    if (ref.startsWith(LOCAL_BRANCHES)) {
      if (head === '*') {
        ownCopies.add(ORIGIN_BRANCHES + ref.slice(LOCAL_BRANCHES.length));
        if (upstream.startsWith(ORIGIN_BRANCHES)) {
          ownCopies.add(upstream);
        }
      }
      continue;
    }
    if (!ref.startsWith(ORIGIN_BRANCHES)) {
      return unexpected(listed, 'the branches');
    }
    originRefs.push({ commit, ref });
  }
  const refsByCommit = new Map<string, string[]>();
  for (const { commit, ref } of originRefs) {
    // The trusted branch's tip was asked already, and origin/HEAD names it.
    if (ref === TRUSTED_BRANCH_POINTER || commit === trustedTip) {
      continue;
    }
    if (ownCopies.has(ref) && !ALWAYS_COUNTED.has(ref.slice(ORIGIN_BRANCHES.length))) {
      continue;
    }
    refsByCommit.set(commit, [...(refsByCommit.get(commit) ?? []), ref]);
  }
  const commits = [...refsByCommit.keys()].sort();
  if (commits.length === 0) {
    return { held: false };
  }
  const input = commits.map((commit) => `${commit}^{tree}\n${commit}:${CONFIG_FILE}\n`).join('');
  const batch = await git(['cat-file', '--batch-check'], input);
  if (batch.code !== 0) {
    return { failed: batch };
  }
  const answers = batch.stdout.split('\n');
  if (answers.at(-1) === '') {
    answers.pop();
  }
  if (answers.length !== commits.length * 2) {
    return unexpected(batch, 'the tips of the branches of origin');
  }
  const heldRefs: string[] = [];
  for (const [index, commit] of commits.entries()) {
    if (!TREE_LINE.test(answers[index * 2] ?? '')) {
      return { failed: { ...batch, stderr: `git could not read the tree of ${commit}` } };
    }
    if (answers[index * 2 + 1] !== `${commit}:${CONFIG_FILE} missing`) {
      heldRefs.push(...(refsByCommit.get(commit) ?? []));
    }
  }
  if (heldRefs.length === 0) {
    return { held: false };
  }
  const plain = heldRefs.map(branchName).filter(isSafeBranchName).sort();
  return { held: true, name: plain[0] ?? null };
}

/** Why a check could not tell which committed changes to check. */
export type ScopeProblem = StartingCommitProblem | 'listing-failed';

/**
 * What a check with the Stop hook's scope checks. `scan` carries the changed list (absent means
 * the changes that are not committed, which run() lists itself), the commit it was taken from or
 * null, the commit policy is read and guarded at or null for the working tree compared with the
 * last commit, whether that policy is the branch's own because the branch sets usabl up, and the
 * note to print, or null. `gap` means the check cannot tell which changes CI will check, so it
 * checks nothing. `older-than-setup` means the branch left the trusted branch before usabl was set
 * up there, so it checks nothing until the branch is updated.
 */
export type BranchScope =
  | {
      kind: 'scan';
      changedFiles?: string[];
      baseRevision: string | null;
      policyRef: string | null;
      policyFromBranch: boolean;
      note: string | null;
    }
  | { kind: 'gap'; problem: ScopeProblem; branch: string; detail: string | null }
  | { kind: 'older-than-setup'; branch: string };

/**
 * The note on the verdict line of a check that read the branch's own policy, because the branch
 * sets usabl up. It goes inside the brackets after the exit code, so a reader of the verdict
 * alone still sees it.
 */
export const POLICY_FROM_BRANCH_VERDICT_NOTE = 'policy from this branch, not approved yet';

/**
 * The note for a check on a branch that sets usabl up. Neither the trusted branch nor the commit
 * where this branch left it has a config, so there is no trusted policy to read. The check reads
 * the branch's own, and says that CI still asks for approval. It is usabl's own text.
 */
export const POLICY_FROM_BRANCH_NOTE =
  'Note: this branch sets usabl up. The trusted branch and the commit where this branch left it have no usabl.config.json, ' +
  'so usabl read policy from this branch: its config and the guarded files the config names, such as the routes, the waivers, and the evidence floor. ' +
  'That policy is not approved yet: a code owner must approve it in CI before it counts, and the policy check on the pull request asks for that approval.';

/**
 * The lines for a branch that left the trusted branch before usabl was set up there. The trusted
 * branch's name comes from the repository, so the caller prints it inside the untrusted frame.
 * `checked` says what was not checked (nothing, or nothing on this stop). `then` says what to do
 * after the update: stop again, or run the check again.
 */
export function olderThanSetupLines(checked: string, then: string): { head: string; next: string } {
  return {
    head:
      'usabl is set up on the trusted branch but not on this branch (the trusted branch is named under "trusted branch" in the untrusted text below): ' +
      `the commit where this branch left the trusted branch has no usabl.config.json, so this branch has no policy usabl can trust, and usabl checked ${checked}.`,
    next: `Next: update this branch from the trusted branch (merge it or rebase onto it), then ${then}.`,
  };
}

/** What `usabl check --branch-scope` prints for a branch older than the setup. */
export function olderThanSetupText(scope: Extract<BranchScope, { kind: 'older-than-setup' }>): string {
  const lines = olderThanSetupLines('nothing', 'run usabl check --branch-scope again');
  return [
    `usabl: NOT verified - ${lines.head}`,
    lines.next,
    frameUntrustedBlock([boundField(`trusted branch: ${scope.branch}`, 'gapReason')]),
  ].join('\n');
}

/**
 * The note for a check in a repository with no trusted branch to compare with. The check keeps
 * the uncommitted scope, and this note follows its answer, so nothing to check or a verified line
 * never reads as a check of the whole branch. It is usabl's own text.
 */
export const NO_TRUSTED_BRANCH_NOTE =
  'Note: usabl found no trusted branch to compare this branch with, because git records no default branch for origin ' +
  `(${TRUSTED_BRANCH_POINTER} is not set). So this stop checked only the changes that are not committed. ` +
  'Work already committed on this branch was not checked on this stop. To check it on every stop, run ' +
  'git remote set-head origin --auto, which records the default branch of origin. A repository with no remote ' +
  'named origin needs one that holds the trusted branch first.';

/** One plain reason per problem, in usabl's own words. */
export const SCOPE_PROBLEM_REASONS: Record<ScopeProblem, string> = {
  'not-remote-branch':
    'git names that ref as the default branch of origin, which is not a branch of origin under refs/remotes/origin/, so usabl does not trust it',
  'branch-missing': 'git names that branch as the default branch of origin, but this clone has no commit for it',
  'no-common-commit':
    'this branch and the trusted branch share no commit in this clone, which happens in a shallow clone or on a branch with unrelated history',
  'not-ancestor': 'the commit git found is not an ancestor of HEAD, so it cannot be where this branch started',
  'trusted-branch-may-be-stale':
    'neither that branch nor the commit where this branch left it has usabl.config.json, but another branch of origin has one at its tip, ' +
    'so origin/HEAD may be stale: after a project moves its default branch, a fetch does not move origin/HEAD. ' +
    'usabl does not read this branch as one that sets usabl up while another branch of origin has a config ' +
    '(the first such branch with a plain name is under "branch with usabl.config.json" in the untrusted text below)',
  'git-failed': 'git failed while it looked for that commit (its error is under "error" in the untrusted text below)',
  'listing-failed':
    'git could not list the files changed since that commit (its error is under "error" in the untrusted text below)',
};

// The problems a fetch alone does not clear, because origin/HEAD itself names the wrong ref. After
// a default branch rename, origin/HEAD still names the old branch, and a fetch does not move it.
const SET_HEAD_FIRST: ReadonlySet<ScopeProblem> = new Set<ScopeProblem>([
  'not-remote-branch',
  'branch-missing',
  'trusted-branch-may-be-stale',
]);

/**
 * The untrusted line for a scope gap's detail, or null when it has none: git's error, or the
 * other branch of origin that holds a config. Both come from the repository, so the caller prints
 * it inside the untrusted frame.
 */
export function scopeGapDetailPiece(scope: { problem: ScopeProblem; detail: string | null }): string | null {
  if (scope.detail === null) {
    return null;
  }
  return scope.problem === 'trusted-branch-may-be-stale' ? `branch with ${CONFIG_FILE}: ${scope.detail}` : `error: ${scope.detail}`;
}

/**
 * The next step for a scope gap, shared by the Stop hook and `usabl check --branch-scope`.
 * `then` says what to do after the fix: stop again, or run the check again.
 */
export function scopeGapNextStep(problem: ScopeProblem, then: string): string {
  const fetch =
    'fetch the trusted branch with the history this branch grew from, for example git fetch origin, ' +
    'or git fetch --unshallow in a shallow clone';
  const first = SET_HEAD_FIRST.has(problem)
    ? `Next: run git remote set-head origin --auto, which records the default branch of origin again, then ${fetch}, then ${then}.`
    : `Next: ${fetch}, then ${then}.`;
  return (
    `${first} If the branch shares no history with the trusted branch, run usabl check and check the change by hand ` +
    'before you call it accessible.'
  );
}

/** The check a message tells the reader to run. */
export type CheckCommand = 'usabl check' | 'usabl check --branch-scope';

/**
 * The check whose receipt answers the next stop. A stop with a starting commit verifies a receipt
 * only when it binds that commit, and a plain usabl check binds none, so advice on such a stop
 * names usabl check --branch-scope. A stop with no starting commit keeps usabl check.
 */
export function checkCommandFor(baseRevision: string | null): CheckCommand {
  return baseRevision === null ? 'usabl check' : 'usabl check --branch-scope';
}

/**
 * What `usabl check --branch-scope` prints when it cannot tell which changes to check. It gives
 * the reason the Stop hook gives, and the branch name and git's error go inside the untrusted
 * frame, because git prints text this repository controls.
 */
export function branchScopeGapText(scope: Extract<BranchScope, { kind: 'gap' }>): string {
  const lines = [
    'usabl: NOT verified - not covered: usabl could not find where this branch left the trusted branch ' +
      `(named under "trusted branch" in the untrusted text below), because ${SCOPE_PROBLEM_REASONS[scope.problem]}. ` +
      'So it could not tell which committed changes CI will check, and it checked nothing. ' +
      'It did not fall back to the uncommitted changes alone or to the whole history.',
    scopeGapNextStep(scope.problem, 'run usabl check --branch-scope again'),
  ];
  const detail = scopeGapDetailPiece(scope);
  const pieces = [`trusted branch: ${scope.branch}`, ...(detail === null ? [] : [detail])];
  return [...lines, frameUntrustedBlock(pieces.map((piece) => boundField(piece, 'gapReason')))].join('\n');
}

function errorText(err: unknown): string {
  return firstLine(err instanceof Error ? err.message : String(err));
}

/**
 * What a check with the Stop hook's scope checks: every file changed since this branch left the
 * trusted branch, plus the changes that are not committed. The committed part is listed by
 * listChangedFiles, the function CI uses, from the starting commit itself, so the lists cannot
 * drift apart. The Stop hook and `usabl check --branch-scope` both call this.
 *
 * A starting commit that cannot be found or used, a lookup that throws, and a listing that fails
 * are a gap. The check never falls back to the uncommitted changes, to the whole history, or to
 * nothing to check. With no trusted branch at all it keeps the uncommitted scope, with the note.
 *
 * Policy is read at the starting commit when that commit holds a config. On a branch that sets
 * usabl up it is read from the branch, with the note that says so. A branch older than the setup
 * on the trusted branch checks nothing. See PolicySource.
 */
export async function resolveBranchScope(
  find: () => Promise<StartingCommit>,
  git: Pick<GitReader, 'diffNameOnly' | 'statusZ'>,
): Promise<BranchScope> {
  // A lookup that throws is a git failure, never the narrower scope.
  const start = await find().catch(
    (err: unknown): StartingCommit => ({ kind: 'not-found', branch: 'origin/HEAD', problem: 'git-failed', detail: errorText(err) }),
  );
  if (start.kind === 'not-found') {
    return { kind: 'gap', problem: start.problem, branch: start.branch, detail: start.detail };
  }
  if (start.kind === 'no-trusted-branch') {
    return { kind: 'scan', baseRevision: null, policyRef: null, policyFromBranch: false, note: NO_TRUSTED_BRANCH_NOTE };
  }
  if (start.policy === 'branch-older-than-setup') {
    return { kind: 'older-than-setup', branch: start.branch };
  }
  let changedFiles: string[];
  try {
    changedFiles = await listChangedFiles(git, start.commit);
  } catch (err) {
    return { kind: 'gap', problem: 'listing-failed', branch: start.branch, detail: errorText(err) };
  }
  if (start.policy === 'branch-sets-usabl-up') {
    return {
      kind: 'scan',
      changedFiles,
      baseRevision: start.commit,
      policyRef: null,
      policyFromBranch: true,
      note: POLICY_FROM_BRANCH_NOTE,
    };
  }
  return { kind: 'scan', changedFiles, baseRevision: start.commit, policyRef: start.commit, policyFromBranch: false, note: null };
}

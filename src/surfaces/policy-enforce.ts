/**
 * CI enforcement projections for an already-gated Result.
 * This unit never calls `gate()` and never changes `Result.verdict`.
 * Accessibility and policy checks split GitHub required status only.
 * GitHub review lookup is injected. `run()` stays GitHub-free.
 */
import { compileCodeownersPattern, readCodeownersLine, type CodeownersMatch } from '../primitives/match-codeowners.js';
import type { Result } from '../contracts/index.js';
import { guardScopeAtRefs } from '../trust/guard.js';
import { InputRefusedError } from '../intake/input-refusal.js';
import { parseResultDocument } from '../intake/result-document.js';

export interface PolicyReview {
  userLogin: string;
  state: string;
  commitId: string;
}

export interface PolicyPr {
  authorLogin: string;
  headSha: string;
}

export interface PolicyGit {
  show(ref: string, path: string): Promise<string | null>;
  lsFilesUnder(ref: string, prefixes: readonly string[]): Promise<string[]>;
}

export interface PolicyEnforceDeps {
  trustedRef: string;
  pr: PolicyPr;
  git: PolicyGit;
  listReviews: () => Promise<PolicyReview[]>;
  // The body of GitHub's answer to GET /repos/{owner}/{repo}/collaborators/{login}/permission for
  // one login. It throws when the read fails. The check reads only its `permission` field.
  readPermission: (login: string) => Promise<unknown>;
}

export interface EnforceOutcome {
  exitCode: 0 | 2 | 4;
  message: string;
}

const CODEOWNERS_PATH = '.github/CODEOWNERS';
export const GITHUB_REVIEWS_PAGE_SIZE = 100;
const GITHUB_REVIEWS_PAGE_CAP = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Stdin Result is untrusted JSON. It is checked against the whole Result contract, not only the
 * honesty fields CI exits on, so a hand-edited artifact cannot put `approval_required` on the
 * accessibility check and cannot hand a projector text where the contract says a count or an
 * enum value goes. See src/intake/result-document.ts.
 */
export function parseResultJson(value: unknown): Result {
  return parseResultDocument(value);
}

/**
 * Parses standard input text as a Result. Text that is not JSON is refused without the parser's
 * own message, because that message quotes the input back.
 */
export function parseResultText(text: string): Result {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InputRefusedError(
      '',
      'The Result on standard input is not valid JSON. Pass the Result JSON that "usabl check --json" wrote, unchanged.',
    );
  }
  return parseResultJson(parsed);
}

export function parsePullRequestEvent(
  parsed: unknown,
): (PolicyPr & { number: number }) | null {
  if (!isRecord(parsed)) {
    return null;
  }
  const pull = parsed['pull_request'];
  if (!isRecord(pull)) {
    return null;
  }
  const user = pull['user'];
  const head = pull['head'];
  const number = pull['number'];
  const login = isRecord(user) ? user['login'] : undefined;
  const sha = isRecord(head) ? head['sha'] : undefined;
  if (typeof login !== 'string' || typeof sha !== 'string' || typeof number !== 'number') {
    return null;
  }
  return { authorLogin: login, headSha: sha, number };
}

export function parseGithubReviews(body: unknown): PolicyReview[] {
  if (!Array.isArray(body)) {
    return [];
  }
  const reviews: PolicyReview[] = [];
  for (const entry of body) {
    if (!isRecord(entry)) {
      continue;
    }
    const user = entry['user'];
    const login = isRecord(user) ? user['login'] : undefined;
    const state = entry['state'];
    const commitId = entry['commit_id'];
    if (typeof login === 'string' && typeof state === 'string' && typeof commitId === 'string') {
      reviews.push({ userLogin: login, state, commitId });
    }
  }
  return reviews;
}

/**
 * GitHub paginates reviews. A full last page means we did not see every review,
 * and a missed CHANGES_REQUESTED would be a fake green.
 */
export async function collectReviews(
  listPage: (page: number) => Promise<unknown>,
): Promise<PolicyReview[]> {
  const reviews: PolicyReview[] = [];
  for (let page = 1; page <= GITHUB_REVIEWS_PAGE_CAP; page += 1) {
    const body = await listPage(page);
    if (!Array.isArray(body)) {
      throw new Error('GitHub reviews response was not an array');
    }
    reviews.push(...parseGithubReviews(body));
    if (body.length < GITHUB_REVIEWS_PAGE_SIZE) {
      return reviews;
    }
  }
  throw new Error('GitHub reviews listing was truncated');
}

// Printed when a Result carries no accessibility verdict and exit 0 but does not say there was
// nothing to check. The engine writes that pair only for an idle run, where no UI file changed.
const NO_VERDICT_NOT_IDLE =
  'accessibility: no verdict (4). The Result has no accessibility verdict and does not say that nothing was to check, so usabl proved nothing about this change and this blocks. Run usabl check --json again and pass its Result unchanged.';

export function enforceAccessibility(result: Result): { exitCode: Result['accessibilityExitCode']; message: string } {
  if (result.exitCode === 4) {
    return { exitCode: 4, message: result.summary };
  }
  // Idle is exit 0 with no verdict and nothing to check. No verdict with exit 0 on a Result that
  // does not say nothing was to check is not idle: it is a run that reached no verdict, and the
  // pull request comment and the Stop hook read it that way too. Reading it as idle would pass a
  // change that was never checked. The flag must be exactly true, because a document can carry
  // any value there.
  if (
    result.accessibilityVerdict === null &&
    result.accessibilityExitCode === 0 &&
    result.coverage?.nothingToCheck !== true
  ) {
    return { exitCode: 4, message: NO_VERDICT_NOT_IDLE };
  }
  return {
    exitCode: result.accessibilityExitCode,
    message: `accessibility ${result.accessibilityVerdict ?? 'idle'} (${result.accessibilityExitCode})`,
  };
}

export async function enforcePolicy(result: Result, deps: PolicyEnforceDeps): Promise<EnforceOutcome> {
  if (result.exitCode === 4) {
    return { exitCode: 4, message: result.summary };
  }

  // Git refs are the policy source of truth. A forged stdin verdict cannot skip CODEOWNERS.
  const scope = await guardScopeAtRefs(deps.git, deps.trustedRef, deps.pr.headSha);
  const outcome = await decidePolicy(scope.diverged, deps);
  // Each entry the guard read wide is named in every outcome, with how to write it.
  return scope.readWide.length === 0 ? outcome : { ...outcome, message: `${outcome.message}. ${scope.readWide.join(' ')}` };
}

async function decidePolicy(dirtyGuardedPaths: string[], deps: PolicyEnforceDeps): Promise<EnforceOutcome> {
  if (dirtyGuardedPaths.length === 0) {
    return { exitCode: 0, message: 'no policy change' };
  }

  const raw = await deps.git.show(deps.trustedRef, CODEOWNERS_PATH);
  if (raw === null || raw.trim().length === 0) {
    return { exitCode: 2, message: `missing ${CODEOWNERS_PATH} at ${deps.trustedRef}` };
  }

  const limits = readCodeownersLimits(raw, dirtyGuardedPaths);
  if (!limits.ok) {
    return { exitCode: 2, message: limits.message };
  }

  const reviews = await deps.listReviews();
  const latest = latestDecisiveReviewByUser(reviews);
  const author = deps.pr.authorLogin.toLowerCase();

  // Two different facts used to share one message. A path with owners who have not
  // approved is a request a reviewer can answer. A path no review can clear (no rule, a rule
  // with no owner, a team or email owner, or an unknown last match) is a limit, and it reads as
  // one. Both refuse, so an unsatisfiable gate cannot pass for a busy one.
  const unapproved: string[] = [];
  const notCounted = new Map<string, PermissionRead>();
  const permissionOf = permissionReader(deps.readPermission);
  for (const [path, owners] of limits.userOwners) {
    const approvers = headApprovers(owners, latest, author, deps.pr.headSha);
    let approved = false;
    for (const owner of approvers) {
      if (countsAsWrite(await permissionOf(owner))) {
        approved = true;
        break;
      }
    }
    if (!approved) {
      unapproved.push(path);
      // Every approver of this path was read above, so these reads come from the cache.
      for (const owner of approvers) {
        notCounted.set(owner, await permissionOf(owner));
      }
    }
  }

  const reasons = [...limits.reasons];
  if (unapproved.length > 0) {
    reasons.push(
      `approval required: no CODEOWNERS user other than the PR author approved this head for ${unapproved.join(', ')}`,
    );
  }
  for (const [owner, permission] of [...notCounted].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    reasons.push(`the approval from @${owner} does not count, because ${permissionText(owner, permission)}`);
  }
  if (reasons.length > 0) {
    return { exitCode: 2, message: reasons.join('; ') };
  }
  return { exitCode: 0, message: 'policy owner approved current head' };
}

interface CodeownersRule {
  pattern: string;
  users: string[];
  // Whether the rule names an @org/team or an email. usabl cannot resolve team membership or
  // match an email to a login, so it cannot tell who may approve a path this rule owns.
  namesTeamOrEmail: boolean;
  state: (path: string) => CodeownersMatch;
}

const OWNER_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Reads every rule, or refuses the whole file. A pattern usabl cannot parse, or an owner that is
 * not a user, a team, or an email, refuses the whole file: GitHub may skip such a line, so usabl
 * cannot tell which rule matches a path last. A team or email owner and a rule with no owner are
 * kept, because they only matter for the paths whose last match they are.
 */
function parseCodeowners(raw: string): { ok: true; rules: CodeownersRule[] } | { ok: false; message: string } {
  const rules: CodeownersRule[] = [];
  for (const line of raw.split('\n')) {
    const read = readCodeownersLine(line);
    if (read.kind === 'refused') {
      return { ok: false, message: read.message };
    }
    if (read.kind === 'blank') {
      continue;
    }
    const { pattern, owners } = read;
    // A pattern this matcher cannot honour would otherwise yield a rule that owns nothing, which
    // reads as "nobody owns this" instead of "usabl cannot tell".
    const compiled = compileCodeownersPattern(pattern);
    if (!compiled.ok) {
      return { ok: false, message: `CODEOWNERS pattern ${pattern} is not supported: ${compiled.reason}` };
    }
    const users: string[] = [];
    let namesTeamOrEmail = false;
    for (const owner of owners) {
      if (owner === '@') {
        return { ok: false, message: 'CODEOWNERS owner is empty' };
      }
      if (owner.startsWith('@') && owner.slice(1).includes('/')) {
        namesTeamOrEmail = true;
      } else if (owner.startsWith('@')) {
        users.push(owner.slice(1).toLowerCase());
      } else if (OWNER_EMAIL.test(owner)) {
        namesTeamOrEmail = true;
      } else {
        return {
          ok: false,
          message: `CODEOWNERS owner ${owner} is not a @user login, an @org/team, or an email`,
        };
      }
    }
    rules.push({ pattern, users, namesTeamOrEmail, state: compiled.state });
  }
  return { ok: true, rules };
}

export type CodeownersLimits =
  | { ok: false; message: string }
  | {
      ok: true;
      // One sentence per limit that no review can clear, in a fixed order.
      reasons: string[];
      // The user logins that can approve each path no limit applies to.
      userOwners: Map<string, Set<string>>;
    };

/**
 * What `usabl enforce policy` can and cannot accept for each path, from the last CODEOWNERS rule
 * that matches it. A path no rule matches, a path whose last rule names no owner, a path whose last
 * rule names a team or an email, and a path whose last match is unknown can never be approved, so
 * each is a limit. doctor reports the same limits with the same words, so a repository doctor
 * reads as wired is one this check can pass.
 */
export function readCodeownersLimits(raw: string, paths: readonly string[]): CodeownersLimits {
  const parsed = parseCodeowners(raw);
  if (!parsed.ok) {
    return parsed;
  }
  const unmatched: string[] = [];
  const ownerless: string[] = [];
  const teamOrEmail: string[] = [];
  const unknown: string[] = [];
  const unknownPatterns = new Set<string>();
  const userOwners = new Map<string, Set<string>>();
  for (const path of [...new Set(paths)].sort()) {
    // GitHub last-match-wins: a later rule for the same path replaces earlier owners. A later rule
    // that may or may not match makes the last match unknown.
    const rule = parsed.rules.filter((candidate) => candidate.state(path) !== 'none').pop();
    if (rule !== undefined && rule.state(path) === 'unknown') {
      unknown.push(path);
      unknownPatterns.add(rule.pattern);
    } else if (rule === undefined) {
      unmatched.push(path);
    } else if (rule.namesTeamOrEmail) {
      teamOrEmail.push(path);
    } else if (rule.users.length === 0) {
      ownerless.push(path);
    } else {
      userOwners.set(path, new Set(rule.users));
    }
  }
  const reasons: string[] = [];
  if (unmatched.length > 0) {
    reasons.push(`no CODEOWNERS rule covers ${unmatched.join(', ')}`);
  }
  if (ownerless.length > 0) {
    reasons.push(`the last CODEOWNERS rule that matches ${ownerless.join(', ')} names no owner`);
  }
  if (teamOrEmail.length > 0) {
    reasons.push(
      `the last CODEOWNERS rule that matches ${teamOrEmail.join(', ')} names a team or an email, and usabl enforce policy accepts approval only from a user login`,
    );
  }
  if (unknown.length > 0) {
    reasons.push(
      `usabl cannot tell which CODEOWNERS rule matches ${unknown.join(', ')} last, because GitHub's documentation does not say whether ${[...unknownPatterns].join(', ')} matches it`,
    );
  }
  return { ok: true, reasons, userOwners };
}

// The owners other than the author whose latest decisive review approves this head, sorted.
function headApprovers(
  owners: Set<string>,
  latest: Map<string, PolicyReview>,
  author: string,
  headSha: string,
): string[] {
  return [...owners]
    .filter((owner) => {
      if (owner === author) {
        return false;
      }
      const review = latest.get(owner);
      return review !== undefined && review.state === 'APPROVED' && review.commitId === headSha;
    })
    .sort();
}

/**
 * On a public repository anyone can submit an approving review, and GitHub counts a code owner's
 * review only from a person who can write to the repository. A login in CODEOWNERS that lost its
 * access, or a name someone else registered, must not pass this check. So an approval counts only
 * when GitHub reports the owner's permission on the repository as admin or write. A read that
 * fails, or an answer outside GitHub's four values, never counts as write.
 */
const PERMISSIONS = ['admin', 'write', 'read', 'none'] as const;
type PermissionRead = (typeof PERMISSIONS)[number] | 'unread' | 'not-a-login';

// GitHub's login form: letters, digits, and single hyphens inside, at most 39 characters.
const GITHUB_LOGIN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i;

function countsAsWrite(permission: PermissionRead): boolean {
  return permission === 'admin' || permission === 'write';
}

// Reads each login's permission at most once. A login that is not in GitHub's form is not asked.
function permissionReader(read: PolicyEnforceDeps['readPermission']): (login: string) => Promise<PermissionRead> {
  const cache = new Map<string, Promise<PermissionRead>>();
  return (login) => {
    let found = cache.get(login);
    if (found === undefined) {
      found = GITHUB_LOGIN.test(login) ? readOnePermission(read, login) : Promise.resolve('not-a-login');
      cache.set(login, found);
    }
    return found;
  };
}

async function readOnePermission(read: PolicyEnforceDeps['readPermission'], login: string): Promise<PermissionRead> {
  try {
    const body = await read(login);
    const permission = isRecord(body) ? body['permission'] : undefined;
    return PERMISSIONS.find((known) => known === permission) ?? 'unread';
  } catch {
    return 'unread';
  }
}

function permissionText(owner: string, permission: PermissionRead): string {
  if (permission === 'not-a-login') {
    return `${owner} is not a GitHub login`;
  }
  if (permission === 'read' || permission === 'none') {
    return `GitHub reports that user's permission on this repository as ${permission}, and an approval counts only with write or admin`;
  }
  return "usabl could not read that user's permission on this repository (the job's token needs read access to repository metadata)";
}

function latestDecisiveReviewByUser(reviews: PolicyReview[]): Map<string, PolicyReview> {
  const latest = new Map<string, PolicyReview>();
  for (const review of reviews) {
    const state = review.state.toUpperCase();
    // COMMENTED does not retract APPROVED on GitHub. CHANGES_REQUESTED does.
    // Ignoring comment-only reviews keeps a later comment from becoming a fake red
    // and still lets a later request-for-changes retract an approval.
    if (state !== 'APPROVED' && state !== 'CHANGES_REQUESTED') {
      continue;
    }
    latest.set(review.userLogin.toLowerCase(), { ...review, state });
  }
  return latest;
}

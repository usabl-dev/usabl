/**
 * CI enforcement projections for an already-gated Result.
 * This unit never calls `gate()` and never changes `Result.verdict`.
 * Accessibility and policy checks split GitHub required status only.
 * GitHub review lookup is injected. `run()` stays GitHub-free.
 */
import { matchGlob } from '../primitives/match-glob.js';
import type { Result } from '../contracts/index.js';

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
}

export interface PolicyEnforceDeps {
  trustedRef: string;
  pr: PolicyPr;
  git: PolicyGit;
  listReviews: () => Promise<PolicyReview[]>;
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
 * Stdin Result is untrusted JSON. Validate the honesty fields CI will exit on
 * so a hand-edited artifact cannot put `approval_required` on the accessibility check.
 */
export function parseResultJson(value: unknown): Result {
  if (!isRecord(value)) {
    throw new Error('input must be a Result object');
  }
  if (value['schemaVersion'] !== 'usabl.result.v1') {
    throw new Error('input must have schemaVersion usabl.result.v1');
  }
  const accessibilityExitCode = value['accessibilityExitCode'];
  if (
    accessibilityExitCode !== 0 &&
    accessibilityExitCode !== 1 &&
    accessibilityExitCode !== 3 &&
    accessibilityExitCode !== 4
  ) {
    throw new Error('accessibilityExitCode must be 0, 1, 3, or 4');
  }
  if (value['accessibilityVerdict'] === 'approval_required') {
    throw new Error('accessibilityVerdict must not be approval_required');
  }
  return value as unknown as Result;
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

export function enforceAccessibility(result: Result): { exitCode: Result['accessibilityExitCode']; message: string } {
  if (result.exitCode === 4) {
    return { exitCode: 4, message: result.summary };
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
  if (result.verdict !== 'approval_required') {
    return { exitCode: 0, message: 'no policy change' };
  }

  const raw = await deps.git.show(deps.trustedRef, CODEOWNERS_PATH);
  if (raw === null || raw.trim().length === 0) {
    return { exitCode: 2, message: `missing ${CODEOWNERS_PATH} at ${deps.trustedRef}` };
  }

  const parsed = parseCodeowners(raw);
  if (!parsed.ok) {
    return { exitCode: 2, message: parsed.message };
  }

  const owners = ownersFor(parsed.rules, result.dirtyGuardedPaths);
  if (owners.size === 0) {
    return { exitCode: 2, message: 'no CODEOWNERS user logins for dirty guarded paths' };
  }

  const reviews = await deps.listReviews();
  const latest = latestDecisiveReviewByUser(reviews);
  const author = deps.pr.authorLogin.toLowerCase();
  const approved = [...owners].some((owner) => {
    if (owner === author) {
      return false;
    }
    const review = latest.get(owner);
    return review !== undefined && review.state === 'APPROVED' && review.commitId === deps.pr.headSha;
  });

  if (!approved) {
    return {
      exitCode: 2,
      message: 'approval required: need a CODEOWNERS user review of this head that is not the PR author',
    };
  }
  return { exitCode: 0, message: 'policy owner approved current head' };
}

interface CodeownersRule {
  pattern: string;
  users: string[];
}

function parseCodeowners(raw: string): { ok: true; rules: CodeownersRule[] } | { ok: false; message: string } {
  const rules: CodeownersRule[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.replace(/#.*$/, '').trim();
    if (trimmed.length === 0) {
      continue;
    }
    const parts = trimmed.split(/\s+/);
    const pattern = parts[0];
    const owners = parts.slice(1);
    if (pattern === undefined || owners.length === 0) {
      return { ok: false, message: 'CODEOWNERS line is missing a pattern or owner' };
    }
    const users: string[] = [];
    for (const owner of owners) {
      if (!owner.startsWith('@')) {
        return { ok: false, message: 'CODEOWNERS owners must be @user logins' };
      }
      const name = owner.slice(1);
      // Org teams need membership resolution. v1 fails closed rather than
      // treating @org/team as a user who can satisfy the required check.
      if (name.includes('/')) {
        return { ok: false, message: 'CODEOWNERS v1 requires a user login, not an org team' };
      }
      if (name.length === 0) {
        return { ok: false, message: 'CODEOWNERS owner is empty' };
      }
      users.push(name.toLowerCase());
    }
    rules.push({ pattern, users });
  }
  return { ok: true, rules };
}

function ownersFor(rules: CodeownersRule[], paths: string[]): Set<string> {
  const owners = new Set<string>();
  for (const path of paths) {
    // GitHub last-match-wins: a later rule for the same path replaces earlier owners.
    let matched: CodeownersRule | null = null;
    for (const rule of rules) {
      if (matchGlob(rule.pattern, path) || rule.pattern === path) {
        matched = rule;
      }
    }
    if (matched !== null) {
      for (const user of matched.users) {
        owners.add(user);
      }
    }
  }
  return owners;
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

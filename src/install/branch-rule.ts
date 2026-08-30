/**
 * Branch protection generator for `usabl install --branch-rule`.
 * This generator is read-only. It NEVER mutates a repository setting. It prints the exact
 * protection the operator must apply and verifies the current state with a single
 * read-only gh call. It only reports "verified" when it can positively confirm that
 * usabl-policy is a required status check; otherwise it refuses and prints the setting,
 * because claiming verified without proof would be a false green.
 */

// The gate triggers on pull requests into main, so main is the branch to protect and
// usabl-policy is the required job name from the gate workflow.
export const PROTECTED_BRANCH = 'main';
export const REQUIRED_CHECK = 'usabl-policy';

// The read-only gh call. {owner}/{repo} are resolved by gh from the current repo context,
// so no repository slug is interpolated from any external input.
const PROTECTION_ENDPOINT = `repos/{owner}/{repo}/branches/${PROTECTED_BRANCH}/protection`;

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GhReader {
  // Returns the process result, or null when gh could not run at all (not installed).
  // The reader is only ever asked to perform read-only requests.
  run(args: string[]): Promise<GhResult | null>;
}

export interface BranchRuleResult {
  // 0 = verified (usabl-policy is required); 2 = not applied or cannot verify, both of
  // which need a manual step. Only a positive confirmation returns 0.
  exitCode: 0 | 2;
  action: 'verified' | 'not-applied' | 'cannot-verify';
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isUsablPolicyRequired(parsed: unknown): boolean {
  if (!isRecord(parsed)) {
    return false;
  }
  const rsc = parsed['required_status_checks'];
  if (!isRecord(rsc)) {
    return false;
  }
  const contexts: string[] = [];
  // Legacy shape: required_status_checks.contexts is a list of strings.
  const legacy = rsc['contexts'];
  if (Array.isArray(legacy)) {
    for (const entry of legacy) {
      if (typeof entry === 'string') {
        contexts.push(entry);
      }
    }
  }
  // Modern shape: required_status_checks.checks is a list of { context, app_id }.
  const checks = rsc['checks'];
  if (Array.isArray(checks)) {
    for (const entry of checks) {
      if (isRecord(entry) && typeof entry['context'] === 'string') {
        contexts.push(entry['context']);
      }
    }
  }
  return contexts.includes(REQUIRED_CHECK);
}

export function branchRuleSetting(): string {
  return [
    `Apply this branch protection on the "${PROTECTED_BRANCH}" branch:`,
    '  - Require status checks to pass before merging.',
    `  - Required status check context: ${REQUIRED_CHECK} (the required job in .github/workflows/usabl-gate.yml).`,
    '  - Require the branch to be up to date before merging (strict).',
    '  - Require a pull request before merging.',
    '  - Require review from Code Owners, so guarded-file changes need an owner approval that usabl-policy enforces.',
    '',
    'The resulting protection state, with exact values:',
    `  required_status_checks: { strict: true, contexts: ["${REQUIRED_CHECK}"] }`,
    '  required_pull_request_reviews: { require_code_owner_reviews: true }',
    '  enforce_admins: true',
  ].join('\n');
}

function verifyByHand(): string {
  return [
    'Verify by hand (read-only):',
    `  gh api ${PROTECTION_ENDPOINT} --jq '.required_status_checks'`,
    '  or open Settings > Branches in the GitHub web UI.',
  ].join('\n');
}

function looksLikeMissingProtection(stderr: string): boolean {
  // A 404 on the protection endpoint means the branch has no protection yet. That is a
  // confident "not applied", distinct from an auth or network failure we cannot judge.
  return /404/.test(stderr) || /not found/i.test(stderr);
}

export async function verifyBranchRule(gh: GhReader): Promise<BranchRuleResult> {
  const setting = branchRuleSetting();

  let outcome: GhResult | null;
  try {
    // Default method is GET. We never pass -X or --method, so this cannot mutate anything.
    outcome = await gh.run(['api', PROTECTION_ENDPOINT]);
  } catch {
    outcome = null;
  }

  if (outcome === null) {
    return {
      exitCode: 2,
      action: 'cannot-verify',
      message: `cannot verify: gh is not available.\n${setting}\n${verifyByHand()}`,
    };
  }

  if (outcome.code !== 0) {
    if (looksLikeMissingProtection(outcome.stderr)) {
      return {
        exitCode: 2,
        action: 'not-applied',
        message: `not applied: the ${PROTECTED_BRANCH} branch has no protection requiring ${REQUIRED_CHECK}.\n${setting}`,
      };
    }
    return {
      exitCode: 2,
      action: 'cannot-verify',
      message: `cannot verify: gh could not read branch protection (exit ${outcome.code}).\n${setting}\n${verifyByHand()}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.stdout);
  } catch {
    return {
      exitCode: 2,
      action: 'cannot-verify',
      message: `cannot verify: branch protection response was not readable JSON.\n${setting}\n${verifyByHand()}`,
    };
  }

  if (isUsablPolicyRequired(parsed)) {
    return {
      exitCode: 0,
      action: 'verified',
      message: `verified: ${REQUIRED_CHECK} is a required status check on ${PROTECTED_BRANCH}.`,
    };
  }
  return {
    exitCode: 2,
    action: 'not-applied',
    message: `not applied: ${REQUIRED_CHECK} is not a required status check on ${PROTECTED_BRANCH}.\n${setting}`,
  };
}

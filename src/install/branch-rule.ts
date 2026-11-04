/**
 * Branch protection generator for `usabl install --branch-rule`.
 * This generator is read-only. It NEVER mutates a repository setting. It prints the exact
 * protection the operator must apply and verifies the current state with read-only gh calls.
 * It only reports "verified" when it can positively confirm every part of the protection: the
 * required check, required code-owner review, at least one required approving review, and
 * dismissal of stale approvals on push. Otherwise
 * it refuses and prints the setting, because claiming verified without proof would be a false
 * green.
 *
 * Why both. Any pull request, from a branch or a fork, runs the workflow as the pull request
 * changed it, so a pull request that edits .github/workflows can make usabl-required pass whatever
 * it judged. The verdict on such a pull request is not evidence. What stops it merging is code
 * owner review: .github/workflows and the guarded paths listed in CODEOWNERS, and the protected
 * branch requiring a code owner's approval. GitHub requires none when the required approving
 * review count is 0, even with code-owner review on, so the count must be at least 1. That
 * approval has to be of the last push: with stale
 * approvals kept, an owner approves a harmless change and the author then pushes one that makes
 * the check pass, and the earlier approval still counts. Only an organization-required workflow,
 * an Enterprise feature, takes the workflow out of the pull request's hands.
 */
import { REQUIRED_GATE_JOB } from './ci.js';

// The gate triggers on pull requests into main, so main is the branch to protect. The check
// to require is the aggregate job, taken from the workflow generator rather than restated
// here, so the name an operator is told to require and the job that decides the merge can
// never drift apart. Requiring usabl-policy alone is not enough: it returns success whenever
// no guarded path diverged, so an accessibility regression satisfies it.
export const PROTECTED_BRANCH = 'main';
export const REQUIRED_CHECK = REQUIRED_GATE_JOB;

// The read-only gh call. {owner}/{repo} are resolved by gh from the current repo context,
// so no repository slug is interpolated from any external input.
const PROTECTION_ENDPOINT = `repos/{owner}/{repo}/branches/${PROTECTED_BRANCH}/protection`;
// The repository itself, read only for its default branch when a ruleset targets ~DEFAULT_BRANCH.
const REPOSITORY_ENDPOINT = 'repos/{owner}/{repo}';

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GhReader {
  // Read-only by construction: the only method issues a GET against an api endpoint. There
  // is no way to pass a method or a mutating body through this port, so a caller cannot turn
  // it into a write. Returns null when gh could not run at all (not installed).
  getJson(endpoint: string): Promise<GhResult | null>;
}

export interface BranchRuleResult {
  // 0 = verified (the required check is present); 2 = not applied or cannot verify, both of
  // which need a manual step. Only a positive confirmation returns 0.
  exitCode: 0 | 2;
  action: 'verified' | 'not-applied' | 'cannot-verify';
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRequiredCheckPresent(parsed: unknown): boolean {
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
    `  - Required status check context: ${REQUIRED_CHECK} (the aggregate job in .github/workflows/usabl-gate.yml).`,
    `    ${REQUIRED_CHECK} is red unless the accessibility verdict and the policy verdict both pass.`,
    '    Requiring gate-comment or usabl-policy instead is not enough: gate-comment cannot run on a',
    '    review event, and usabl-policy passes whenever no guarded path diverged, which says nothing',
    '    about accessibility. Either one alone can be green while an accessibility regression merges.',
    '  - Require the branch to be up to date before merging (strict).',
    '  - Require a pull request before merging.',
    '  - Require review from Code Owners. This is the protection that holds when a pull request edits',
    '    the gate itself: any pull request, from a branch or a fork, runs the workflow as it changed it,',
    `    so it can make ${REQUIRED_CHECK} pass whatever it judged, and that verdict is not evidence.`,
    '  - Require at least one approval before merging. With 0 required approvals, GitHub requires no',
    '    review at all, even with Code Owners review on.',
    '  - Dismiss stale pull request approvals when new commits are pushed. Otherwise an owner approves a',
    '    harmless change, the author then pushes a workflow edit, and the earlier approval still counts.',
    '  - In .github/CODEOWNERS, give .github/workflows/ and every guarded path an owner, for example:',
    '      /.github/workflows/ @your-login',
    '      /.github/CODEOWNERS @your-login',
    '      /usabl.config.json @your-login',
    '    so a pull request that changes the gate or its policy cannot merge without an owner approving it.',
    '',
    'The resulting protection state, with exact values:',
    `  required_status_checks: { strict: true, contexts: ["${REQUIRED_CHECK}"] }`,
    '  required_pull_request_reviews: { require_code_owner_reviews: true, required_approving_review_count: 1, dismiss_stale_reviews: true }',
    '  enforce_admins: true',
    'A ruleset can set the same: a required_status_checks rule naming the check and a pull_request rule',
    'with require_code_owner_review, required_approving_review_count of at least 1, and dismiss_stale_reviews_on_push.',
  ].join('\n');
}

// The repository's branch rulesets. A ruleset can require the same check a classic rule does, so
// doctor must read both or it calls a ruleset-protected repo unprotected. {owner}/{repo} are
// resolved by gh from the current repo context, so no slug is interpolated from external input.
// The rulesets list is paged (repo rulesets plus inherited org rulesets can exceed one page), so it
// is read at the max page size across pages until a short page. The cap is far above any real total;
// hitting it means the list could not be read in full, which is treated as unreadable, not empty.
function rulesetsPageEndpoint(page: number): string {
  return `repos/{owner}/{repo}/rulesets?per_page=100&page=${page}`;
}
const RULESETS_PAGE_SIZE = 100;
const RULESETS_PAGE_CAP = 10;
function rulesetEndpoint(id: number): string {
  return `repos/{owner}/{repo}/rulesets/${id}`;
}

// A ruleset detail body has at least these fields. A response missing them is malformed, so it is
// read as unreadable rather than as a valid ruleset that happens not to protect the branch.
function isRulesetShape(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value['enforcement'] === 'string' && Array.isArray(value['rules']);
}

// Whether a single ref target names the protected branch. "covers" only for targets this code can
// evaluate exactly: ~ALL, refs/heads/main, and ~DEFAULT_BRANCH when the repository says main is its
// default branch. "unknown" for anything usabl cannot evaluate without replicating GitHub's
// fnmatch, and for ~DEFAULT_BRANCH when the default branch could not be read. "no" for another
// literal branch, and for ~DEFAULT_BRANCH when another branch is the default. Unknowns never become
// a confident answer.
type TargetMatch = 'covers' | 'no' | 'unknown';
// Whether main is the repository's default branch: true, false, or null when it was not read.
type DefaultIsMain = boolean | null;
function refTargetMatchesProtected(token: string, defaultIsMain: DefaultIsMain): TargetMatch {
  if (token === '~ALL' || token === `refs/heads/${PROTECTED_BRANCH}`) {
    return 'covers';
  }
  if (token === '~DEFAULT_BRANCH') {
    return defaultIsMain === null ? 'unknown' : defaultIsMain ? 'covers' : 'no';
  }
  if (/[*?[\]]/.test(token)) {
    return 'unknown';
  }
  return 'no';
}

function verifyByHand(): string {
  return [
    'Verify by hand (read-only):',
    `  gh api ${PROTECTION_ENDPOINT} --jq '.required_status_checks'`,
    '  gh api repos/{owner}/{repo}/rulesets   # a ruleset can require the check instead of classic protection',
    '  or open Settings > Branches (and Settings > Rules) in the GitHub web UI.',
  ].join('\n');
}

function isBranchNotProtected(stderr: string): boolean {
  // GitHub returns exactly "Branch not protected" for GET .../protection when the branch
  // exists but has no classic protection. It does not rule out a ruleset, so it is only a
  // confident "no classic rule", checked against rulesets before concluding not-applied.
  return /branch not protected/i.test(stderr);
}

// The classic branch-protection answer for one requirement: confirmed present, confidently
// absent, or unreadable (gh missing, a non-"branch not protected" error, or unparseable JSON).
type ClassicState = 'present' | 'absent' | 'unreadable';

// Whether classic protection requires code-owner review.
export function isCodeOwnerReviewRequired(parsed: unknown): boolean {
  if (!isRecord(parsed)) {
    return false;
  }
  const reviews = parsed['required_pull_request_reviews'];
  return isRecord(reviews) && reviews['require_code_owner_reviews'] === true;
}

// Whether classic protection requires at least one approving review. GitHub requires no review at
// all when the count is 0, code-owner review or not. No review settings is a confident no; a count
// that is not a number cannot be read.
export function isApprovalRequired(parsed: unknown): boolean | 'unknown' {
  if (!isRecord(parsed)) {
    return false;
  }
  const reviews = parsed['required_pull_request_reviews'];
  if (!isRecord(reviews)) {
    return false;
  }
  return approvalCountState(reviews['required_approving_review_count']);
}

function approvalCountState(count: unknown): boolean | 'unknown' {
  return typeof count === 'number' && Number.isFinite(count) ? count >= 1 : 'unknown';
}

// Whether classic protection dismisses stale approvals on push. No review settings at all is a
// confident no. Review settings that do not carry the field as a boolean cannot be read, so they
// are 'unknown', never taken as either answer.
export function isStaleReviewDismissed(parsed: unknown): boolean | 'unknown' {
  if (!isRecord(parsed)) {
    return false;
  }
  const reviews = parsed['required_pull_request_reviews'];
  if (!isRecord(reviews)) {
    return false;
  }
  const dismiss = reviews['dismiss_stale_reviews'];
  return typeof dismiss === 'boolean' ? dismiss : 'unknown';
}

// The classic protection body, or 'absent' (the branch has no classic rule) or 'unreadable'.
async function readClassicProtection(gh: GhReader): Promise<{ body: unknown } | 'absent' | 'unreadable'> {
  let outcome: GhResult | null;
  try {
    outcome = await gh.getJson(PROTECTION_ENDPOINT);
  } catch {
    return 'unreadable';
  }
  if (outcome === null) {
    return 'unreadable';
  }
  if (outcome.code !== 0) {
    return isBranchNotProtected(outcome.stderr) ? 'absent' : 'unreadable';
  }
  try {
    return { body: JSON.parse(outcome.stdout) as unknown };
  } catch {
    return 'unreadable';
  }
}

function classicState(
  classic: { body: unknown } | 'absent' | 'unreadable',
  present: (body: unknown) => boolean | 'unknown',
): ClassicState {
  if (classic === 'absent' || classic === 'unreadable') {
    return classic;
  }
  const answer = present(classic.body);
  return answer === 'unknown' ? 'unreadable' : answer ? 'present' : 'absent';
}

// How a ruleset's branch conditions relate to the protected branch. "covers" and "no" are confident;
// "ambiguous" means usabl cannot tell (a glob or ~DEFAULT_BRANCH in the include, or any target in the
// exclude it cannot evaluate), so it must not be read as either protecting or not protecting main.
type Coverage = 'covers' | 'no' | 'ambiguous';
// A string array, or absent. A present value that is not a clean string array is malformed, and
// silently dropping a non-string entry (an exclusion, say) could turn a real exclude of main into a
// false verified. So malformed conditions are reported ambiguous, never confidently covered or not.
function stringListOrNull(value: unknown): string[] | null {
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value as string[];
  }
  return null;
}
function conditionCoverage(conditions: unknown, defaultIsMain: DefaultIsMain): Coverage {
  if (!isRecord(conditions)) {
    return 'ambiguous';
  }
  const refName = conditions['ref_name'];
  if (!isRecord(refName)) {
    return 'ambiguous';
  }
  const includeList = stringListOrNull(refName['include']);
  const excludeList = stringListOrNull(refName['exclude']);
  if (includeList === null || excludeList === null) {
    return 'ambiguous';
  }
  const include = includeList.map((token) => refTargetMatchesProtected(token, defaultIsMain));
  const exclude = excludeList.map((token) => refTargetMatchesProtected(token, defaultIsMain));

  // Exclusions first. A confident exclusion of main means this ruleset does not protect it. An
  // exclusion usabl cannot evaluate might exclude main, so the whole ruleset is ambiguous.
  if (exclude.includes('covers')) {
    return 'no';
  }
  if (exclude.includes('unknown')) {
    return 'ambiguous';
  }
  // No exclusion touches main. Now the include list decides.
  if (include.includes('covers')) {
    return 'covers';
  }
  if (include.includes('unknown')) {
    return 'ambiguous';
  }
  return 'no';
}

function rulesetRequiresCodeOwnerReview(fullRuleset: Record<string, unknown>): boolean {
  const rules = fullRuleset['rules'];
  if (!Array.isArray(rules)) {
    return false;
  }
  return rules.some(
    (rule) =>
      isRecord(rule) &&
      rule['type'] === 'pull_request' &&
      isRecord(rule['parameters']) &&
      rule['parameters']['require_code_owner_review'] === true,
  );
}

// Whether a ruleset's pull_request rule requires at least one approving review. A pull_request rule
// whose count is not a number cannot be read, so the answer is 'unknown' unless another of its
// pull_request rules confirms it.
function rulesetRequiresApproval(fullRuleset: Record<string, unknown>): boolean | 'unknown' {
  const rules = fullRuleset['rules'];
  if (!Array.isArray(rules)) {
    return false;
  }
  let unknown = false;
  for (const rule of rules) {
    if (!isRecord(rule) || rule['type'] !== 'pull_request') {
      continue;
    }
    const state = approvalCountState(isRecord(rule['parameters']) ? rule['parameters']['required_approving_review_count'] : undefined);
    if (state === true) {
      return true;
    }
    if (state === 'unknown') {
      unknown = true;
    }
  }
  return unknown ? 'unknown' : false;
}

// Whether a ruleset's pull_request rule dismisses stale approvals on push. A pull_request rule
// that does not carry the field as a boolean cannot be read, so the answer is 'unknown' unless
// another of its pull_request rules confirms it.
function rulesetDismissesStaleReviews(fullRuleset: Record<string, unknown>): boolean | 'unknown' {
  const rules = fullRuleset['rules'];
  if (!Array.isArray(rules)) {
    return false;
  }
  let unknown = false;
  for (const rule of rules) {
    if (!isRecord(rule) || rule['type'] !== 'pull_request') {
      continue;
    }
    const dismiss = isRecord(rule['parameters']) ? rule['parameters']['dismiss_stale_reviews_on_push'] : undefined;
    if (dismiss === true) {
      return true;
    }
    if (typeof dismiss !== 'boolean') {
      unknown = true;
    }
  }
  return unknown ? 'unknown' : false;
}

function rulesetNamesRequiredCheck(fullRuleset: Record<string, unknown>): boolean {
  const rules = fullRuleset['rules'];
  if (!Array.isArray(rules)) {
    return false;
  }
  for (const rule of rules) {
    if (!isRecord(rule) || rule['type'] !== 'required_status_checks') {
      continue;
    }
    const params = rule['parameters'];
    if (!isRecord(params)) {
      continue;
    }
    const checks = params['required_status_checks'];
    if (!Array.isArray(checks)) {
      continue;
    }
    for (const entry of checks) {
      if (isRecord(entry) && entry['context'] === REQUIRED_CHECK) {
        return true;
      }
    }
  }
  return false;
}

// Coverage of the protected branch by an active branch ruleset that requires the check: 'covers',
// 'ambiguous', or 'no'. A ruleset that is not active, not branch-scoped, or does not name the check
// is 'no'.
export function rulesetCheckCoverage(fullRuleset: unknown, defaultIsMain: DefaultIsMain = null): Coverage {
  return rulesetCoverage(fullRuleset, rulesetNamesRequiredCheck, defaultIsMain);
}

// A requirement read off one ruleset: set, not set, or present but unreadable.
type RulesetRequirement = (ruleset: Record<string, unknown>) => boolean | 'unknown';

function rulesetCoverage(fullRuleset: unknown, requires: RulesetRequirement, defaultIsMain: DefaultIsMain): Coverage {
  if (!isRecord(fullRuleset)) {
    return 'no';
  }
  if (fullRuleset['enforcement'] !== 'active' || fullRuleset['target'] !== 'branch') {
    return 'no';
  }
  const required = requires(fullRuleset);
  if (required === false) {
    return 'no';
  }
  const coverage = conditionCoverage(fullRuleset['conditions'], defaultIsMain);
  // A setting usabl cannot read, on a ruleset that might protect main, is never a confident answer.
  return required === 'unknown' && coverage !== 'no' ? 'ambiguous' : coverage;
}

// The result of reading rulesets: a named ruleset that confidently requires the check, 'ambiguous'
// when one might but usabl cannot confirm the branch targeting, null when none does, or 'unreadable'
// when a response could not be read (so it is never taken as a confident absence).
// Every ruleset summary across all pages, or 'unreadable' when any page could not be read or the
// list did not terminate in a short page within the cap (so a later page cannot be silently missed).
async function listAllRulesets(gh: GhReader): Promise<unknown[] | 'unreadable'> {
  const all: unknown[] = [];
  for (let page = 1; page <= RULESETS_PAGE_CAP; page += 1) {
    let res: GhResult | null;
    try {
      res = await gh.getJson(rulesetsPageEndpoint(page));
    } catch {
      return 'unreadable';
    }
    if (res === null || res.code !== 0) {
      return 'unreadable';
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      return 'unreadable';
    }
    if (!Array.isArray(parsed)) {
      return 'unreadable';
    }
    all.push(...parsed);
    if (parsed.length < RULESETS_PAGE_SIZE) {
      return all;
    }
  }
  return 'unreadable';
}

type RulesetOutcome = { name: string } | 'ambiguous' | null | 'unreadable';

// The active branch rulesets, and whether main is the default branch for any that target
// ~DEFAULT_BRANCH.
interface ActiveRulesets {
  rulesets: Array<Record<string, unknown>>;
  defaultIsMain: DefaultIsMain;
}

function targetsDefaultBranch(ruleset: Record<string, unknown>): boolean {
  const conditions = ruleset['conditions'];
  const refName = isRecord(conditions) ? conditions['ref_name'] : undefined;
  if (!isRecord(refName)) {
    return false;
  }
  return [refName['include'], refName['exclude']].some(
    (list) => Array.isArray(list) && list.includes('~DEFAULT_BRANCH'),
  );
}

// Whether main is the repository's default branch, or null when the repository could not be read.
// null keeps a ~DEFAULT_BRANCH target unknown, so a failed read never confirms or rules out main.
async function readDefaultIsMain(gh: GhReader): Promise<DefaultIsMain> {
  let res: GhResult | null;
  try {
    res = await gh.getJson(REPOSITORY_ENDPOINT);
  } catch {
    return null;
  }
  if (res === null || res.code !== 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(res.stdout);
    const name = isRecord(parsed) ? parsed['default_branch'] : undefined;
    return typeof name === 'string' && name.length > 0 ? name === PROTECTED_BRANCH : null;
  } catch {
    return null;
  }
}

async function readActiveRulesets(gh: GhReader): Promise<ActiveRulesets | 'unreadable'> {
  const rulesets = await readActiveRulesetBodies(gh);
  if (rulesets === 'unreadable') {
    return 'unreadable';
  }
  // The repository is read only when a ruleset needs it, so a repository without such a ruleset
  // costs no extra call.
  const defaultIsMain = rulesets.some(targetsDefaultBranch) ? await readDefaultIsMain(gh) : null;
  return { rulesets, defaultIsMain };
}

// Every active branch ruleset's detail body, or 'unreadable' when any read fails.
async function readActiveRulesetBodies(gh: GhReader): Promise<Array<Record<string, unknown>> | 'unreadable'> {
  const list = await listAllRulesets(gh);
  if (list === 'unreadable') {
    return 'unreadable';
  }
  const rulesets: Array<Record<string, unknown>> = [];
  for (const summary of list) {
    if (!isRecord(summary) || summary['enforcement'] !== 'active' || summary['target'] !== 'branch') {
      continue;
    }
    const id = summary['id'];
    if (typeof id !== 'number') {
      continue;
    }
    let fullRes: GhResult | null;
    try {
      fullRes = await gh.getJson(rulesetEndpoint(id));
    } catch {
      return 'unreadable';
    }
    if (fullRes === null || fullRes.code !== 0) {
      return 'unreadable';
    }
    let full: unknown;
    try {
      full = JSON.parse(fullRes.stdout);
    } catch {
      return 'unreadable';
    }
    // A malformed detail body must not read as a valid ruleset that happens not to protect main.
    if (!isRulesetShape(full)) {
      return 'unreadable';
    }
    rulesets.push(full);
  }
  return rulesets;
}

function findRulesetRequiring(active: ActiveRulesets | 'unreadable', requires: RulesetRequirement): RulesetOutcome {
  if (active === 'unreadable') {
    return 'unreadable';
  }
  let sawAmbiguous = false;
  for (const full of active.rulesets) {
    const coverage = rulesetCoverage(full, requires, active.defaultIsMain);
    if (coverage === 'covers') {
      const name = typeof full['name'] === 'string' ? full['name'] : 'a ruleset';
      return { name };
    }
    if (coverage === 'ambiguous') {
      sawAmbiguous = true;
    }
  }
  return sawAmbiguous ? 'ambiguous' : null;
}

// One half of the protection, as read: where it was confirmed, or why it was not.
type RequirementState = { present: string } | 'absent' | 'ambiguous' | 'unreadable';

function requirementState(classic: ClassicState, ruleset: RulesetOutcome): RequirementState {
  if (classic === 'present') {
    return { present: 'classic branch protection' };
  }
  if (ruleset !== null && typeof ruleset === 'object') {
    return { present: `ruleset "${ruleset.name}"` };
  }
  if (classic === 'unreadable' || ruleset === 'unreadable') {
    return 'unreadable';
  }
  return ruleset === 'ambiguous' ? 'ambiguous' : 'absent';
}

export async function verifyBranchRule(gh: GhReader): Promise<BranchRuleResult> {
  const setting = branchRuleSetting();
  const checkLabel = `${REQUIRED_CHECK} as a required status check`;
  const reviewLabel = 'review from code owners';
  const approvalLabel = 'at least one approving review';
  const staleLabel = 'dismissal of stale approvals on push';

  // Classic protection first, so a classic-protected repo still verifies in one read-only GET.
  const classic = await readClassicProtection(gh);
  const parts: Array<{ label: string; classic: ClassicState; ruleset: RulesetRequirement }> = [
    { label: checkLabel, classic: classicState(classic, isRequiredCheckPresent), ruleset: rulesetNamesRequiredCheck },
    { label: reviewLabel, classic: classicState(classic, isCodeOwnerReviewRequired), ruleset: rulesetRequiresCodeOwnerReview },
    { label: approvalLabel, classic: classicState(classic, isApprovalRequired), ruleset: rulesetRequiresApproval },
    { label: staleLabel, classic: classicState(classic, isStaleReviewDismissed), ruleset: rulesetDismissesStaleReviews },
  ];

  // Rulesets are read only when classic protection did not confirm every part, since a ruleset
  // can set any of them instead.
  const rulesets: ActiveRulesets | 'unreadable' = parts.every((part) => part.classic === 'present')
    ? { rulesets: [], defaultIsMain: null }
    : await readActiveRulesets(gh);
  const states = parts.map((part) => ({
    label: part.label,
    state: requirementState(part.classic, part.classic === 'present' ? null : findRulesetRequiring(rulesets, part.ruleset)),
  }));

  const confirmed = states.flatMap((entry) => (typeof entry.state === 'object' ? [entry.state.present] : []));
  if (confirmed.length === states.length) {
    const where = [...new Set(confirmed)].join(' and ');
    return {
      exitCode: 0,
      action: 'verified',
      message: `verified: ${PROTECTED_BRANCH} requires ${checkLabel}, ${reviewLabel}, ${approvalLabel}, and ${staleLabel} (${where}).`,
    };
  }

  // A part that is confidently absent is reported as not applied, because the operator has a step
  // to take whatever the other parts read. Otherwise, a part that could not be read, or a ruleset
  // whose branch targeting usabl cannot evaluate, is refused rather than called missing.
  const missing = states.flatMap((entry) => (entry.state === 'absent' ? [entry.label] : []));
  if (missing.length > 0) {
    return {
      exitCode: 2,
      action: 'not-applied',
      message: `not applied: ${PROTECTED_BRANCH} does not require ${missing.join(' or ')}, by classic branch protection or by an active ruleset.\n${setting}`,
    };
  }
  const reason =
    states.some((entry) => entry.state === 'ambiguous')
      ? `a ruleset sets part of the protection but usabl cannot confirm it targets ${PROTECTED_BRANCH}`
      : `could not read classic protection and rulesets for ${PROTECTED_BRANCH}`;
  return {
    exitCode: 2,
    action: 'cannot-verify',
    message: `cannot verify: ${reason}.\n${setting}\n${verifyByHand()}`,
  };
}

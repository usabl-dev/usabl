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
import { REQUIRED_GATE_JOB, USABL_DOCS_GATE_WORKFLOW_PATH, USABL_GATE_WORKFLOW_PATH } from './ci.js';
import { isSafeBranchName, workflowTriggerBranch } from './repo-git.js';
import { branchLinesText, DOCS_GATE_BRANCHED, GATE_BRANCHED, type BranchedWorkflow } from './workflow-branch.js';

// The gate triggers on pull requests into the branch its workflow file names, so that is the
// branch to protect. main is the branch usabl checks when no gate workflow names one, and it
// says so. The check to require is the aggregate job, taken from the workflow generator rather
// than restated here, so the name an operator is told to require and the job that decides the
// merge can never drift apart. Requiring usabl-policy alone is not enough: it returns success
// whenever no guarded path diverged, so an accessibility regression satisfies it.
export const PROTECTED_BRANCH = 'main';
export const REQUIRED_CHECK = REQUIRED_GATE_JOB;

/**
 * The branch the check reads. source is gate when the gate workflow on disk names it, docs-gate when
 * there is no gate workflow and the docs gate workflow names it, and assumed when usabl checks main
 * because it could not read one. An assumed target carries the reason, whether a gate file is there
 * at all, and the step that would let usabl read the branch.
 */
export type BranchTarget =
  | { name: string; source: 'gate' | 'docs-gate' }
  | { name: string; source: 'assumed'; reason: string; gatePresent: boolean; step: string };

// The step when there is no gate workflow: install writes one for the default branch git names.
const INSTALL_CI_STEP = 'Run "usabl install --ci" to write the gate for your default branch, then run "usabl install --branch-rule" again.';
// The step when a gate file is there but usabl cannot read one branch from its trigger. command is the
// install command that writes that file.
function triggerFormStep(command: string): string {
  return `usabl reads only a pull_request trigger that names one branch, quoted, the way usabl writes it. Check the protection on each branch your gate runs on by hand, or run "${command}" to see how the gate differs from the draft.`;
}

// Each gate workflow that can name the branch: the app gate first, then the docs gate, which a
// documentation repository may have alone. Both require the same usabl-required check.
interface GateFile {
  source: 'gate' | 'docs-gate';
  path: string;
  command: string;
  workflow: BranchedWorkflow;
  // The other usabl workflows that name the branch, for the step that says to change it.
  others: string;
}
const GATE_FILES: readonly GateFile[] = [
  { source: 'gate', path: USABL_GATE_WORKFLOW_PATH, command: 'usabl install --ci', workflow: GATE_BRANCHED, others: 'the docs gate and history workflows if you have them' },
  { source: 'docs-gate', path: USABL_DOCS_GATE_WORKFLOW_PATH, command: 'usabl install --docs-ci', workflow: DOCS_GATE_BRANCHED, others: 'the history workflow if you have it' },
];
function gateFile(source: 'gate' | 'docs-gate'): GateFile {
  return GATE_FILES.find((file) => file.source === source) ?? GATE_FILES[0]!;
}

const ASSUMED_MAIN: BranchTarget = {
  name: PROTECTED_BRANCH,
  source: 'assumed',
  reason: 'no gate workflow was read',
  gatePresent: false,
  step: INSTALL_CI_STEP,
};

// A branch git itself would allow, read one segment at a time, so the name can never form a "."
// or ".." path segment or an empty one in the api path it goes into.
function isPathSafeBranch(name: string): boolean {
  return name.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

// Why a file system read failed, in words, or null when the error is not a file system error. A
// programmer error has no string code and is not absorbed here.
function unreadableReason(error: unknown): string | null {
  const code = error instanceof Error ? Reflect.get(error, 'code') : undefined;
  if (typeof code !== 'string') return null;
  if (code === 'EISDIR') return 'it is a folder';
  if (code === 'EACCES' || code === 'EPERM') return 'usabl has no permission to read it';
  return /^E[A-Z]+$/.test(code) ? `the read failed with ${code}` : 'the read failed';
}

/**
 * The branch the gate workflow on disk runs on, read from its pull request trigger in the one form
 * usabl writes. The app gate decides when it is there. With no app gate, the docs gate decides. With
 * neither, or a trigger in another form, it is main, assumed.
 */
export async function gateBranchTarget(readFile: (path: string) => Promise<string | null>): Promise<BranchTarget> {
  for (const file of GATE_FILES) {
    let raw: string | null;
    try {
      raw = await readFile(file.path);
    } catch (error) {
      // Something is at the path, but usabl cannot read it, so the branch is unknown. That is never
      // a missing gate, and never a reason to move on to the next file.
      const why = unreadableReason(error);
      if (why === null) throw error;
      return {
        name: PROTECTED_BRANCH,
        source: 'assumed',
        reason: `${file.path} could not be read (${why})`,
        gatePresent: true,
        step: `Make ${file.path} a file usabl can read, then run "usabl install --branch-rule" again.`,
      };
    }
    if (raw === null) continue;
    const name = workflowTriggerBranch(raw, 'pull_request');
    if (name === null || !isPathSafeBranch(name)) {
      return {
        name: PROTECTED_BRANCH,
        source: 'assumed',
        reason: `the trigger in ${file.path} does not name one branch in the form usabl writes`,
        gatePresent: true,
        step: triggerFormStep(file.command),
      };
    }
    return { name, source: file.source };
  }
  return { name: PROTECTED_BRANCH, source: 'assumed', reason: `${USABL_GATE_WORKFLOW_PATH} is missing`, gatePresent: false, step: INSTALL_CI_STEP };
}

// The read-only gh call. {owner}/{repo} are resolved by gh from the current repo context,
// so no repository slug is interpolated from any external input. The branch is one encoded path
// segment, so a branch with a slash still names one branch.
function protectionEndpoint(branch: string): string {
  return `repos/{owner}/{repo}/branches/${encodeURIComponent(branch)}/protection`;
}
// The repository itself, read for its default branch: for a ruleset that targets ~DEFAULT_BRANCH,
// and to say when the gate runs on another branch.
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
  // What the check says about which branch it read, with the next step, as one paragraph: main was
  // assumed, or GitHub reports another default branch. When the first line of the message already
  // says it, this is the next step alone. null when the gate names the branch and GitHub agrees or
  // cannot say. doctor shows it.
  branchNote: string | null;
  // GitHub's default branch when it is another branch than the one checked, else null. A verified
  // check then still leaves pull requests into the default branch without a gate.
  otherDefault: string | null;
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

export function branchRuleSetting(branch: string = PROTECTED_BRANCH, assumed = false, workflowPath: string = USABL_GATE_WORKFLOW_PATH): string {
  return [
    `Apply this branch protection on the "${branch}" branch${assumed ? ', which usabl assumed' : ''}:`,
    '  - Require status checks to pass before merging.',
    `  - Required status check context: ${REQUIRED_CHECK} (the aggregate job in ${workflowPath}).`,
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

// Whether a single ref target names the branch being checked. "covers" only for targets this code
// can evaluate exactly: ~ALL, refs/heads/<branch>, and ~DEFAULT_BRANCH when the repository says
// that branch is its default branch. "unknown" for anything usabl cannot evaluate without
// replicating GitHub's fnmatch, and for ~DEFAULT_BRANCH when the default branch could not be read.
// "no" for another literal branch, and for ~DEFAULT_BRANCH when another branch is the default.
// Unknowns never become a confident answer.
type TargetMatch = 'covers' | 'no' | 'unknown';
// The branch being checked, and whether it is the repository's default branch: true, false, or
// null when the default branch was not read.
interface CheckedBranch {
  name: string;
  isDefault: boolean | null;
}
function refTargetMatchesProtected(token: string, branch: CheckedBranch): TargetMatch {
  if (token === '~ALL' || token === `refs/heads/${branch.name}`) {
    return 'covers';
  }
  if (token === '~DEFAULT_BRANCH') {
    return branch.isDefault === null ? 'unknown' : branch.isDefault ? 'covers' : 'no';
  }
  if (/[*?[\]]/.test(token)) {
    return 'unknown';
  }
  return 'no';
}

function verifyByHand(branch: string, assumed = false): string {
  return [
    `Verify by hand (read-only)${assumed ? `, on ${branch}, which usabl assumed` : ''}:`,
    `  gh api ${protectionEndpoint(branch)} --jq '.required_status_checks'`,
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
async function readClassicProtection(gh: GhReader, branch: string): Promise<{ body: unknown } | 'absent' | 'unreadable'> {
  let outcome: GhResult | null;
  try {
    outcome = await gh.getJson(protectionEndpoint(branch));
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

// How a ruleset's branch conditions relate to the branch being checked. "covers" and "no" are
// confident; "ambiguous" means usabl cannot tell (a glob or ~DEFAULT_BRANCH in the include, or any
// target in the exclude it cannot evaluate), so it must not be read as either protecting or not
// protecting the branch.
type Coverage = 'covers' | 'no' | 'ambiguous';
// A string array, or absent. A present value that is not a clean string array is malformed, and
// silently dropping a non-string entry (an exclusion, say) could turn a real exclude of the branch into a
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
function conditionCoverage(conditions: unknown, branch: CheckedBranch): Coverage {
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
  const include = includeList.map((token) => refTargetMatchesProtected(token, branch));
  const exclude = excludeList.map((token) => refTargetMatchesProtected(token, branch));

  // Exclusions first. A confident exclusion of the branch means this ruleset does not protect it.
  // An exclusion usabl cannot evaluate might exclude it, so the whole ruleset is ambiguous.
  if (exclude.includes('covers')) {
    return 'no';
  }
  if (exclude.includes('unknown')) {
    return 'ambiguous';
  }
  // No exclusion touches the branch. Now the include list decides.
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

// Coverage of the checked branch by an active branch ruleset that requires the check: 'covers',
// 'ambiguous', or 'no'. A ruleset that is not active, not branch-scoped, or does not name the check
// is 'no'. defaultIsBranch says whether the checked branch is the repository's default branch, or
// null when that was not read.
export function rulesetCheckCoverage(fullRuleset: unknown, defaultIsBranch: boolean | null = null, branch: string = PROTECTED_BRANCH): Coverage {
  return rulesetCoverage(fullRuleset, rulesetNamesRequiredCheck, { name: branch, isDefault: defaultIsBranch });
}

// A requirement read off one ruleset: set, not set, or present but unreadable.
type RulesetRequirement = (ruleset: Record<string, unknown>) => boolean | 'unknown';

function rulesetCoverage(fullRuleset: unknown, requires: RulesetRequirement, branch: CheckedBranch): Coverage {
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
  const coverage = conditionCoverage(fullRuleset['conditions'], branch);
  // A setting usabl cannot read, on a ruleset that might protect the branch, is never a confident answer.
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

// The active branch rulesets, and the branch they are read against.
interface ActiveRulesets {
  rulesets: Array<Record<string, unknown>>;
  branch: CheckedBranch;
}

// The repository's default branch, or null when the repository could not be read. null keeps a
// ~DEFAULT_BRANCH target unknown, so a failed read never confirms or rules out the branch. A name
// that is not a plain branch name is treated the same way: it is text from outside, and it reaches
// the printed report, so usabl neither trusts it nor prints it.
async function readDefaultBranch(gh: GhReader): Promise<string | null> {
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
    return typeof name === 'string' && isSafeBranchName(name) && isPathSafeBranch(name) ? name : null;
  } catch {
    return null;
  }
}

async function readActiveRulesets(gh: GhReader, branch: CheckedBranch): Promise<ActiveRulesets | 'unreadable'> {
  const rulesets = await readActiveRulesetBodies(gh);
  if (rulesets === 'unreadable') {
    return 'unreadable';
  }
  return { rulesets, branch };
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
    // A malformed detail body must not read as a valid ruleset that happens not to protect the branch.
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
    const coverage = rulesetCoverage(full, requires, active.branch);
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

// The lines that say which branch was checked and why, when that is not plain: main was assumed, or
// GitHub's default branch is another branch than the one the gate runs on. An assumed target never
// gets here with another default branch: that case is its own result.
function branchFacts(target: BranchTarget, defaultBranch: string | null): string[] {
  if (target.source === 'assumed') {
    const why = `usabl assumed ${target.name} because it could not read the branch your gate runs on: ${target.reason}.`;
    if (defaultBranch === null) {
      return [
        `${why} It could not read the default branch from GitHub either, so ${target.name} is not confirmed and this result is not verified.`,
        target.step,
      ];
    }
    const present = target.gatePresent
      ? ` A gate workflow is present, so usabl cannot confirm the gate runs on ${target.name} (assumed), and this result is not verified.`
      : '';
    return [`${why} GitHub reports ${target.name} as the default branch.${present}`, target.step];
  }
  if (defaultBranch !== null && defaultBranch !== target.name) {
    const file = gateFile(target.source);
    return [
      `GitHub reports ${defaultBranch} as the default branch, but the gate runs on pull requests into ${target.name}, so it covers only pull requests into ${target.name}.`,
      `To gate pull requests into ${defaultBranch}, put ${defaultBranch} in place of ${target.name} on ${branchLinesText(file.workflow, target.name)} of ${file.path}, and the same in ${file.others}. Then run "usabl install --branch-rule" to check the protection on ${defaultBranch}.`,
    ];
  }
  return [];
}

// Whether the branch checked is known to be the one that matters: a gate names it, or there is no
// gate file and GitHub reports it as the default branch. A branch usabl only assumed is never enough
// for a verified result.
function isBranchConfirmed(target: BranchTarget, defaultBranch: string | null): boolean {
  return target.source !== 'assumed' || (!target.gatePresent && defaultBranch === target.name);
}

/**
 * Check the protection on the branch the gate runs on. target is that branch, from gateBranchTarget;
 * without one, usabl checks main and says that it assumed it. An assumed main is verified only when
 * there is no gate file and GitHub reports main as the default branch. When GitHub reports another
 * default branch, the result names both and is not verified.
 */
export async function verifyBranchRule(gh: GhReader, target: BranchTarget = ASSUMED_MAIN): Promise<BranchRuleResult> {
  const name = target.name;
  const assumed = target.source === 'assumed';
  // How each headline names the branch, so a branch usabl only assumed never reads as fact.
  const label = assumed ? `${name} (assumed)` : name;
  const setting = branchRuleSetting(name, assumed, target.source === 'docs-gate' ? USABL_DOCS_GATE_WORKFLOW_PATH : USABL_GATE_WORKFLOW_PATH);
  const checkLabel = `${REQUIRED_CHECK} as a required status check`;
  const reviewLabel = 'review from code owners';
  const approvalLabel = 'at least one approving review';
  const staleLabel = 'dismissal of stale approvals on push';

  // Classic protection first, so a classic-protected repo still verifies in one protection read.
  const classic = await readClassicProtection(gh, name);
  // The default branch decides ~DEFAULT_BRANCH, and the report says when it is another branch.
  const defaultBranch = await readDefaultBranch(gh);
  const otherDefault = defaultBranch !== null && defaultBranch !== name ? defaultBranch : null;
  if (target.source === 'assumed' && otherDefault !== null) {
    // usabl guessed main, and GitHub says the default branch is another one. The protection that
    // matters is on that branch, which usabl did not check, so nothing here is verified.
    const lines = [
      `cannot verify: GitHub reports ${otherDefault} as the default branch, but usabl assumed ${name} because it could not read the branch your gate runs on: ${target.reason}. usabl did not check the protection on ${otherDefault}, so this result is not verified.`,
      target.step,
    ];
    return { exitCode: 2, action: 'cannot-verify', message: lines.join('\n'), branchNote: target.step, otherDefault };
  }
  const branch: CheckedBranch = { name, isDefault: defaultBranch === null ? null : defaultBranch === name };
  const facts = branchFacts(target, defaultBranch);
  const outcome = (exitCode: 0 | 2, action: BranchRuleResult['action'], first: string, rest: string[]): BranchRuleResult => ({
    exitCode,
    action,
    message: [first, ...facts, ...rest].join('\n'),
    branchNote: facts.length > 0 ? facts.join(' ') : null,
    otherDefault,
  });
  const parts: Array<{ label: string; classic: ClassicState; ruleset: RulesetRequirement }> = [
    { label: checkLabel, classic: classicState(classic, isRequiredCheckPresent), ruleset: rulesetNamesRequiredCheck },
    { label: reviewLabel, classic: classicState(classic, isCodeOwnerReviewRequired), ruleset: rulesetRequiresCodeOwnerReview },
    { label: approvalLabel, classic: classicState(classic, isApprovalRequired), ruleset: rulesetRequiresApproval },
    { label: staleLabel, classic: classicState(classic, isStaleReviewDismissed), ruleset: rulesetDismissesStaleReviews },
  ];

  // Rulesets are read only when classic protection did not confirm every part, since a ruleset
  // can set any of them instead.
  const rulesets: ActiveRulesets | 'unreadable' = parts.every((part) => part.classic === 'present')
    ? { rulesets: [], branch }
    : await readActiveRulesets(gh, branch);
  const states = parts.map((part) => ({
    label: part.label,
    state: requirementState(part.classic, part.classic === 'present' ? null : findRulesetRequiring(rulesets, part.ruleset)),
  }));

  const confirmed = states.flatMap((entry) => (typeof entry.state === 'object' ? [entry.state.present] : []));
  if (confirmed.length === states.length) {
    const where = [...new Set(confirmed)].join(' and ');
    const requires = `${label} requires ${checkLabel}, ${reviewLabel}, ${approvalLabel}, and ${staleLabel} (${where})`;
    if (!isBranchConfirmed(target, defaultBranch)) {
      return outcome(2, 'cannot-verify', `cannot verify: ${requires}, but usabl could not confirm that ${name} is the branch your gate runs on.`, []);
    }
    return outcome(0, 'verified', `verified: ${requires}.`, []);
  }

  // A part that is confidently absent is reported as not applied, because the operator has a step
  // to take whatever the other parts read. Otherwise, a part that could not be read, or a ruleset
  // whose branch targeting usabl cannot evaluate, is refused rather than called missing.
  const missing = states.flatMap((entry) => (entry.state === 'absent' ? [entry.label] : []));
  if (missing.length > 0) {
    return outcome(2, 'not-applied', `not applied: ${label} does not require ${missing.join(' or ')}, by classic branch protection or by an active ruleset.`, [setting]);
  }
  const reason =
    states.some((entry) => entry.state === 'ambiguous')
      ? `a ruleset sets part of the protection but usabl cannot confirm it targets ${label}`
      : `could not read classic protection and rulesets for ${label}`;
  return outcome(2, 'cannot-verify', `cannot verify: ${reason}.`, [setting, verifyByHand(name, assumed)]);
}

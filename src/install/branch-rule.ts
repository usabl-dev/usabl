/**
 * Branch protection generator for `usabl install --branch-rule`.
 * This generator is read-only. It NEVER mutates a repository setting. It prints the exact
 * protection the operator must apply and verifies the current state with a single
 * read-only gh call. It only reports "verified" when it can positively confirm that the
 * required check is present; otherwise it refuses and prints the setting, because claiming
 * verified without proof would be a false green.
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
    '  - Require review from Code Owners, so guarded-file changes need an owner approval that usabl-policy enforces.',
    '',
    'The resulting protection state, with exact values:',
    `  required_status_checks: { strict: true, contexts: ["${REQUIRED_CHECK}"] }`,
    '  required_pull_request_reviews: { require_code_owner_reviews: true }',
    '  enforce_admins: true',
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

// Whether a single ref target names the protected branch. "covers" only for literals this code can
// evaluate exactly (~ALL, or refs/heads/main). "unknown" for anything usabl cannot evaluate without
// replicating GitHub's fnmatch and default-branch resolution: a glob, or ~DEFAULT_BRANCH (main may
// not be the default). "no" for another literal branch. Unknowns never become a confident answer.
type TargetMatch = 'covers' | 'no' | 'unknown';
function refTargetMatchesProtected(token: string): TargetMatch {
  if (token === '~ALL' || token === `refs/heads/${PROTECTED_BRANCH}`) {
    return 'covers';
  }
  if (token === '~DEFAULT_BRANCH' || /[*?[\]]/.test(token)) {
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

// The classic branch-protection answer for the required check: confirmed present, confidently
// absent, or unreadable (gh missing, a non-"branch not protected" error, or unparseable JSON).
type ClassicState = 'present' | 'absent' | 'unreadable';

async function readClassicProtection(gh: GhReader): Promise<ClassicState> {
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
    return isRequiredCheckPresent(JSON.parse(outcome.stdout)) ? 'present' : 'absent';
  } catch {
    return 'unreadable';
  }
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
function conditionCoverage(conditions: unknown): Coverage {
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
  const include = includeList.map(refTargetMatchesProtected);
  const exclude = excludeList.map(refTargetMatchesProtected);

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
export function rulesetCheckCoverage(fullRuleset: unknown): Coverage {
  if (!isRecord(fullRuleset)) {
    return 'no';
  }
  if (fullRuleset['enforcement'] !== 'active' || fullRuleset['target'] !== 'branch') {
    return 'no';
  }
  if (!rulesetNamesRequiredCheck(fullRuleset)) {
    return 'no';
  }
  return conditionCoverage(fullRuleset['conditions']);
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
async function findRulesetRequiringCheck(gh: GhReader): Promise<RulesetOutcome> {
  const list = await listAllRulesets(gh);
  if (list === 'unreadable') {
    return 'unreadable';
  }
  let sawAmbiguous = false;
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
    const coverage = rulesetCheckCoverage(full);
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

export async function verifyBranchRule(gh: GhReader): Promise<BranchRuleResult> {
  const setting = branchRuleSetting();

  // Classic protection first, so a classic-protected repo still verifies in one read-only GET.
  const classic = await readClassicProtection(gh);
  if (classic === 'present') {
    return {
      exitCode: 0,
      action: 'verified',
      message: `verified: ${REQUIRED_CHECK} is a required status check on ${PROTECTED_BRANCH} (classic branch protection).`,
    };
  }

  // Classic did not confirm it, so check rulesets: a ruleset can require the same check.
  const ruleset = await findRulesetRequiringCheck(gh);
  if (ruleset !== null && ruleset !== 'unreadable' && ruleset !== 'ambiguous') {
    return {
      exitCode: 0,
      action: 'verified',
      message: `verified: ${REQUIRED_CHECK} is a required status check on ${PROTECTED_BRANCH} (ruleset "${ruleset.name}").`,
    };
  }

  // Neither mechanism confirmed the check. Only call it not-applied when both are confident: a
  // classic absence and a rulesets list that named no rule requiring it. If either could not be
  // read, or a ruleset might require it on branch targeting usabl cannot evaluate, refuse rather
  // than claim the protection is missing.
  if (classic === 'unreadable' || ruleset === 'unreadable' || ruleset === 'ambiguous') {
    const reason =
      ruleset === 'ambiguous'
        ? `a ruleset requires ${REQUIRED_CHECK} but usabl cannot confirm it targets ${PROTECTED_BRANCH}`
        : `could not read classic protection and rulesets for ${PROTECTED_BRANCH}`;
    return {
      exitCode: 2,
      action: 'cannot-verify',
      message: `cannot verify: ${reason}.\n${setting}\n${verifyByHand()}`,
    };
  }
  return {
    exitCode: 2,
    action: 'not-applied',
    message: `not applied: ${REQUIRED_CHECK} is required by neither classic branch protection nor an active ruleset on ${PROTECTED_BRANCH}.\n${setting}`,
  };
}

/**
 * `usabl doctor`: a read-only self-check that projects what is wired, missing, drifted, or
 * unknown across the usabl integration surfaces.
 * This unit is read-only and mints NO verdict. It never writes a file, never calls the gate,
 * and never reads a Result. It reuses the install family's recognition predicates in plan
 * (read-only) mode instead of re-deriving weaker checks, because a re-implemented recognizer
 * could fail toward success. Recognition never fails toward success here: a surface it cannot
 * positively confirm reports missing, drifted, or unknown, never "wired". unknown is a
 * first-class state for "cannot positively confirm" and is never collapsed into wired.
 * runDoctor always exits 0 when it renders a report, because a missing surface is information,
 * not a doctor failure, and doctor must never become a second verdict authority.
 */
import type { InstallFs } from '../install/index.js';
import { planOverlay } from '../install/overlay.js';
import { planClaude } from '../install/claude.js';
import { planClaudeSkill } from '../install/claude-skill.js';
import { planCursor, readCursorUiFileGlobs } from '../install/cursor.js';
import { classifyGateWorkflow, USABL_GATE_WORKFLOW_PATH } from '../install/ci.js';
import { verifyBranchRule, REQUIRED_CHECK, type GhReader } from '../install/branch-rule.js';
import { parseConfiguredManifest } from '../coverage/route-manifest.js';
import { parseUsablConfig } from '../intake/config.js';
import { parseEvidenceFloor } from '../evidence/floor.js';
import { EVIDENCE_FLOOR_PATH } from '../baseline/index.js';
import { parseWaiverLedger } from '../run.js';
import { readStorageStateEnv, STORAGE_STATE_ENV_VAR, type EnvReader } from '../deps/session.js';
import { neutralize } from '../primitives/neutralize.js';
import { buildGuardedSet } from '../trust/guard.js';
import type { PlaywrightBootstrapProbe } from './playwright-bootstrap.js';

// The code-owners file the policy gate reads. Doctor reconciles it against guardedPaths so the
// two lists cannot drift silently (issue #151).
const CODEOWNERS_PATH = '.github/CODEOWNERS';

// The waiver ledger path the gate reads. There is no shared constant for it today (run.ts,
// guard.ts, and init all use the literal), so doctor names it locally rather than invent a
// weaker presence-only waiver check.
const WAIVERS_PATH = '.usabl-waivers.json';

// Surface labels are named once and reused by both the collector and the read-failure guard,
// so an unreadable surface reports the same label as a readable one and the two never drift.
const CONFIG_LABEL = 'usabl config';
// The label names the variable, never its value. The value is a path the operator chose and
// the file it names holds live session cookies, so neither belongs in a printed report.
const SESSION_LABEL = `authenticated session (${STORAGE_STATE_ENV_VAR})`;
const ROUTES_LABEL = 'route manifest (usabl.routes.json)';
const EVIDENCE_FLOOR_LABEL = `evidence floor (${EVIDENCE_FLOOR_PATH})`;
const WAIVERS_LABEL = `waiver ledger (${WAIVERS_PATH})`;
const OVERLAY_LABEL = 'vite overlay plugin';
const STOP_HOOK_LABEL = 'claude stop hook (.claude/settings.json)';
const CLAUDE_SKILL_LABEL = 'claude usabl-check skill (.claude/skills/usabl-check/SKILL.md)';
const CURSOR_LABEL = 'cursor stop hook + assistant (.cursor/hooks + commands + rules)';
const CI_LABEL = 'ci gate workflow (.github/workflows/usabl-gate.yml)';
// The label names the check the operator must require. It reads that name from branch-rule
// rather than spelling it out, so doctor can never tell someone to require a stale job name.
const BRANCH_RULE_LABEL = `branch protection (main requires ${REQUIRED_CHECK})`;
const PLAYWRIGHT_CHROMIUM_LABEL = 'playwright chromium (headless browser)';
const POLICY_SCOPE_LABEL = 'policy scope (guardedPaths covers CODEOWNERS)';

// Four states, and unknown is first class. wired is a positive confirmation. missing is a
// confident absence. drifted is present-but-not-what-usabl-expects. unknown is "cannot
// positively confirm", and it is never mapped from anything but a genuine cannot-confirm
// signal. A recognizer that is unsure lands here, never on wired.
export type SurfaceState = 'wired' | 'missing' | 'drifted' | 'unknown';

export interface SurfaceReport {
  id: string;
  label: string;
  state: SurfaceState;
  // The one honest next step for this surface. Empty when wired (no action). May embed a
  // file-derived value such as the operator-supplied config path, so formatDoctorReport
  // neutralizes it at print time.
  nextStep: string;
}

export interface DoctorDeps {
  // Read-only by contract: the install plan functions only call readFile and glob. Pass an
  // InstallFs whose writeFile throws so a doctor path that ever tried to write fails loudly.
  fs: InstallFs;
  gh: GhReader;
  // The config path to inspect. Defaults to usabl.config.json at the call site, or whatever
  // the operator passed via --config.
  configPath: string;
  // The process environment, injected for the same reason fs and gh are: a collector that
  // reached for process.env directly would be a surface no test could set up honestly.
  env: EnvReader;
  // Probes the Playwright Chromium install that "usabl check" uses for browser scans. Injected
  // in tests so doctor never reaches the real environment.
  probePlaywrightChromium: () => Promise<PlaywrightBootstrapProbe>;
}

function isFsReadError(error: unknown): boolean {
  // A Node file-system failure (EACCES, EIO, EISDIR, and the like) is an Error carrying a
  // string `code`. That is a genuine "usabl could not read this surface" signal, which doctor
  // maps to unknown. A programmer error (a TypeError, or a thrown non-Error) has no such code,
  // so it is NOT swallowed here: it propagates to the cli catch-all as exit 4, where a real
  // bug belongs. Hiding it behind unknown would fail toward success.
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string';
}

async function guardRead(
  id: string,
  label: string,
  collect: () => Promise<SurfaceReport>,
): Promise<SurfaceReport> {
  // Wrap each collector so an unexpected file-system read error becomes an honest unknown
  // rather than crashing the whole report to exit 4. Only fs errors are absorbed; a
  // programmer error re-throws so it is never masked as a surface state.
  try {
    return await collect();
  } catch (error) {
    if (!isFsReadError(error)) {
      throw error;
    }
    // Recognition never fails toward success: an unreadable surface cannot be confirmed, so it
    // is unknown, never wired. It is also not "missing", because a permission error is not a
    // confident absence.
    return {
      id,
      label,
      state: 'unknown',
      nextStep: `usabl could not read ${label}; check file permissions.`,
    };
  }
}

async function collectConfig(deps: DoctorDeps): Promise<SurfaceReport> {
  // Read the bytes directly. loadConfig throws on a missing file, which would crash doctor,
  // so doctor reads with the null-on-missing fs and parses in a try/catch of its own. A real
  // fs read error (not a missing file) propagates to guardRead, which maps it to unknown.
  const raw = await deps.fs.readFile(deps.configPath);
  if (raw === null) {
    return {
      id: 'config',
      label: CONFIG_LABEL,
      state: 'missing',
      nextStep: `No usabl config. Run "usabl init" to create ${deps.configPath}.`,
    };
  }
  try {
    parseUsablConfig(raw);
  } catch {
    return {
      id: 'config',
      label: CONFIG_LABEL,
      state: 'drifted',
      nextStep: `${deps.configPath} is present but does not parse as a usabl config. Fix the JSON, or re-run "usabl init".`,
    };
  }
  return { id: 'config', label: CONFIG_LABEL, state: 'wired', nextStep: '' };
}

async function collectSession(deps: DoctorDeps): Promise<SurfaceReport> {
  // Without a session usabl scans signed out, which is how a login-gated application was
  // measured as three blank pages and still received a verdict. So the missing state carries
  // the consequence, not just the variable name. Nothing here prints the path or the file:
  // the path can name a private location and the file holds live session tokens, so doctor
  // reports whether a session is set, never what it is.
  const path = readStorageStateEnv(deps.env);
  if (path === null) {
    return {
      id: 'session',
      label: SESSION_LABEL,
      state: 'missing',
      nextStep: `No ${STORAGE_STATE_ENV_VAR}. usabl will scan signed out, so a login-gated screen is measured as whatever a signed-out visitor sees, often a blank or redirected page that still mints a verdict. Export ${STORAGE_STATE_ENV_VAR} with the path to a Playwright storage state JSON file to scan signed in.`,
    };
  }
  // A real read error (EACCES and the like) propagates to guardRead as unknown. This fs port
  // returns null for a missing file, which is the confident "the path names nothing" signal.
  const raw = await deps.fs.readFile(path);
  if (raw === null) {
    return {
      id: 'session',
      label: SESSION_LABEL,
      state: 'drifted',
      nextStep: `${STORAGE_STATE_ENV_VAR} is set but no file exists at the path it names (the path is not printed here). Re-export the session file, or unset ${STORAGE_STATE_ENV_VAR} to scan signed out on purpose.`,
    };
  }
  try {
    JSON.parse(raw);
  } catch {
    return {
      id: 'session',
      label: SESSION_LABEL,
      state: 'drifted',
      nextStep: `${STORAGE_STATE_ENV_VAR} names a file that is not JSON, so it is not a Playwright storage state. Re-export the session file, or unset ${STORAGE_STATE_ENV_VAR} to scan signed out on purpose.`,
    };
  }
  return {
    id: 'session',
    label: SESSION_LABEL,
    state: 'wired',
    // Present and parsing is all doctor can confirm. Whether the session is still accepted by
    // the application is a live question no read of the file can answer, and an expired
    // session scans signed out, so the wired state says so instead of implying more.
    nextStep: `Set, readable, and parses. usabl cannot tell whether the session is still valid; an expired session scans signed out.`,
  };
}

async function collectRoutes(deps: DoctorDeps): Promise<SurfaceReport> {
  // Doctor reports the manifest's own presence and parse health only. Deep routes-vs-app
  // drift is "usabl drift routes"' job and carries an unparseable-router hazard doctor must
  // not duplicate, so even a wired manifest points the operator at the deeper check.
  let manifest;
  try {
    manifest = await parseConfiguredManifest(deps.fs);
  } catch (error) {
    // Separate a genuine fs read failure from a parse failure. An unreadable manifest cannot
    // be confirmed, so it re-throws to guardRead (unknown); only a real parse failure is the
    // honest "present but does not parse" drift.
    if (isFsReadError(error)) {
      throw error;
    }
    return {
      id: 'routes',
      label: ROUTES_LABEL,
      state: 'drifted',
      nextStep: 'usabl.routes.json is present but does not parse. Fix the JSON so route coverage can be planned.',
    };
  }
  if (manifest === null) {
    return {
      id: 'routes',
      label: ROUTES_LABEL,
      state: 'missing',
      nextStep: 'No usabl.routes.json. Run "usabl init" to create the route manifest.',
    };
  }
  return {
    id: 'routes',
    label: ROUTES_LABEL,
    state: 'wired',
    nextStep: 'Present and parses. For the deeper check, run "usabl drift routes" to compare it against the app router.',
  };
}

async function collectEvidenceFloor(deps: DoctorDeps): Promise<SurfaceReport> {
  const raw = await deps.fs.readFile(EVIDENCE_FLOOR_PATH);
  if (raw === null) {
    return {
      id: 'evidence-floor',
      label: EVIDENCE_FLOOR_LABEL,
      state: 'missing',
      nextStep: `No evidence floor. Run "usabl baseline" to record current debt so only new barriers gate.`,
    };
  }
  try {
    parseEvidenceFloor(JSON.parse(raw));
  } catch {
    return {
      id: 'evidence-floor',
      label: EVIDENCE_FLOOR_LABEL,
      state: 'drifted',
      nextStep: `${EVIDENCE_FLOOR_PATH} is present but does not parse as an evidence floor. Fix it, or re-run "usabl baseline".`,
    };
  }
  return { id: 'evidence-floor', label: EVIDENCE_FLOOR_LABEL, state: 'wired', nextStep: '' };
}

async function collectWaivers(deps: DoctorDeps): Promise<SurfaceReport> {
  const raw = await deps.fs.readFile(WAIVERS_PATH);
  if (raw === null) {
    return {
      id: 'waivers',
      label: WAIVERS_LABEL,
      state: 'missing',
      nextStep: `No waiver ledger. Add ${WAIVERS_PATH} only if you need to time-box an accepted barrier.`,
    };
  }
  try {
    parseWaiverLedger(JSON.parse(raw));
  } catch {
    return {
      id: 'waivers',
      label: WAIVERS_LABEL,
      state: 'drifted',
      nextStep: `${WAIVERS_PATH} is present but does not parse as a waiver ledger. Fix it before the gate runs.`,
    };
  }
  return { id: 'waivers', label: WAIVERS_LABEL, state: 'wired', nextStep: '' };
}

async function collectOverlay(deps: DoctorDeps): Promise<SurfaceReport> {
  // already-wired is the only wired mapping. A config present but not wired is drifted, and
  // no config at all is missing. This drives off the same string-aware recognizer install
  // uses, so a commented-out or quoted mention never reads as wired.
  const plan = await planOverlay(deps.fs);
  if (plan.action === 'already-wired') {
    return { id: 'overlay', label: OVERLAY_LABEL, state: 'wired', nextStep: '' };
  }
  if (plan.action === 'refuse') {
    return {
      id: 'overlay',
      label: OVERLAY_LABEL,
      state: 'drifted',
      nextStep: `${plan.path} is present but does not wire the overlay. Run "usabl install --overlay" for the exact two lines, or add them by hand.`,
    };
  }
  return {
    id: 'overlay',
    label: OVERLAY_LABEL,
    state: 'missing',
    nextStep: 'No Vite config wires the overlay. Run "usabl install --overlay" to write a draft.',
  };
}

async function collectStopHook(deps: DoctorDeps): Promise<SurfaceReport> {
  // planClaude answers "write, update, no-op, or refuse?"; doctor needs the finer question of
  // WHY an update is needed, which the plan's reason discriminator now carries.
  //   already-wired -> wired (the stable command is in place).
  //   update + add-missing -> missing: the file exists but has no usabl Stop hook at all, so
  //     the surface is absent, not merely drifted.
  //   update + normalize -> drifted: a usabl Stop hook is present but is not the stable
  //     command (a bare or retired form), so it needs normalizing. No claim about which form.
  //   write -> missing: the file itself is absent.
  //   refuse -> unknown: an unparseable, foreign, or ambiguous Stop hook usabl cannot
  //     recognize. Doctor cannot positively confirm, so unknown, never wired.
  const plan = await planClaude(deps.fs);
  if (plan.action === 'already-wired') {
    return { id: 'stop-hook', label: STOP_HOOK_LABEL, state: 'wired', nextStep: '' };
  }
  if (plan.action === 'update') {
    if (plan.reason === 'add-missing') {
      return {
        id: 'stop-hook',
        label: STOP_HOOK_LABEL,
        state: 'missing',
        nextStep: '.claude/settings.json exists but has no usabl Stop hook. Run "usabl install --claude" to add it.',
      };
    }
    return {
      id: 'stop-hook',
      label: STOP_HOOK_LABEL,
      state: 'drifted',
      nextStep:
        'A usabl Stop hook is present but is not the canonical "npx usabl stop-hook" command. Run "usabl install --claude" to normalize it.',
    };
  }
  if (plan.action === 'write') {
    return {
      id: 'stop-hook',
      label: STOP_HOOK_LABEL,
      state: 'missing',
      nextStep: 'No .claude/settings.json. Run "usabl install --claude" to wire the usabl Stop hook.',
    };
  }
  return {
    id: 'stop-hook',
    label: STOP_HOOK_LABEL,
    state: 'unknown',
    nextStep:
      'usabl cannot confirm the Stop hook: the file has a Stop hook usabl does not recognize or cannot parse. Reconcile it by hand; see "usabl install --claude".',
  };
}

async function collectClaudeSkill(deps: DoctorDeps): Promise<SurfaceReport> {
  // The /usabl-check skill is a whole-file surface, so it drives off planClaudeSkill's plan the
  // way overlay does, not planClaude's finer discriminator. already-wired is the only wired
  // mapping. write means the file is absent, a confident absence. refuse means a file is present
  // but differs from the canonical skill (an operator edit or an older engine version), which is
  // drift, never a false wired.
  const plan = await planClaudeSkill(deps.fs);
  if (plan.action === 'already-wired') {
    return { id: 'claude-skill', label: CLAUDE_SKILL_LABEL, state: 'wired', nextStep: '' };
  }
  if (plan.action === 'refuse') {
    return {
      id: 'claude-skill',
      label: CLAUDE_SKILL_LABEL,
      state: 'drifted',
      nextStep: `${plan.path} is present but is not the canonical usabl-check skill. Reconcile it by hand, or delete it and run "usabl install --claude-skill".`,
    };
  }
  return {
    id: 'claude-skill',
    label: CLAUDE_SKILL_LABEL,
    state: 'missing',
    nextStep: 'No usabl-check skill. Run "usabl install --claude-skill" to write the on-demand /usabl-check command.',
  };
}

async function collectCursor(deps: DoctorDeps): Promise<SurfaceReport> {
  const uiFileGlobs = await readCursorUiFileGlobs(deps.fs, deps.configPath);
  const plan = await planCursor(deps.fs, uiFileGlobs);
  if (plan.action === 'already-wired') {
    return { id: 'cursor', label: CURSOR_LABEL, state: 'wired', nextStep: '' };
  }
  if (plan.action === 'refuse') {
    return {
      id: 'cursor',
      label: CURSOR_LABEL,
      state: 'drifted',
      nextStep: `${plan.path} is present but is not the canonical usabl Cursor wiring. Reconcile it by hand, or delete it and run "usabl install --cursor".`,
    };
  }
  return {
    id: 'cursor',
    label: CURSOR_LABEL,
    state: 'missing',
    nextStep: 'No Cursor wiring. Run "usabl install --cursor" to write the stop hook, /usabl-check command, and UI rule.',
  };
}

async function collectCi(deps: DoctorDeps): Promise<SurfaceReport> {
  // doctor asks a finer question than planCi: is the gate workflow present, structurally
  // correct, AND pinned to a trusted engine commit? classifyGateWorkflow answers that from the
  // same draft constant install uses.
  //   missing -> missing: a confident absence.
  //   wired -> wired: requires both engine-ref lines to carry the same real 40-character
  //     commit SHA. The draft's sentinel does not qualify.
  //   unpinned -> drifted: the workflow is otherwise correct but still ships the sentinel, so
  //     it is not yet enforceable. Present but not wired is drift, with a pin next step.
  //   drifted -> drifted: any structural difference from the draft.
  const raw = await deps.fs.readFile(USABL_GATE_WORKFLOW_PATH);
  const state = classifyGateWorkflow(raw);
  if (state === 'wired') {
    return { id: 'ci', label: CI_LABEL, state: 'wired', nextStep: '' };
  }
  if (state === 'missing') {
    return {
      id: 'ci',
      label: CI_LABEL,
      state: 'missing',
      nextStep: 'No usabl gate workflow. Run "usabl install --ci" to write the draft.',
    };
  }
  if (state === 'unpinned') {
    return {
      id: 'ci',
      label: CI_LABEL,
      state: 'drifted',
      nextStep:
        'The gate workflow is present but the engine ref is still the placeholder. Run "usabl install --ci" and replace PIN_TO_A_TRUSTED_USABL_COMMIT (it appears twice) with a full 40-character commit SHA you trust.',
    };
  }
  return {
    id: 'ci',
    label: CI_LABEL,
    state: 'drifted',
    nextStep: 'A gate workflow is present but differs from the usabl draft. Run "usabl install --ci" to see where, and reconcile by hand.',
  };
}

async function collectPlaywrightChromium(deps: DoctorDeps): Promise<SurfaceReport> {
  const state = await deps.probePlaywrightChromium();
  if (state === 'wired') {
    return { id: 'playwright-chromium', label: PLAYWRIGHT_CHROMIUM_LABEL, state: 'wired', nextStep: '' };
  }
  if (state === 'missing') {
    return {
      id: 'playwright-chromium',
      label: PLAYWRIGHT_CHROMIUM_LABEL,
      state: 'missing',
      nextStep:
        'Chromium is not installed for Playwright. Run "npx playwright install chromium" from your app root. On Linux, if launch still fails, run "npx playwright install --with-deps chromium". Until Chromium is installed, "usabl check" returns not_covered for every screen.',
    };
  }
  return {
    id: 'playwright-chromium',
    label: PLAYWRIGHT_CHROMIUM_LABEL,
    state: 'unknown',
    nextStep:
      'usabl could not confirm whether Playwright Chromium is installed. Run "npx playwright install chromium" and try again.',
  };
}

async function collectBranchRule(deps: DoctorDeps): Promise<SurfaceReport> {
  // verified is the only wired mapping. not-applied is a confident absence (missing).
  // cannot-verify (gh missing, ambiguous 404, unreadable response) is unknown, because
  // doctor cannot positively confirm the setting and must not guess it is present or absent.
  const result = await verifyBranchRule(deps.gh);
  if (result.action === 'verified') {
    return { id: 'branch-rule', label: BRANCH_RULE_LABEL, state: 'wired', nextStep: '' };
  }
  if (result.action === 'not-applied') {
    return {
      id: 'branch-rule',
      label: BRANCH_RULE_LABEL,
      state: 'missing',
      nextStep: `The main branch does not require the ${REQUIRED_CHECK} check, so an accessibility regression can still merge. Run "usabl install --branch-rule" for the exact setting.`,
    };
  }
  return {
    id: 'branch-rule',
    label: BRANCH_RULE_LABEL,
    state: 'unknown',
    nextStep: 'usabl cannot confirm branch protection (gh unavailable, or the read was inconclusive). Verify by hand; see "usabl install --branch-rule".',
  };
}

// A guarded prefix, leading and trailing slashes stripped, so a directory entry and a file entry
// compare the same way.
function normalizePolicyPath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '');
}

// The path pattern from each CODEOWNERS rule line: the first whitespace token, comments and blank
// lines skipped. Glob patterns (which CODEOWNERS allows but usabl's gate refuses) are left out
// because they cannot be reconciled against a plain guarded prefix; only literal paths are checked.
function codeownersOwnedPaths(raw: string): string[] {
  const paths: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }
    const token = trimmed.split(/\s+/)[0];
    if (token === undefined || /[*?[\]]/.test(token)) {
      continue;
    }
    paths.push(normalizePolicyPath(token));
  }
  return paths;
}

// A CODEOWNERS path is covered when the guarded set contains it or an ancestor directory of it, so
// any change under the owned path is one usabl also treats as a policy change.
function isPolicyPathCovered(codeownersPath: string, guardedSet: string[]): boolean {
  return guardedSet.some((guarded) => {
    const g = normalizePolicyPath(guarded);
    return codeownersPath === g || codeownersPath.startsWith(`${g}/`);
  });
}

// Reconcile guardedPaths against CODEOWNERS. If CODEOWNERS gates a path that guardedPaths (plus the
// always-guarded ledgers) does not, a change to that path reads as "no policy change" while GitHub
// still requires an owner: the #140 pattern, where silence reads as green. Report it as drift so the
// disagreement is loud, not something the next reviewer finds by luck.
async function collectPolicyScope(deps: DoctorDeps): Promise<SurfaceReport> {
  const codeownersRaw = await deps.fs.readFile(CODEOWNERS_PATH);
  if (codeownersRaw === null) {
    return {
      id: 'policy-scope',
      label: POLICY_SCOPE_LABEL,
      state: 'missing',
      nextStep: `No ${CODEOWNERS_PATH}, so usabl cannot confirm which changes GitHub gates. Add code owners for the trust-critical paths, then list them in guardedPaths.`,
    };
  }
  let guardedPaths: string[] = [];
  const configRaw = await deps.fs.readFile(deps.configPath);
  if (configRaw !== null) {
    try {
      const parsed: unknown = JSON.parse(configRaw);
      const raw = (parsed as { guardedPaths?: unknown }).guardedPaths;
      if (Array.isArray(raw)) {
        guardedPaths = raw.filter((entry): entry is string => typeof entry === 'string');
      }
    } catch {
      // A config that does not parse is already reported by collectConfig; treat guardedPaths as
      // empty here so the always-guarded ledgers still reconcile.
    }
  }
  const guardedSet = buildGuardedSet({ guardedPaths });
  const uncovered = [...new Set(codeownersOwnedPaths(codeownersRaw))].filter(
    (path) => !isPolicyPathCovered(path, guardedSet),
  );
  if (uncovered.length > 0) {
    return {
      id: 'policy-scope',
      label: POLICY_SCOPE_LABEL,
      state: 'drifted',
      nextStep: `CODEOWNERS gates ${uncovered.join(', ')}, but guardedPaths does not, so a change there reads as "no policy change" while GitHub still requires an owner. Add ${uncovered.join(', ')} to guardedPaths in ${deps.configPath}.`,
    };
  }
  return { id: 'policy-scope', label: POLICY_SCOPE_LABEL, state: 'wired', nextStep: '' };
}

export async function collectDoctorReport(deps: DoctorDeps): Promise<SurfaceReport[]> {
  // Order mirrors the slice: config, authenticated session, playwright chromium, routes,
  // evidence floor, waivers, overlay, stop hook, usabl-check skill, cursor assistant, ci
  // workflow, branch rule. The session sits second because it decides what every later scan
  // actually measures. Each
  // collector is self-contained health logic with no printing,
  // so tests can target the states directly. guardRead absorbs an unexpected fs read error as
  // an honest unknown; every recognized state (including drifted and unknown) is returned, and
  // only a real programmer error propagates.
  return [
    await guardRead('config', CONFIG_LABEL, () => collectConfig(deps)),
    await guardRead('session', SESSION_LABEL, () => collectSession(deps)),
    await guardRead('playwright-chromium', PLAYWRIGHT_CHROMIUM_LABEL, () => collectPlaywrightChromium(deps)),
    await guardRead('routes', ROUTES_LABEL, () => collectRoutes(deps)),
    await guardRead('evidence-floor', EVIDENCE_FLOOR_LABEL, () => collectEvidenceFloor(deps)),
    await guardRead('waivers', WAIVERS_LABEL, () => collectWaivers(deps)),
    await guardRead('overlay', OVERLAY_LABEL, () => collectOverlay(deps)),
    await guardRead('stop-hook', STOP_HOOK_LABEL, () => collectStopHook(deps)),
    await guardRead('claude-skill', CLAUDE_SKILL_LABEL, () => collectClaudeSkill(deps)),
    await guardRead('cursor', CURSOR_LABEL, () => collectCursor(deps)),
    await guardRead('ci', CI_LABEL, () => collectCi(deps)),
    await guardRead('branch-rule', BRANCH_RULE_LABEL, () => collectBranchRule(deps)),
    await guardRead('policy-scope', POLICY_SCOPE_LABEL, () => collectPolicyScope(deps)),
  ];
}

export function formatDoctorReport(reports: SurfaceReport[]): string {
  const counts: Record<SurfaceState, number> = { wired: 0, missing: 0, drifted: 0, unknown: 0 };
  for (const report of reports) {
    counts[report.state] += 1;
  }
  const lines: string[] = [
    `usabl doctor: ${counts.wired} wired, ${counts.missing} missing, ${counts.drifted} drifted, ${counts.unknown} unknown`,
    'doctor is a projection: it reports what is wired and mints no verdict. The gate is the only verdict.',
    '',
  ];
  for (const report of reports) {
    // Both the label and the next step can embed a file-derived value (for example a
    // surface path or the --config path), so neutralize both at this egress. Nothing
    // file-derived reaches the terminal with control bytes intact.
    lines.push(`  [${report.state}] ${neutralize(report.label)}`);
    const step = report.nextStep.length > 0 ? neutralize(report.nextStep) : 'no action';
    lines.push(`      ${step}`);
  }
  lines.push('');
  return lines.join('\n');
}

export async function runDoctor(deps: DoctorDeps): Promise<{ exitCode: 0; stdout: string }> {
  // Always exit 0 when a report renders. Surface state is information, not a doctor verdict,
  // so the count of missing, drifted, or unknown surfaces never changes the exit code. A
  // genuine internal error throws and falls through to the cli-bin catch-all (exit 4).
  const reports = await collectDoctorReport(deps);
  return { exitCode: 0, stdout: formatDoctorReport(reports) };
}

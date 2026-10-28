/**
 * Playwright assertion helper that reads, but never alters, a gated Result.
 * This unit gives tests a convenient verdict check surface.
 * It must never mint a new verdict or reinterpret gate ownership.
 */
import { resolve } from 'node:path';
import type { Page as PwPage } from 'playwright';
import type {
  AccessibilityVerdict,
  Capability,
  CoverageGap,
  Draft,
  Page,
  ProfileName,
  Provider,
  ReadinessOutcome,
  RequirementBundle,
  Result,
  ScreenScan,
  UsablConfig,
} from '../contracts/index.js';
import { decideAccessibilityVerdict } from '../coverage/completeness.js';
import { markUnseenScreens } from '../coverage/unseen.js';
import { parseRouteManifest } from '../coverage/route-manifest.js';
import { makeFsGlob } from '../deps/fs.js';
import { adoptPage } from '../deps/real.js';
import { parseUsablConfig } from '../intake/config.js';
import { loadRequirements } from '../intake/load.js';
import { makeScanProviders } from '../providers/core-stack.js';
import { runProviders } from '../providers/index.js';
import {
  heldThroughout,
  measureReachability,
  measureReadiness,
  readinessSignalOf,
  selectorHeldBeforeWalk,
  signalTimeoutMsFor,
  signalWait,
  type ReadinessMeasurement,
  type ReadinessSignal,
} from '../providers/reachability.js';
import { scrubResult, scrubString } from './scrub.js';

// A single-page check outcome for a live Playwright page. It calls the same precedence function
// as the gate, so the two can never rank a blocking failure and a coverage gap differently.
// Their verdicts can still differ, and that is expected: a page check has no floor and no
// waivers, so a barrier the gate has already accepted still reads as a regression here.
// This is not a gated Result. It reports what the providers observed on one page, nothing more.
export interface PageCheckResult {
  verdict: AccessibilityVerdict; // 'verified' | 'regression' | 'not_covered'
  failures: Draft[]; // confidence 'fail'; the deterministic misses that set a regression
  needsReview: Draft[]; // confidence 'unverified'; disclosed, never claimed clean, never blocking on their own
  gaps: CoverageGap[]; // providers that could not run on this page
  drafts: Draft[]; // every observation the providers emitted, in provider order
  summary: string;
  // Set by checkPage: where it looked for usabl.config.json and whether it found one. A missing
  // config at the default root adds no gap, because a project that does not use usabl config has
  // none, so this field is how a caller can tell "no requirements" from "read the wrong folder".
  project?: PageCheckProject;
}

export interface PageCheckProject {
  root: string; // the absolute directory checkPage read usabl.config.json from; never searched upward
  configFound: boolean;
}

/**
 * Decides a page-check verdict from raw provider output. Pure so the precedence is testable
 * without a browser. The ordering is not restated here: decideAccessibilityVerdict owns it, and
 * the gate calls the same function.
 *
 * What this unit does decide is what counts as blocking on a page, and it is broader than the
 * gate's rule. Any draft with `confidence === 'fail'` blocks, because there is no evidence floor
 * and no waiver list to check it against. usabl never upgrades unverified or a gap into verified.
 */
export function summarizePageCheck(drafts: Draft[], gaps: CoverageGap[]): PageCheckResult {
  const failures = drafts.filter((d) => d.confidence === 'fail');
  const needsReview = drafts.filter((d) => d.confidence === 'unverified');

  const { verdict } = decideAccessibilityVerdict({
    hasBlockingFailure: failures.length > 0,
    hasUnverified: needsReview.length > 0 || gaps.length > 0,
  });

  const summary = `${verdict}: ${failures.length} blocking, ${needsReview.length} needs review, ${gaps.length} gap(s)`;

  return { verdict, failures, needsReview, gaps, drafts, summary };
}

export interface CheckPageOptions {
  // The surface id this page is, as usabl.config.json or the route manifest names it. Design
  // requirements are matched to a page by this id, the same way the CLI matches them to a screen.
  // Left out, the page is unlabeled: findings are labeled 'page', but the page counts as no surface,
  // even in a project with a surface named page, so each design requirement is a gap until the
  // page is labeled.
  screenId?: string;
  profile?: ProfileName; // 'app' (default) or 'docs'; 'docs' switches axe to the WCAG 2.2 AA tag set
  keyboardWalk?: boolean; // run the Tab-order walk; defaults to true
  tabCap?: number; // max Tab presses in the keyboard walk
  // The directory that holds usabl.config.json, which is where the CLI reads it. The design
  // requirements it names are loaded from the working tree here, not from a trusted ref. Defaults
  // to the current working directory. Parent directories are never searched. A root passed here
  // with no usabl.config.json in it is a gap; the default root with none is not.
  projectRoot?: string;
}

// A page a caller hands us has no config file behind it, so the providers run against a neutral
// config. The current providers read ctx.profile, not these fields, so an empty-but-valid config is
// honest: it declares no surfaces and no origins because a page check does not discover them.
const PAGE_CHECK_CONFIG: UsablConfig = {
  appBaseUrl: '',
  uiFileGlobs: [],
  discovery: { routerFile: '', wideBlastGlobs: [] },
  surfaces: [],
  guardedPaths: [],
};

function pageCheckCapabilities(providers: Provider[]): Capability[] {
  // Grant exactly what the chosen providers ask for. The caller opted into these providers by
  // calling checkPage, so none of them should be denied and turned into a spurious coverage gap.
  return [...new Set(providers.flatMap((provider) => provider.capabilities))];
}

const NO_REQUIREMENTS: RequirementBundle = { version: 1, requirements: [] };

// What checkPage reads from the project before it runs: the requirement bundle the CLI would
// load, the surface ids the project names, where it looked, and any gap that stopped it.
export interface ProjectIntake {
  // Null means the requirements could not be read. Nothing was checked against them.
  requirements: RequirementBundle | null;
  knownSurfaceIds: ReadonlySet<string>;
  // The parsed usabl.config.json, or null when there is none or it could not be read. checkPage
  // reads a labeled screen's readiness signal and budgets from it.
  config: UsablConfig | null;
  project: PageCheckProject;
  gaps: CoverageGap[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the project the way the CLI does: usabl.config.json at the root, then the requirements
 * directory it names, through the same loader. It reads only `projectRoot` and never searches
 * parent directories, so the folder it reports is the folder it read.
 *
 * A missing usabl.config.json means different things by where the root came from. When the caller
 * named the root, a missing config means the caller pointed at the wrong folder, and loading no
 * requirements from it would quietly check none, so it is a gap that names the root. When the root
 * is the default working directory, a missing config is the normal case for a project that does
 * not use usabl config, so it adds no gap; the result's `project` field still says what was read.
 * A config or requirements directory that is present and cannot be read is always a gap.
 */
export async function loadProjectIntake(projectRoot: string, rootWasPassed: boolean): Promise<ProjectIntake> {
  const root = resolve(projectRoot);
  const fs = makeFsGlob({ cwd: root });
  let config: UsablConfig;
  try {
    const raw = await fs.readFile('usabl.config.json');
    if (raw === null) {
      const missing: ProjectIntake = {
        requirements: NO_REQUIREMENTS,
        knownSurfaceIds: new Set(),
        config: null,
        project: { root, configFound: false },
        gaps: [],
      };
      if (rootWasPassed) {
        missing.gaps.push({
          ref: 'usabl.config.json',
          state: 'not-covered',
          reason: scrubString(
            `projectRoot ${root} has no usabl.config.json, so no design requirements were read or checked. Pass the directory that holds usabl.config.json.`,
          ),
        });
      }
      return missing;
    }
    config = parseUsablConfig(raw);
  } catch (error: unknown) {
    return {
      requirements: null,
      knownSurfaceIds: new Set(),
      config: null,
      project: { root, configFound: true },
      gaps: [
        {
          ref: 'usabl.config.json',
          state: 'not-covered',
          reason: scrubString(
            `usabl.config.json could not be read, so its design requirements were not checked: ${errorMessage(error)}`,
          ),
        },
      ],
    };
  }

  const known = new Set(config.surfaces.map((surface) => surface.id));
  try {
    for (const route of (await parseRouteManifest(fs, config.discovery)).routes) {
      known.add(route.screenId);
    }
  } catch {
    // An unreadable route manifest names no extra surfaces. That can only turn a requirement into
    // a gap, never let one through unchecked.
  }

  const project: PageCheckProject = { root, configFound: true };
  const loaded = await loadRequirements(fs, config);
  if (!loaded.ok) {
    return {
      requirements: null,
      knownSurfaceIds: known,
      config,
      project,
      gaps: [
        {
          ref: 'requirements',
          state: 'not-covered',
          reason: `design requirements could not be loaded, so none were checked: ${loaded.reason}`,
        },
      ],
    };
  }
  return { requirements: loaded.bundle, knownSurfaceIds: known, config, project, gaps: [] };
}

/**
 * Which design requirements a single page check cannot account for. Pure so the rule is testable
 * without a browser or a project on disk. A null screenId is an unlabeled page.
 *
 * Each runtime requirement (content or flow) lands in one of three places:
 * - Its surface is this page's surface, so its provider checks it on this page.
 * - Its surface is a different surface the project names, and this page is a surface the project
 *   or a requirement names. It belongs to that other screen, so it is out of scope here.
 * - Anything else is a gap. Either this page is not labeled with a surface usabl can match, so any
 *   requirement might be about it, or the requirement names a surface that matches no configured
 *   or discovered surface, so it might be about this page under a misspelled id. Either way nothing
 *   checked it, and passing it would be a guess.
 *
 * Doc requirements are not runtime checks, so they never produce a gap here.
 */
export function requirementGapsForPage(
  requirements: RequirementBundle,
  screenId: string | null,
  knownSurfaceIds: ReadonlySet<string>,
): CoverageGap[] {
  const runtime = requirements.requirements.filter(
    (requirement) => requirement.assertion.type === 'content' || requirement.assertion.type === 'flow',
  );
  // Null is an unlabeled page. It is no surface, so it is never known and nothing is in scope.
  const pageIsKnown =
    screenId !== null &&
    (knownSurfaceIds.has(screenId) || runtime.some((requirement) => requirement.surface === screenId));

  const gaps: CoverageGap[] = [];
  for (const requirement of runtime) {
    if (screenId !== null && requirement.surface === screenId) {
      continue;
    }
    if (pageIsKnown && knownSurfaceIds.has(requirement.surface)) {
      continue;
    }
    const reason = pageIsKnown
      ? `requirement ${requirement.id} names surface ${requirement.surface}, which matches no configured or discovered surface, so it was not checked`
      : screenId === null
        ? `this page is not labeled with a surface, so requirement ${requirement.id} for surface ${requirement.surface} was not checked; pass the page's surface id as screenId`
        : `this page is labeled ${screenId}, which matches no surface, so requirement ${requirement.id} for surface ${requirement.surface} was not checked; pass the page's surface id as screenId`;
    gaps.push({ ref: `requirement:${requirement.id}`, state: 'not-covered', reason: scrubString(reason) });
  }
  return gaps;
}

/**
 * Runs the usabl accessibility engine against a live Playwright page and returns a verdict.
 *
 * This is the seam a Playwright suite uses: navigate and interact with the page in your test, then
 * hand the page to checkPage. It adopts the page (attaching a CDP session, the path helper, and the
 * live-region capture, without ever closing the page or its context), runs the same provider list
 * as `buildDeps` (axe, PatternFly rulepack, docs rulepack, keyboard walk, then one provider per
 * design requirement in the project), and summarizes the drafts with the same precedence as a full
 * usabl run. A design requirement this page cannot be matched to is a gap, so the helper cannot
 * return verified for a requirement it never checked.
 *
 * Three things a caller should know:
 * - It reads usabl.config.json and the design requirements from the working tree at `projectRoot`,
 *   not from a trusted ref. Anyone who can edit those files can change what it checks.
 * - It is not a merge gate. Its verdict is advisory test output. The gate that runs on a pull
 *   request is the only verdict authority.
 * - It acts on the caller's page. The keyboard walk presses Tab, the PatternFly probes open and
 *   close dialogs and menus, and each flow requirement on this surface runs its authored steps:
 *   clicks and key presses. Hand it a page you no longer need in its current state.
 */
export async function checkPage(pwPage: PwPage, options: CheckPageOptions = {}): Promise<PageCheckResult> {
  const profile: ProfileName = options.profile ?? 'app';
  // An unlabeled page is no surface, so no requirement is in scope and each one becomes a gap. Its
  // providers are not built either: the only one that could run is one for a surface literally
  // named page, and judging an unlabeled page against it would be a guess.
  const labeledScreenId = options.screenId ?? null;
  const screenId = labeledScreenId ?? 'page';
  const intake = await loadProjectIntake(
    options.projectRoot ?? process.cwd(),
    options.projectRoot !== undefined,
  );
  const scannedRequirements =
    labeledScreenId === null && intake.requirements !== null ? NO_REQUIREMENTS : intake.requirements;
  const providers: Provider[] = makeScanProviders(scannedRequirements, {
    ...(options.keyboardWalk === undefined ? {} : { keyboardWalk: options.keyboardWalk }),
    ...(options.tabCap === undefined ? {} : { tabCap: options.tabCap }),
  });

  const config = intake.config;
  const page = await adoptPage(pwPage, config?.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: config.readyTimeoutMs });
  const screen = { id: screenId, url: pwPage.url() };
  const requirementGaps =
    intake.requirements === null
      ? []
      : requirementGapsForPage(intake.requirements, labeledScreenId, intake.knownSurfaceIds);
  const finish = (drafts: Draft[], gaps: CoverageGap[]): PageCheckResult => ({
    ...summarizePageCheck(drafts, [...intake.gaps, ...requirementGaps, ...gaps]),
    project: intake.project,
  });

  // A labeled screen that declares a readiness signal in usabl.config.json is held to it, the way
  // the CLI holds it. Only a configured surface can declare one, as in the CLI.
  const reachedWhen =
    labeledScreenId === null || config === null
      ? undefined
      : config.surfaces.find((surface) => surface.id === labeledScreenId)?.reachedWhen;
  const signal = readinessSignalOf(reachedWhen);
  if (signal === null || config === null) {
    const { drafts, gaps } = await runProviders(
      providers,
      { page, screen, config: PAGE_CHECK_CONFIG, profile },
      pageCheckCapabilities(providers),
    );
    return finish(drafts, gaps);
  }

  const before = await readinessBeforeChecks(page, screenId, signal, config);
  if ('gap' in before) {
    // The screen is not known to be showing, so no provider runs on it.
    return finish([], [before.gap]);
  }
  await page.markWalkStart();
  const { drafts, gaps } = await runProviders(
    providers,
    { page, screen, config: PAGE_CHECK_CONFIG, profile },
    pageCheckCapabilities(providers),
  );
  // Measured again after the checks, as the CLI does. A part holds only if it held both times.
  const held = heldThroughout(before.measured, await measureReadiness(page, signal, config.appBaseUrl));
  const unseen = unseenGap(screenId, signal, held);
  return unseen === null ? finish(drafts, gaps) : finish([], [...gaps, unseen]);
}

// What checkPage adds to the CLI's response sentence. The response record of an adopted page starts
// at adoption, and a caller hands checkPage a page that has already loaded.
const ADOPTED_RESPONSE_NOTE =
  'checkPage records only the requests a page sends after it is called, so a response the page ' +
  'received while it loaded is not seen here. Check a screen that declares a response with the ' +
  'usabl CLI.';

/**
 * Waits for the declared signal and measures it once before any check runs, with the CLI's wait
 * and the CLI's rule. A signal that does not hold is a gap that names the part, worded by the same
 * unseen pass the CLI uses.
 */
async function readinessBeforeChecks(
  page: Page,
  screenId: string,
  signal: ReadinessSignal,
  config: UsablConfig,
): Promise<{ measured: ReadinessMeasurement } | { gap: CoverageGap }> {
  const signalWaitMs = signalTimeoutMsFor(config);
  const readyWhen = signalWait(
    signal,
    signalWaitMs,
    async () => (await measureReachability(page, signal.selector ?? undefined)) === true,
  );
  let readiness: ReadinessOutcome | undefined;
  try {
    readiness = await page.gotoReady(readyWhen);
  } catch (error: unknown) {
    return {
      gap: {
        ref: readinessRef(screenId),
        state: 'not-covered',
        reason: scrubString(
          `checkPage waited for this screen's declared readiness signal and the page did not settle, so it was not checked: ${errorMessage(error)}`,
        ),
      },
    };
  }
  const measured = await measureReadiness(page, signal, config.appBaseUrl);
  // The wait's outcome decides, as in the CLI, so a selector that appeared after the cap ran out
  // still reads as not held.
  const selectorHeld = readyWhen === undefined || selectorHeldBeforeWalk(readiness, measured.selectorPresent);
  const gap = selectorHeld
    ? unseenGap(screenId, signal, measured)
    : unseenGap(screenId, signal, { ...measured, selectorPresent: false }, signalWaitMs);
  return gap === null ? { measured } : { gap };
}

function readinessRef(screenId: string): string {
  return `readiness:${screenId}`;
}

/**
 * The CLI's unseen-screen gap for a readiness measurement, or null when every declared part held.
 * Built by markUnseenScreens itself, so the two surfaces word and decide it the same way.
 */
function unseenGap(
  screenId: string,
  signal: ReadinessSignal,
  measured: ReadinessMeasurement,
  signalWaitMs?: number,
): CoverageGap | null {
  const scan: ScreenScan = {
    screenId,
    url: readinessRef(screenId),
    stops: [],
    drafts: [],
    gaps: [],
    applicability: [],
    reachedSelectorPresent: measured.selectorPresent,
    reachedWhenSelector: signal.selector,
    ...(signalWaitMs === undefined ? {} : { signalWaitMs }),
    ...(signal.response === null
      ? {}
      : { reachedResponseSeen: measured.responseSeen, reachedWhenResponse: signal.response }),
  };
  const marked = markUnseenScreens([scan]).screens[0];
  const gap = marked?.gaps[0];
  if (gap === undefined) {
    return null;
  }
  const reason = measured.responseSeen === false ? `${gap.reason} ${ADOPTED_RESPONSE_NOTE}` : gap.reason;
  return { ref: gap.ref, state: 'not-covered', reason: scrubString(reason) };
}

export function assertUsablVerdict(
  result: Result,
  allowedVerdicts: Array<NonNullable<Result['verdict']>>,
): { passed: boolean; verdict: Result['verdict']; exitCode: number; summary: string; safeResult: Result } {
  const passed = result.verdict !== null && allowedVerdicts.includes(result.verdict);
  const safeResult = scrubResult(result);
  // Tests choose which verdicts are acceptable; this helper only reports what the gate already decided.
  const summary = passed
    ? `Allowed verdict: ${result.verdict}`
    : `Disallowed verdict: ${result.verdict === null ? 'IDLE' : result.verdict}`;
  return {
    passed,
    verdict: result.verdict,
    exitCode: result.exitCode,
    summary,
    safeResult,
  };
}

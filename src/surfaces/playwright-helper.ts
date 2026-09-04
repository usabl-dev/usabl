/**
 * Playwright assertion helper that reads, but never alters, a gated Result.
 * This unit gives tests a convenient verdict check surface.
 * It must never mint a new verdict or reinterpret gate ownership.
 */
import type { Page as PwPage } from 'playwright';
import type {
  AccessibilityVerdict,
  Capability,
  CoverageGap,
  Draft,
  ProfileName,
  Provider,
  Result,
  UsablConfig,
} from '../contracts/index.js';
import { decideAccessibilityVerdict } from '../coverage/completeness.js';
import { adoptPage } from '../deps/real.js';
import { makeCoreProviders } from '../providers/core-stack.js';
import { runProviders } from '../providers/index.js';
import { scrubResult } from './scrub.js';

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
  screenId?: string; // label for this surface in the drafts; defaults to 'page'
  profile?: ProfileName; // 'app' (default) or 'docs'; 'docs' switches axe to the WCAG 2.2 AA tag set
  keyboardWalk?: boolean; // run the Tab-order walk; defaults to true
  tabCap?: number; // max Tab presses in the keyboard walk
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

/**
 * Runs the usabl accessibility engine against a live Playwright page and returns a verdict.
 *
 * This is the seam a Playwright suite uses: navigate and interact with the page in your test, then
 * hand the page to checkPage. It adopts the page (attaching a CDP session and the path helper without
 * ever closing the page or its context), runs the same core provider stack as `buildDeps` (axe,
 * PatternFly rulepack, docs rulepack, keyboard walk), and summarizes the drafts with the same
 * precedence as a full usabl run.
 */
export async function checkPage(pwPage: PwPage, options: CheckPageOptions = {}): Promise<PageCheckResult> {
  const profile: ProfileName = options.profile ?? 'app';
  const providers: Provider[] = makeCoreProviders({
    ...(options.keyboardWalk === undefined ? {} : { keyboardWalk: options.keyboardWalk }),
    ...(options.tabCap === undefined ? {} : { tabCap: options.tabCap }),
  });

  const page = await adoptPage(pwPage);
  const { drafts, gaps } = await runProviders(
    providers,
    { page, screen: { id: options.screenId ?? 'page', url: pwPage.url() }, config: PAGE_CHECK_CONFIG, profile },
    pageCheckCapabilities(providers),
  );

  return summarizePageCheck(drafts, gaps);
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

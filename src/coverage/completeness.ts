/**
 * One definition of "this run did not examine everything it was asked to", and one definition of
 * how a coverage gap ranks against a new deterministic failure.
 *
 * Both answers used to be written out by hand wherever they were needed: the gate, the baseline
 * writer, the floor prune, the conformance projection, and the Playwright page helper. Separate
 * copies of the same rule drift, and nothing fails when they do. Every one of those callers now
 * reads the rule from here.
 *
 * This unit knows nothing about idle. A run with no UI-touching files has no verdict at all,
 * which is a different question, so it stays in the gate where the coverage graph is in hand.
 */
import type { AccessibilityExitCode, AccessibilityVerdict, Coverage } from '../contracts/index.js';

/**
 * The exit code each accessibility verdict carries. decideAccessibilityVerdict below reads it, so
 * the gate writes these codes, and the Result reader checks a document against the same table, so
 * a document that shows one outcome and exits with another is refused.
 */
export const ACCESSIBILITY_EXIT_CODES: Readonly<Record<AccessibilityVerdict, AccessibilityExitCode>> = {
  verified: 0,
  regression: 1,
  not_covered: 3,
};

/**
 * The exit code of an approval_required run. The gate decides that verdict and writes this code
 * itself. The golden Results tie the two together: each one is read back through the Result
 * reader, which checks the pair against this value.
 */
export const APPROVAL_REQUIRED_EXIT_CODE = 2;

/**
 * The exit codes of a run with no verdict: 0 when it had nothing to check, and 4 when it crashed
 * and failed open. A run with no accessibility verdict carries the same two.
 */
export const NO_VERDICT_EXIT_CODES: readonly AccessibilityExitCode[] = [0, 4];

/** The two parts of a Coverage that record what the run did not evaluate. */
type NotEvaluated = Pick<Coverage, 'unresolvedFiles' | 'gaps'>;

/**
 * How much the run was asked to check and could not: files it could not resolve to a screen, and
 * surfaces or checks it could not exercise. This is the not-evaluated denominator that reporting
 * surfaces print, so a clean finding count is never read as a full sweep.
 */
export function notEvaluatedCounts(coverage: NotEvaluated): { unresolvedFiles: number; gaps: number } {
  return { unresolvedFiles: coverage.unresolvedFiles.length, gaps: coverage.gaps.length };
}

/**
 * True when the run left something unexamined.
 *
 * Derived from notEvaluatedCounts rather than from the arrays again, so the boolean and the
 * counts cannot drift: incomplete is exactly "either count is above zero".
 */
export function coverageIncomplete(coverage: NotEvaluated): boolean {
  const counts = notEvaluatedCounts(coverage);
  return counts.unresolvedFiles > 0 || counts.gaps > 0;
}

/**
 * The accessibility verdict and its exit code, given two answers the caller has already worked
 * out: whether anything blocking was found, and whether anything was left unverified.
 *
 * A blocking failure outranks missing coverage. A real barrier is the actionable answer, and
 * answering not_covered first would bury it. Missing coverage in turn outranks clean, because
 * usabl never upgrades something it did not check into verified. `verified` is therefore the
 * answer to a narrow question: nothing blocking was found and nothing was left unexamined. It is
 * not a claim that the surface holds no barriers, because a run carrying an accepted evidence
 * floor is verified while barriers the floor recorded are still standing on the page.
 *
 * This function does not define what counts as blocking. That is the caller's decision and the
 * two callers do not make it the same way. The gate counts a finding as blocking only when it is
 * deterministic, new against the evidence floor, and neither waived nor fixed. The Playwright
 * page helper counts any draft with `confidence === 'fail'`, because a page handed to it has no
 * floor and no waivers to compare against.
 *
 * Idle is not decided here. Idle is the absence of a verdict, not a fourth one.
 */
export function decideAccessibilityVerdict(input: { hasBlockingFailure: boolean; hasUnverified: boolean }): {
  verdict: AccessibilityVerdict;
  exitCode: AccessibilityExitCode;
} {
  const verdict: AccessibilityVerdict = input.hasBlockingFailure
    ? 'regression'
    : input.hasUnverified
      ? 'not_covered'
      : 'verified';
  return { verdict, exitCode: ACCESSIBILITY_EXIT_CODES[verdict] };
}

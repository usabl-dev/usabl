/**
 * Stop-hook projection for local continuation decisions.
 * This unit maps an existing Result into block or allow messages only.
 * It must never mint verdicts or bypass gate ownership of verdict authority.
 */
import type { Result, UsablConfig } from '../contracts/index.js';
import { assembleBoundedMessage, boundField } from '../output/bounded-text.js';
import { isBlockingBarrier } from '../output/disclosure.js';
import { applyNoiseBudget, resolveNoiseBudgetDefault } from '../output/noise-budget.js';
import { blockingCauses, describeVerdict, formatVerdictWord } from '../output/verdict-line.js';
import {
  barrierLines,
  excludedFilePieces,
  guardedFileLines,
  leftOutLine,
  notEvaluatedPieces,
  notePieces,
  unconfirmedPieces,
  unrecognizedRunLine,
} from './model-pieces.js';
import { frameUntrustedBlock, scrubResult, scrubString } from './scrub.js';
import type { CheckCommand } from './stop-hook-scope.js';

export interface HookContext {
  stopHookActive: boolean;
  // False when the Stop hook did not compare session pins on this stop, for example because the
  // pin store refused. An allow that would otherwise read as a pass then says so on its first
  // line. Absent means the comparison ran or had nothing to compare yet.
  sessionDriftChecked?: boolean;
  // The guarded files the hook's own guard found diverged before the run. A run that crashed
  // carries none of its own, so the hook passes what it found. Absent means none.
  guardDivergedPaths?: string[];
  // The check the advice names. A stop with a starting commit names usabl check --branch-scope,
  // because only its receipt answers such a stop. Absent means usabl check. See checkCommandFor.
  checkCommand?: CheckCommand;
  // True when the stop compared guarded policy with the commit where the branch left the trusted
  // branch, as CI compares it with the base of the pull request. A guarded-file message then says
  // that a file committed on the branch still counts. Absent means the last commit was the
  // reference.
  policyFromStartingCommit?: boolean;
  // True when git records no trusted branch, so the stop compared policy with the last commit and
  // checked only the uncommitted changes. An allow line (VERIFIED, or idle) then says so inside its
  // parentheses, so a reader who skips the note that follows still sees it. Absent means a trusted
  // branch was found.
  noTrustedBranch?: boolean;
}

/**
 * What a guarded-file message adds when policy was compared with the starting commit. Without it,
 * a reader who committed the file would take "changed" to mean uncommitted, and commit again.
 */
export const POLICY_FROM_STARTING_COMMIT =
  'usabl compared guarded policy files with the commit where this branch left the trusted branch, as CI compares them with the base of the pull request. ' +
  'A guarded file committed on this branch still counts as changed, and CI will ask for a code owner approval for it. ' +
  'To clear this without approval, put the file back as it is at that commit.';

/** The guarded-file lines for a stop message, with the starting commit line when it applies. */
function stopGuardedFileLines(result: Result, ctx: HookContext): { scaffold: string[]; piece: string | null } {
  const guarded = guardedFileLines(result);
  return ctx.policyFromStartingCommit === true
    ? { scaffold: [...guarded.scaffold, POLICY_FROM_STARTING_COMMIT], piece: guarded.piece }
    : guarded;
}

// The note an allow line carries when the session drift comparison did not run.
const DRIFT_NOT_CHECKED = 'session drift not checked';

/**
 * What an allow line (VERIFIED, or idle) carries when no trusted branch was found. The note after
 * the decision names what was not checked and the next step.
 */
export const NO_TRUSTED_BRANCH_WARNING = 'no trusted branch found to compare policy with; see the note below';

// The notes an allow line carries in its parentheses, in order, or undefined when there are none.
function passNotes(sessionDriftChecked: boolean | undefined, noTrustedBranch: boolean | undefined): string | undefined {
  const notes = [
    ...(sessionDriftChecked === false ? [DRIFT_NOT_CHECKED] : []),
    ...(noTrustedBranch === true ? [NO_TRUSTED_BRANCH_WARNING] : []),
  ];
  return notes.length === 0 ? undefined : notes.join(', ');
}

export interface StopDecision {
  block: boolean;
  message: string;
}

/**
 * What the model should do next for each blocking verdict.
 *
 * The reader is a model that just tried to stop. It needs the verdict, the reason, and one
 * concrete next step, in that order, before any detail. A regression is fixed by the model.
 *
 * The coverage step tells the reader to resolve every reason listed under Not evaluated, and
 * then names the reasons a run produces most often. That list is not exhaustive and must not be
 * read as one: a gap is also recorded for a provider skipped after another provider changed the
 * page, for an evidence floor too old to prove anything, and for a configuration usabl could not
 * read, and more can be added. Naming the common ones is what keeps a model from stopping at
 * screens and files; the instruction to resolve every reason listed is what covers the rest.
 *
 * Guarded policy files are the one thing the model must not touch to clear a block, so that step
 * says so.
 *
 * A check usabl could not decide is not work the model can finish. A person has to review it, so
 * its step tells the model to raise it, and not to change code to make it pass or mark it
 * reviewed itself, for example with a waiver or a floor entry. When such checks are the only cause,
 * the step is that action alone and does not send the model to the Not evaluated list, which is
 * empty then.
 */
interface NextSteps {
  regression: string;
  notCovered: string;
  approvalOnly: string;
  approvalWithRegression: string;
  approvalWithGaps: string;
  // A regression outranks a gap, so a run with both is a regression. These name the gaps the way
  // the not covered step does, so a reader who fixes the barriers does not meet the gaps only on
  // the next stop.
  regressionWithGaps: string;
  approvalWithRegressionAndGaps: string;
  // The steps for a run that also holds checks usabl could not decide. The barrier step names
  // accessibility barriers only, because the undecided checks get the review sentence after it.
  regressionWithChecks: string;
  approvalWithRegressionAndChecks: string;
  // What an undecided check needs. It is a person's call, so the model raises it and must not
  // change code to make it pass or mark it reviewed itself. `review` follows another step.
  // `reviewOnly` is the whole step when undecided checks are the only cause: the verdict line
  // above it already says the change was checked, so the step is the action alone and never
  // points at the Not evaluated list, which is empty then.
  review: string;
  reviewOnly: string;
}

// Names the concrete ways an agent could clear an undecided check on its own. Both edit guarded
// files, so the gate would hold the run for approval anyway; the words close the door earlier.
const REVIEW_RULE =
  'Do not change code to make an undecided check pass, and do not mark one as reviewed yourself, for example by adding a waiver or recording it in the evidence floor.';

// How a blocked stop names the gaps: the reasons under Not evaluated and the ways to resolve each.
const BLOCK_GAP_WORK =
  'resolve every reason under Not evaluated below: make each unreachable screen reachable, map each unmapped file to a screen, grant each denied capability, and fix each failed provider (both are gaps named provider:<id>).';

const BLOCK_STEPS: NextSteps = {
  regression: 'Next: fix each barrier below, then stop again so usabl can re-check the change.',
  regressionWithChecks:
    'Next: fix each accessibility barrier below, then stop again so usabl can re-check the change.',
  regressionWithGaps: `Next: fix each accessibility barrier below, and ${BLOCK_GAP_WORK} Then stop again.`,
  approvalWithRegressionAndChecks:
    'Next: fix each accessibility barrier below, then tell the user that guarded policy files changed and need approval on the pull request. Do not edit those files to clear this block.',
  approvalWithRegressionAndGaps:
    `Next: fix each accessibility barrier below, and ${BLOCK_GAP_WORK} Then tell the user that guarded policy files changed and need approval on the pull request. Do not edit those files to clear this block.`,
  review: `Each check undecided below needs a person to review it, so tell the user. ${REVIEW_RULE}`,
  reviewOnly: `Next: tell the user that each check undecided below needs a person to review it. ${REVIEW_RULE}`,
  notCovered: `Next: ${BLOCK_GAP_WORK} Then stop again.`,
  approvalOnly:
    'Next: tell the user that guarded policy files changed and need approval on the pull request. Do not edit those files to clear this block.',
  approvalWithRegression:
    'Next: fix each barrier below, then tell the user that guarded policy files changed and need approval on the pull request. Do not edit those files to clear this block.',
  approvalWithGaps:
    'Next: resolve every reason under Not evaluated below, then tell the user that guarded policy files changed and need approval on the pull request. Do not edit those files to clear this block.',
};

// What the model should do when usabl does not recognize the run's state. A fix to the change
// cannot clear it, because nothing was checked, so the step is to run the check again.
// Each step that names a check takes it from HookContext.checkCommand.
const unrecognizedBlockStep = (check: CheckCommand): string =>
  `Next: run ${check} again and stop when it reports a verdict. If it still reports none usabl knows, tell the user, and check the change by hand before you call it accessible.`;
const unrecognizedContinuationStep = (check: CheckCommand): string =>
  `Next: run ${check} again before you tell the user this change is accessible. If it still reports no verdict usabl knows, tell the user.`;

/**
 * The same guidance for the run that is let through because continuation is already active.
 *
 * The work is the same work, so the same selector chooses it; only the framing differs. Nothing
 * is listed in that message beyond the gate's summary, so no step says "below", and each one
 * ends by naming the check that has to pass before the model may call the change accessible.
 * The stop went through, so no step speaks of clearing a block.
 * This path used to tell every blocking verdict to fix the barriers, which is wrong when
 * guarded files are the only thing standing and wrong again when the work is resolving gaps.
 */
const continuationSteps = (check: CheckCommand): NextSteps => ({
  regression: `Next: fix each accessibility barrier usabl reported, then run ${check} before you tell the user this change is accessible.`,
  regressionWithChecks: `Next: fix each accessibility barrier usabl reported, then run ${check} before you tell the user this change is accessible.`,
  regressionWithGaps: `Next: fix each accessibility barrier usabl reported and resolve every reason usabl reported under Not evaluated, then run ${check} before you tell the user this change is accessible.`,
  approvalWithRegressionAndChecks:
    'Next: fix each accessibility barrier usabl reported, then tell the user that guarded policy files changed and need approval on the pull request. Do not edit those files to make a later stop pass.',
  approvalWithRegressionAndGaps:
    'Next: fix each accessibility barrier usabl reported and resolve every reason usabl reported under Not evaluated, then tell the user that guarded policy files changed and need approval on the pull request. Do not edit those files to make a later stop pass.',
  review: `Tell the user that each check usabl could not decide needs a person to review it. ${REVIEW_RULE}`,
  reviewOnly: `Next: tell the user that each check usabl could not decide needs a person to review it. ${REVIEW_RULE}`,
  notCovered: `Next: resolve every reason usabl reported under Not evaluated, then run ${check} before you tell the user this change is accessible.`,
  approvalOnly:
    'Next: tell the user that guarded policy files changed and need approval on the pull request. Do not edit those files to make a later stop pass.',
  approvalWithRegression:
    'Next: fix each accessibility barrier usabl reported, then tell the user that guarded policy files changed and need approval on the pull request. Do not edit those files to make a later stop pass.',
  approvalWithGaps:
    'Next: resolve every reason usabl reported under Not evaluated, then tell the user that guarded policy files changed and need approval on the pull request. Do not edit those files to make a later stop pass.',
});

/**
 * The step for one Result, from one set of wordings.
 *
 * A guarded-file block asks what the accessibility half of the run said, because that half is a
 * separate verdict the gate wrote and the two can disagree: policy can block a run whose
 * accessibility is verified, regressed, or unproven, and each of those is different work. Every
 * caller routes through here so no path can answer this on its own.
 */
function chooseNextStep(result: Result, steps: NextSteps): string | undefined {
  // An undecided check adds the review sentence to whatever else the run needs. When it is the
  // only thing holding the accessibility half, the coverage step is left out, because the list it
  // points at is empty. The causes are read from the Result and choose no verdict.
  const { coverageFailed, undecided } = blockingCauses(result);
  const withReview = (step: string): string => `${step} ${steps.review}`;
  if (result.verdict === 'approval_required') {
    if (result.accessibilityVerdict === 'regression') {
      if (coverageFailed) {
        return undecided ? withReview(steps.approvalWithRegressionAndGaps) : steps.approvalWithRegressionAndGaps;
      }
      return undecided ? withReview(steps.approvalWithRegressionAndChecks) : steps.approvalWithRegression;
    }
    if (result.accessibilityVerdict === 'not_covered') {
      if (!undecided) {
        return steps.approvalWithGaps;
      }
      return coverageFailed
        ? withReview(steps.approvalWithGaps)
        : withReview(steps.approvalOnly);
    }
    return steps.approvalOnly;
  }
  if (result.verdict === 'regression') {
    if (coverageFailed) {
      return undecided ? withReview(steps.regressionWithGaps) : steps.regressionWithGaps;
    }
    return undecided ? withReview(steps.regressionWithChecks) : steps.regression;
  }
  if (result.verdict === 'not_covered') {
    if (!undecided) {
      return steps.notCovered;
    }
    return coverageFailed ? withReview(steps.notCovered) : steps.reviewOnly;
  }
  return undefined;
}

/**
 * The line every stop-hook message opens with: the verdict word and exit code, then what that
 * means for the change. Every part is an engine constant chosen by the verdict, or the exit code
 * once it is checked to be a whole number, so it is trusted scaffold and never framed.
 */
function verdictLine(result: Result, meaningPrefix: string): string {
  const verdict = describeVerdict(result);
  return `${formatVerdictWord(verdict)}: ${meaningPrefix}${verdict.meaning}`;
}

/**
 * The gate's own summary as a framed piece.
 *
 * The summary is free text and not always engine-only: the summary for a run that never saw the
 * application names the unseen screen ids, which the router fallback can derive from a route
 * literal in the application, and a crash summary carries a raw error message. Anything a page
 * can influence is data to a model reader, so the summary goes inside the frame under its own
 * label rather than beside the verdict line. The frame label says untrusted text, not page
 * text, so engine free text sits there correctly. The piece is bounded because a crash summary
 * can be long; only the free text is cut, and the verdict word and exit code come from the
 * verdict line, never from the summary.
 */
function summaryPiece(result: Result): string {
  return `engine summary: ${boundField(result.summary, 'summary')}`;
}

/**
 * The whole block message, with at most one untrusted frame.
 *
 * It opens with the verdict word and exit code, what the verdict means, and the next step, so a
 * model reads the decision before any detail. The trusted engine scaffold stays outside the
 * frame: those opening lines, the guarded-file lines when policy files changed, the headline of
 * each blocking item with its checked status, severity, and count, and the show-all hint. An item
 * is an accessibility barrier or a check usabl could not decide, and its headline says which.
 * Every value the Result carried goes inside one frame, each with a short inline label so the
 * model can map evidence to cause: the gate's summary first, then the guarded file paths, then
 * each item's rule, layer, screen id, experience, and fix, and each gap detail.
 *
 * Inside the frame the pieces read in the order a reader needs them: each item opens with an
 * "accessibility barrier:" or "check undecided:" line naming its layer and rule, and the
 * "Not evaluated:" label sits directly above the gap
 * lines rather than outside the frame, so a reader never meets "Not evaluated:" and then reads
 * about a button. Both labels are engine text; they are pieces only so they stay next to what
 * they label.
 *
 * The noise budget bounds how many groups appear, and the assembled block is never cut to
 * length. Cutting could remove the single closing marker and hand the model an unterminated
 * block of untrusted text.
 */
function buildBlockMessage(result: Result, ctx: HookContext, config?: UsablConfig): string {
  const scaffold = [verdictLine(result, 'NOT verified. ')];
  const budget = resolveNoiseBudgetDefault(config);
  // The barriers this block is about are the ones the gate blocks on, by the gate's own rule.
  const gating = result.findings.filter(isBlockingBarrier);
  const view = applyNoiseBudget(gating, budget, 'gating findings');

  const nextStep = chooseNextStep(result, BLOCK_STEPS);
  if (nextStep !== undefined) {
    scaffold.push(nextStep);
  }
  const pieces: string[] = [summaryPiece(result)];
  if (result.verdict === 'approval_required') {
    const guarded = stopGuardedFileLines(result, ctx);
    scaffold.push(...guarded.scaffold);
    if (guarded.piece !== null) {
      pieces.push(guarded.piece);
    }
  }
  // The verdict line, the next step, and the guarded-file lines always survive the message
  // bound, as do the summary piece that opens the frame and the guarded-file piece after it.
  const keep = scaffold.length;
  const keepPieces = pieces.length;

  // Each free-text field is bounded on its own before it is labelled and framed, so a huge page
  // string shortens with a visible note and the counts around it stay whole. See barrierLines for
  // what a barrier prints outside the frame and what inside it.
  const barriers = barrierLines(view);

  const gapPieces = notEvaluatedPieces(result);
  // The floor notices close the frame. Like gap lines they limit what the run can claim, so they
  // are tail pieces and outlast every barrier when the message is shortened.
  // Provider notes and then the excluded files come last: they are disclosure only and the first
  // tail pieces a shortened message drops.
  const tailPieces = [
    ...(gapPieces.length > 0 ? ['Not evaluated:', ...gapPieces] : []),
    ...unconfirmedPieces(result),
    ...notePieces(result),
    ...excludedFilePieces(result),
  ];

  // The whole message is bounded as well as each field. Whole barriers go first, headline and
  // pieces together, then floor notices and gap lines from the end, never the opening lines, the
  // summary piece, or the guarded file piece, and the frame is rebuilt around what survives.
  return assembleBoundedMessage({
    scaffold,
    keep,
    pieces,
    keepPieces,
    ...barriers,
    tailPieces,
    frame: frameUntrustedBlock,
  });
}

/** What the stop hook did with session pins before it took the receipt fast path. */
export interface StoredReceiptPinState {
  // True when this stop compared the session pins and found no drift.
  pinsCompared: boolean;
  // False when this stop did not compare pins it should have, for example because the pin store
  // refused. The line then carries the same note a full run's allow line does.
  sessionDriftChecked: boolean;
  // True when git records no trusted branch. The line then carries NO_TRUSTED_BRANCH_WARNING.
  noTrustedBranch?: boolean;
}

// A receipt records no known limits, so a run verified with known limits would read on the fast
// path as a plain verified. usabl check always scans, so it shows them.
const STORED_RECEIPT_LIMITS =
  'A stored receipt does not record known limits, so any the scan had are not shown here; run usabl check to see them.';

/**
 * The allow line for a stored receipt that still matches the working tree. The stop hook prints
 * it on the fast path, before any run, so no Result exists yet. The receipt was read from a file
 * in the work tree, so its source tree is a carried value and goes inside the frame.
 *
 * The line says first that the result comes from a stored receipt and was not re-scanned, next to
 * the verdict word, so a reader never takes it for a fresh check. A receipt is a local file with
 * no signature: a user with a shell on the same machine can write one that verifies (threat model,
 * Threats 1 and 4). The line names what was compared and nothing more. A receipt binds the tree,
 * the committed policy, the engine, and the scanners as they were when it was minted; it says
 * nothing about the policy at the start of the session. Only a stop that compared the session
 * pins says they match. A receipt records no known limits, so the line says that any the scan had
 * are not shown here, and names the command that shows them.
 */
export function formatStoredReceiptAllow(
  sourceTree: unknown,
  pins: StoredReceiptPinState = { pinsCompared: false, sessionDriftChecked: true },
): string {
  const notes = passNotes(pins.sessionDriftChecked, pins.noTrustedBranch);
  const note = notes === undefined ? '' : `, ${notes}`;
  const pinClause = pins.pinsCompared ? ' Guarded policy files match the session pins.' : '';
  const line =
    `VERIFIED (exit 0, stored receipt, not re-scanned${note}): this result comes from a stored receipt. ` +
    'usabl did not scan this change again on this stop. The receipt matches this tree, the committed policy, the engine, and the scanners.' +
    `${pinClause} ${STORED_RECEIPT_LIMITS} You may stop.`;
  return assembleBoundedMessage({
    scaffold: [line],
    keep: 1,
    pieces: [`receipt sourceTree: ${boundField(scrubString(String(sourceTree)), 'receipt')}`],
    keepPieces: 1,
    frame: frameUntrustedBlock,
  });
}

/**
 * The guarded files the guard found diverged on a run that reached no blocking verdict, sorted and
 * without repeats. A run with no verdict (a crash, a run where every screen was unseen, or an idle
 * run) counts the paths it carries and the ones the hook's own guard found before the run, because
 * a crash carries none of its own. A verified run is the gate's answer, and the gate already
 * weighed the guard on that run, so only the paths it carries count. A list that is not a list
 * adds none.
 */
function divergedGuardedPaths(result: Result, ctx: HookContext): string[] {
  if (result.verdict !== null && result.verdict !== 'verified') {
    return [];
  }
  const carried: unknown = result.dirtyGuardedPaths;
  const fromResult = Array.isArray(carried) ? carried.map(String) : [];
  const fromHook = result.verdict === null ? (ctx.guardDivergedPaths ?? []).map(scrubString) : [];
  return [...new Set([...fromResult, ...fromHook])].sort();
}

/**
 * The message for a run that reached no blocking verdict while guarded policy diverged: a
 * verified run, an idle run, or a failed run. run() refuses a run where every screen was unseen
 * with exit 4 and no verdict, and the guard still reported the diverged files on it, so the hook
 * holds the stop for approval whatever the exit code. The verdict line is the run's own, the
 * guarded files go inside the frame, and the block lets one continuation through like every other.
 */
function divergedPolicyDecision(result: Result, diverged: string[], ctx: HookContext): StopDecision {
  const continuation = ctx.stopHookActive;
  const verdict = describeVerdict(result);
  const opening =
    `${formatVerdictWord(verdict)}: NOT verified. ` +
    (continuation ? 'usabl let this stop through without blocking again (continuation already active). ' : '') +
    `Guarded policy files changed, so this change needs approval whatever the run found. The run said: ${verdict.meaning}`;
  // approvalOnly names no check, so the check this wording set takes does not matter here.
  const steps = continuation ? continuationSteps('usabl check') : BLOCK_STEPS;
  const scaffold = [opening, steps.approvalOnly];
  const pieces = [summaryPiece(result)];
  const guarded = stopGuardedFileLines({ ...result, dirtyGuardedPaths: diverged }, ctx);
  scaffold.push(...guarded.scaffold);
  if (guarded.piece !== null) {
    pieces.push(guarded.piece);
  }
  return {
    block: !continuation,
    message: assembleBoundedMessage({
      scaffold,
      keep: scaffold.length,
      pieces,
      keepPieces: pieces.length,
      frame: frameUntrustedBlock,
    }),
  };
}

export function evaluateStopDecision(
  result: Result,
  ctx: HookContext,
  config?: UsablConfig,
): StopDecision {
  const safe = scrubResult(result);
  const passNote = passNotes(ctx.sessionDriftChecked, ctx.noTrustedBranch);
  const check = ctx.checkCommand ?? 'usabl check';

  // Diverged guarded policy blocks whatever the exit code. The blocking verdicts carry it in their
  // own message, and an unrecognized verdict blocks below, so this catches every other state.
  const diverged = divergedGuardedPaths(safe, ctx);
  if (diverged.length > 0) {
    return divergedPolicyDecision(safe, diverged, ctx);
  }

  if (safe.verdict === 'verified') {
    const sourceTree = safe.receipt?.sourceTree;
    const verdict = describeVerdict(safe);
    const line = `${formatVerdictWord(verdict, passNote)}: the gate verified this change. You may stop.`;
    // A verified run is where the floor notice matters most: floored debt on a screen whose
    // content may not have mounted. It does not change the decision. It travels with it, framed.
    // Provider notes travel with it the same way, after the floor notices, and the excluded files
    // last. They never block.
    const notices = [...unconfirmedPieces(safe), ...notePieces(safe), ...excludedFilePieces(safe)];
    if (sourceTree === undefined && notices.length === 0) {
      return { block: false, message: line };
    }
    // The receipt's source tree is carried by the Result, so it is a piece inside the frame like
    // every other carried string, not part of the line usabl speaks in.
    const pieces = sourceTree === undefined ? [] : [`receipt sourceTree: ${boundField(String(sourceTree), 'receipt')}`];
    return {
      block: false,
      message: assembleBoundedMessage({
        scaffold: [line],
        keep: 1,
        pieces,
        keepPieces: pieces.length,
        tailPieces: notices,
        frame: frameUntrustedBlock,
      }),
    };
  }

  if (safe.exitCode === 4 && safe.verdict === null) {
    // A failed run proves nothing, and the hook fails open: it does not block. The line says
    // both, so the protocol decision and its limit are read together. It never says "verified"
    // in any form, so a model skimming the first word cannot mistake it for a pass.
    const verdict = describeVerdict(safe);
    return {
      block: false,
      message: assembleBoundedMessage({
        scaffold: [
          `${formatVerdictWord(verdict)}: usabl is not blocking this stop, but the run did not finish, so it proved nothing about this change.`,
          `Next: run ${check} again, or check the change by hand, before you call this change accessible.`,
        ],
        keep: 2,
        pieces: [summaryPiece(safe)],
        keepPieces: 1,
        frame: frameUntrustedBlock,
      }),
    };
  }

  // Idle only when run() said so with the boolean true, the same test describeVerdict and
  // unrecognizedRunLine apply. Any other value under a null verdict is a run that proved nothing,
  // and it blocks below.
  if (safe.verdict === null && safe.coverage.nothingToCheck === true) {
    const verdict = describeVerdict(safe);
    // An idle run that excluded files says so on its line and lists them inside the frame, so it
    // does not read as plain nothing to check.
    const leftOut = leftOutLine(safe);
    const line = `${formatVerdictWord(verdict, passNote)}: ${verdict.meaning}${leftOut === null ? '' : ` ${leftOut}`} You may stop.`;
    if (leftOut === null) {
      return { block: false, message: line };
    }
    return {
      block: false,
      message: assembleBoundedMessage({
        scaffold: [line],
        keep: 1,
        pieces: [],
        tailPieces: excludedFilePieces(safe),
        frame: frameUntrustedBlock,
      }),
    };
  }

  const unrecognized = unrecognizedRunLine(safe, { includeFailedRuns: true });
  if (unrecognized !== null) {
    // A verdict usabl does not recognize, or a null verdict on a run that was neither idle nor a
    // crash, can only be composed outside run(). It is not evidence that the change is clean, so
    // the stop blocks, with the reason in usabl's own words. The carried verdict is never
    // printed, and the gate's summary goes inside the frame. While continuation is already active
    // the stop goes through once, marked NOT verified, as for every other blocking state, so the
    // model is not looped.
    const opening = `${unrecognized.word}: NOT verified. ${
      ctx.stopHookActive ? 'usabl let this stop through without blocking again (continuation already active). ' : ''
    }${unrecognized.meaning}`;
    return {
      block: !ctx.stopHookActive,
      message: assembleBoundedMessage({
        scaffold: [opening, ctx.stopHookActive ? unrecognizedContinuationStep(check) : unrecognizedBlockStep(check)],
        keep: 2,
        pieces: [summaryPiece(safe)],
        keepPieces: 1,
        frame: frameUntrustedBlock,
      }),
    };
  }

  // Every state left here is a blocking verdict. Verified, a failed run, and an idle run returned
  // above, and unrecognizedRunLine caught every other null verdict and every verdict usabl does
  // not know, so regression, not_covered, and approval_required are all that reach this point.

  if (ctx.stopHookActive) {
    // A second block while continuation is active can loop the model and hide the real operator
    // choice. The stop goes through, and the guidance is still the guidance for this verdict:
    // the same selector the block message uses, in the wording this path needs. A guarded-file
    // state also names the files here, because the step tells the model to raise them with the
    // user and a model cannot name a file it was not given.
    const scaffold = [
      verdictLine(
        safe,
        'NOT verified. usabl let this stop through without blocking again (continuation already active). ',
      ),
    ];
    const step = chooseNextStep(safe, continuationSteps(check));
    if (step !== undefined) {
      scaffold.push(step);
    }
    const pieces = [summaryPiece(safe)];
    if (safe.verdict === 'approval_required') {
      const guarded = stopGuardedFileLines(safe, ctx);
      scaffold.push(...guarded.scaffold);
      if (guarded.piece !== null) {
        pieces.push(guarded.piece);
      }
    }
    return {
      block: false,
      message: assembleBoundedMessage({
        scaffold,
        keep: scaffold.length,
        pieces,
        keepPieces: pieces.length,
        // The floor notices travel with the stop here too, inside the frame, after the summary.
        tailPieces: [...unconfirmedPieces(safe), ...notePieces(safe), ...excludedFilePieces(safe)],
        frame: frameUntrustedBlock,
      }),
    };
  }

  return {
    block: true,
    message: buildBlockMessage(safe, ctx, config),
  };
}

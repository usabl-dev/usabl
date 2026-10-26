/**
 * Stop-hook projection for local continuation decisions.
 * This unit maps an existing Result into block or allow messages only.
 * It must never mint verdicts or bypass gate ownership of verdict authority.
 */
import type { Result, UsablConfig, Verdict } from '../contracts/index.js';
import { assembleBoundedMessage, boundField } from '../output/bounded-text.js';
import { isBlockingBarrier } from '../output/disclosure.js';
import { applyNoiseBudget, resolveNoiseBudgetDefault } from '../output/noise-budget.js';
import { describeVerdict, formatVerdictWord } from '../output/verdict-line.js';
import { barrierLines, guardedFileLines, notEvaluatedPieces } from './model-pieces.js';
import { frameUntrustedBlock, scrubResult, scrubString } from './scrub.js';

export interface HookContext {
  stopHookActive: boolean;
  // False when the Stop hook did not compare session pins on this stop, for example because the
  // pin store refused. An allow that would otherwise read as a pass then says so on its first
  // line. Absent means the comparison ran or had nothing to compare yet.
  sessionDriftChecked?: boolean;
}

// The note an allow line carries when the session drift comparison did not run.
const DRIFT_NOT_CHECKED = 'session drift not checked';

export interface StopDecision {
  block: boolean;
  message: string;
}

const BLOCKING_VERDICTS: ReadonlySet<Verdict> = new Set(['regression', 'approval_required', 'not_covered']);

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
 */
interface NextSteps {
  regression: string;
  notCovered: string;
  approvalOnly: string;
  approvalWithRegression: string;
  approvalWithGaps: string;
}

const BLOCK_STEPS: NextSteps = {
  regression: 'Next: fix each barrier below, then stop again so usabl can re-check the change.',
  notCovered:
    'Next: resolve every reason under Not evaluated below: make each unreachable screen reachable, map each unmapped file to a screen, grant each denied capability, and fix each failed provider (both are gaps named provider:<id>). Then stop again.',
  approvalOnly:
    'Next: tell the user that guarded policy files changed and need approval on the pull request. Do not edit those files to clear this block.',
  approvalWithRegression:
    'Next: fix each barrier below, then tell the user that guarded policy files changed and need approval on the pull request. Do not edit those files to clear this block.',
  approvalWithGaps:
    'Next: resolve every reason under Not evaluated below, then tell the user that guarded policy files changed and need approval on the pull request. Do not edit those files to clear this block.',
};

/**
 * The same guidance for the run that is let through because continuation is already active.
 *
 * The work is the same work, so the same selector chooses it; only the framing differs. Nothing
 * is listed in that message beyond the gate's summary, so no step says "below", and each one
 * ends by naming the check that has to pass before the model may call the change accessible.
 * This path used to tell every blocking verdict to fix the barriers, which is wrong when
 * guarded files are the only thing standing and wrong again when the work is resolving gaps.
 */
const CONTINUATION_STEPS: NextSteps = {
  regression:
    'Next: fix each barrier usabl reported, then run usabl check before you tell the user this change is accessible.',
  notCovered:
    'Next: resolve every reason usabl reported under Not evaluated, then run usabl check before you tell the user this change is accessible.',
  approvalOnly:
    'Next: tell the user that guarded policy files changed and need approval on the pull request. Do not edit those files to clear this block.',
  approvalWithRegression:
    'Next: fix each barrier usabl reported, then tell the user that guarded policy files changed and need approval on the pull request. Do not edit those files to clear this block.',
  approvalWithGaps:
    'Next: resolve every reason usabl reported under Not evaluated, then tell the user that guarded policy files changed and need approval on the pull request. Do not edit those files to clear this block.',
};

/**
 * The step for one Result, from one set of wordings.
 *
 * A guarded-file block asks what the accessibility half of the run said, because that half is a
 * separate verdict the gate wrote and the two can disagree: policy can block a run whose
 * accessibility is verified, regressed, or unproven, and each of those is different work. Every
 * caller routes through here so no path can answer this on its own.
 */
function chooseNextStep(result: Result, steps: NextSteps): string | undefined {
  if (result.verdict === 'approval_required') {
    if (result.accessibilityVerdict === 'regression') {
      return steps.approvalWithRegression;
    }
    if (result.accessibilityVerdict === 'not_covered') {
      return steps.approvalWithGaps;
    }
    return steps.approvalOnly;
  }
  if (result.verdict === 'regression') {
    return steps.regression;
  }
  if (result.verdict === 'not_covered') {
    return steps.notCovered;
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
 * frame: those opening lines, the guarded-file lines when policy files changed, the Barrier or
 * Barriers headline lines with their checked status, severity, and count, and the show-all hint.
 * Every value the Result carried goes inside one frame, each with a short inline label so the
 * model can map evidence to cause: the gate's summary first, then the guarded file paths, then
 * each barrier's rule, layer, screen id, experience, and fix, and each gap detail.
 *
 * Inside the frame the pieces read in the order a reader needs them: each barrier opens with a
 * "barrier:" line naming its layer and rule, and the "Not evaluated:" label sits directly above the gap
 * lines rather than outside the frame, so a reader never meets "Not evaluated:" and then reads
 * about a button. Both labels are engine text; they are pieces only so they stay next to what
 * they label.
 *
 * The noise budget bounds how many groups appear, and the assembled block is never cut to
 * length. Cutting could remove the single closing marker and hand the model an unterminated
 * block of untrusted text.
 */
function buildBlockMessage(result: Result, config?: UsablConfig): string {
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
    const guarded = guardedFileLines(result);
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
  const tailPieces = gapPieces.length > 0 ? ['Not evaluated:', ...gapPieces] : [];

  // The whole message is bounded as well as each field. Whole barriers go first, headline and
  // pieces together, then gap lines, never the opening lines, the summary piece, or the guarded
  // file piece, and the frame is rebuilt around what survives.
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
}

/**
 * The allow line for a stored receipt that still matches the working tree. The stop hook prints
 * it on the fast path, before any run, so no Result exists yet. The receipt was read from a file
 * in the work tree, so its source tree is a carried value and goes inside the frame.
 *
 * The line names what was compared and nothing more. A receipt binds the tree, the committed
 * policy, the engine, and the scanners as they were when it was minted; it says nothing about the
 * policy at the start of the session. Only a stop that compared the session pins says they match.
 */
export function formatStoredReceiptAllow(
  sourceTree: unknown,
  pins: StoredReceiptPinState = { pinsCompared: false, sessionDriftChecked: true },
): string {
  const note = pins.sessionDriftChecked ? '' : `, ${DRIFT_NOT_CHECKED}`;
  const pinClause = pins.pinsCompared ? ' Guarded policy files match the session pins.' : '';
  const line =
    `VERIFIED (exit 0${note}): a stored receipt matches this tree, the committed policy, the engine, and the scanners.` +
    `${pinClause} No new scan ran. You may stop.`;
  return assembleBoundedMessage({
    scaffold: [line],
    keep: 1,
    pieces: [`receipt sourceTree: ${boundField(scrubString(String(sourceTree)), 'receipt')}`],
    keepPieces: 1,
    frame: frameUntrustedBlock,
  });
}

export function evaluateStopDecision(
  result: Result,
  ctx: HookContext,
  config?: UsablConfig,
): StopDecision {
  const safe = scrubResult(result);
  const passNote = ctx.sessionDriftChecked === false ? DRIFT_NOT_CHECKED : undefined;

  if (safe.verdict === 'verified') {
    const sourceTree = safe.receipt?.sourceTree;
    const verdict = describeVerdict(safe);
    const line = `${formatVerdictWord(verdict, passNote)}: the gate verified this change. You may stop.`;
    if (sourceTree === undefined) {
      return { block: false, message: line };
    }
    // The receipt's source tree is carried by the Result, so it is a piece inside the frame like
    // every other carried string, not part of the line usabl speaks in.
    return {
      block: false,
      message: assembleBoundedMessage({
        scaffold: [line],
        keep: 1,
        pieces: [`receipt sourceTree: ${boundField(String(sourceTree), 'receipt')}`],
        keepPieces: 1,
        frame: frameUntrustedBlock,
      }),
    };
  }

  if (safe.exitCode === 4) {
    // A failed run proves nothing, and the hook fails open: it does not block. The line says
    // both, so the protocol decision and its limit are read together. It never says "verified"
    // in any form, so a model skimming the first word cannot mistake it for a pass.
    const verdict = describeVerdict(safe);
    return {
      block: false,
      message: assembleBoundedMessage({
        scaffold: [
          `${formatVerdictWord(verdict)}: usabl is not blocking this stop, but the run did not finish, so it proved nothing about this change.`,
          'Next: run usabl check again, or check the change by hand, before you call this change accessible.',
        ],
        keep: 2,
        pieces: [summaryPiece(safe)],
        keepPieces: 1,
        frame: frameUntrustedBlock,
      }),
    };
  }

  if (safe.verdict === null && safe.coverage.nothingToCheck) {
    const verdict = describeVerdict(safe);
    return {
      block: false,
      message: `${formatVerdictWord(verdict, passNote)}: ${verdict.meaning} You may stop.`,
    };
  }

  const shouldBlock = safe.verdict !== null && BLOCKING_VERDICTS.has(safe.verdict);
  if (!shouldBlock) {
    // A null verdict with no idle flag and no crash can only be composed outside run(). Say
    // that usabl reached no verdict rather than guess which null state it is. The exit code goes
    // through the shared verdict word, which prints it only when it is a whole number.
    const noVerdict = formatVerdictWord({ ...describeVerdict(safe), word: 'NO VERDICT' });
    return {
      block: false,
      message: assembleBoundedMessage({
        scaffold: [`${noVerdict}: usabl did not reach a verdict for this change.`],
        keep: 1,
        pieces: [summaryPiece(safe)],
        keepPieces: 1,
        frame: frameUntrustedBlock,
      }),
    };
  }

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
    const step = chooseNextStep(safe, CONTINUATION_STEPS);
    if (step !== undefined) {
      scaffold.push(step);
    }
    const pieces = [summaryPiece(safe)];
    if (safe.verdict === 'approval_required') {
      const guarded = guardedFileLines(safe);
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
        frame: frameUntrustedBlock,
      }),
    };
  }

  return {
    block: true,
    message: buildBlockMessage(safe, config),
  };
}

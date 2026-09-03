/**
 * Stop-hook projection for local continuation decisions.
 * This unit maps an existing Result into block or allow messages only.
 * It must never mint verdicts or bypass gate ownership of verdict authority.
 */
import type { Result, Verdict } from '../contracts/index.js';
import {
  discloseGaps,
  fixOrAbsence,
  gapDetail,
  gapHeadline,
  pickBarrier,
} from '../output/disclosure.js';
import { frameUntrustedBlock, scrubResult } from './scrub.js';

export interface HookContext {
  stopHookActive: boolean;
}

export interface StopDecision {
  block: boolean;
  message: string;
}

const BLOCKING_VERDICTS: ReadonlySet<Verdict> = new Set(['regression', 'approval_required', 'not_covered']);

/**
 * What the run did not examine, one entry per gap state.
 *
 * The reader is a model deciding whether to keep working, so it gets a reason it can act on
 * rather than a count it cannot. One example per state and a count of the rest, because gaps
 * cluster: five screens behind one broken server produce five near-identical reasons, while a
 * denied capability is a different fact that must never be crowded out by them.
 *
 * Each line pairs the gap headline, which is trusted usabl-chosen text, with the page-derived
 * detail, so the model can still map each reason to its state inside the single frame.
 *
 * The length is bounded by construction. There are four gap states, so there are at most four
 * entries, and no assembled string is ever cut to fit. Cutting could remove a closing frame
 * marker and hand the model an unterminated block of untrusted text.
 */
function notEvaluatedPieces(result: Result): string[] {
  const disclosures = discloseGaps(result.coverage.gaps);
  return disclosures.map(
    (disclosure) => `- ${gapHeadline(disclosure)}: ${gapDetail(disclosure)}`,
  );
}

/**
 * The whole block message, with at most one untrusted frame.
 *
 * The trusted engine scaffold stays outside the frame: the summary line, the Rule line, and the
 * Not evaluated header. Every page-derived piece, the finding experience, the fix, and each gap
 * detail, goes inside one frame, each with a short inline label so the model can map evidence to
 * cause. The pieces are already bounded, and the assembled block is never cut to length. Cutting
 * could remove the single closing marker and hand the model an unterminated block of untrusted
 * text.
 */
function buildBlockMessage(result: Result): string {
  const scaffold = [`NOT verified - ${result.summary}`];
  const pieces: string[] = [];

  const finding = pickBarrier(result.findings);
  if (finding !== null) {
    scaffold.push(`Rule: ${finding.rule}`);
    pieces.push(`experience: ${finding.whatUserExperiences}`);
    // The fix is page-derived like the experience above it. Only five axe rules carry a curated
    // note, and for every other rule this text is axe's failureSummary, which comes from the page
    // under test, so it is no more trustworthy than the experience already in the frame.
    //
    // When no fix was recorded this frames usabl's own sentence and so mislabels it as page text.
    // That is deliberate. A Finding carries no provenance saying where its fix came from, so the
    // alternative is a conditional framing path where the caller decides trust per string, and a
    // path that can choose not to frame is a worse shape than an over-label that errs toward
    // distrust.
    pieces.push(`fix: ${fixOrAbsence(finding)}`);
  }

  const gapPieces = notEvaluatedPieces(result);
  if (gapPieces.length > 0) {
    scaffold.push('Not evaluated:');
    pieces.push(...gapPieces);
  }

  if (pieces.length === 0) {
    return scaffold.join('\n');
  }

  return [...scaffold, frameUntrustedBlock(pieces)].join('\n');
}

export function evaluateStopDecision(result: Result, ctx: HookContext): StopDecision {
  const safe = scrubResult(result);

  if (safe.verdict === 'verified') {
    const sourceTree = safe.receipt?.sourceTree;
    return {
      block: false,
      message:
        sourceTree === undefined
          ? 'verified: gate accepted this run.'
          : `verified: receipt sourceTree ${sourceTree}.`,
    };
  }

  if (safe.exitCode === 4) {
    return {
      block: false,
      message: `NOT verified - error during run. ${safe.summary}`,
    };
  }

  if (safe.verdict === null && safe.coverage.nothingToCheck) {
    return {
      block: false,
      message: 'nothing to check: no UI-touching files in this stop.',
    };
  }

  const shouldBlock = safe.verdict !== null && BLOCKING_VERDICTS.has(safe.verdict);
  if (!shouldBlock) {
    return {
      block: false,
      message: `NOT verified - ${safe.summary}`,
    };
  }

  if (ctx.stopHookActive) {
    // A second block while continuation is active can loop the model and hide the real operator choice.
    return {
      block: false,
      message: `NOT verified - continuation already active. ${safe.summary}`,
    };
  }

  return {
    block: true,
    message: buildBlockMessage(safe),
  };
}

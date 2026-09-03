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
import { frameUntrusted, scrubResult } from './scrub.js';

export interface HookContext {
  stopHookActive: boolean;
}

export interface StopDecision {
  block: boolean;
  message: string;
}

const BLOCKING_VERDICTS: ReadonlySet<Verdict> = new Set(['regression', 'approval_required', 'not_covered']);

/**
 * Every piece of page-derived text goes through here, one call per item.
 *
 * Per item, and deliberately not one frame around the whole message. frameUntrusted does not
 * escape its own markers, so page text carrying a literal close marker can forge one. Framing
 * each item separately holds that blast radius to the item that carried it, because the next
 * item opens its own frame. A single block frame would let one forged close escape everything
 * after it, including the coverage reasons.
 */
function framed(text: string): string {
  return frameUntrusted(text);
}

/**
 * What the run did not examine, one entry per gap state.
 *
 * The reader is a model deciding whether to keep working, so it gets a reason it can act on
 * rather than a count it cannot. One example per state and a count of the rest, because gaps
 * cluster: five screens behind one broken server produce five near-identical reasons, while a
 * denied capability is a different fact that must never be crowded out by them.
 *
 * The length is bounded by construction. There are four gap states, so there are at most four
 * entries, and no assembled string is ever cut to fit. Cutting could remove a closing frame
 * marker and hand the model an unterminated block of untrusted text.
 */
function notEvaluatedLines(result: Result): string[] {
  const disclosures = discloseGaps(result.coverage.gaps);
  if (disclosures.length === 0) {
    return [];
  }

  return [
    'Not evaluated:',
    ...disclosures.flatMap((disclosure) => [
      `- ${gapHeadline(disclosure)}:`,
      framed(gapDetail(disclosure)),
    ]),
  ];
}

function buildBlockMessage(result: Result): string {
  const lines = [`NOT verified - ${result.summary}`];
  const finding = pickBarrier(result.findings);
  if (finding !== null) {
    lines.push(`Rule: ${finding.rule}`);
    lines.push(framed(finding.whatUserExperiences));
    // The fix is framed like the experience above it. Only five axe rules carry a curated note,
    // and for every other rule this text is axe's failureSummary, which comes from the page under
    // test, so it is no more trustworthy than the line already inside a frame.
    //
    // When no fix was recorded this frames usabl's own sentence and so mislabels it as page text.
    // That is deliberate. A Finding carries no provenance saying where its fix came from, so the
    // alternative is a conditional framing path where the caller decides trust per string, and a
    // path that can choose not to frame is a worse shape than an over-label that errs toward
    // distrust.
    lines.push('Fix:');
    lines.push(framed(fixOrAbsence(finding)));
  }
  lines.push(...notEvaluatedLines(result));
  return lines.join('\n');
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

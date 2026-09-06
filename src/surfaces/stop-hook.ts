/**
 * Stop-hook projection for local continuation decisions.
 * This unit maps an existing Result into block or allow messages only.
 * It must never mint verdicts or bypass gate ownership of verdict authority.
 */
import type { Result, UsablConfig, Verdict } from '../contracts/index.js';
import {
  discloseGaps,
  fixOrAbsence,
  gapDetail,
  gapHeadline,
} from '../output/disclosure.js';
import {
  applyNoiseBudget,
  formatCollapsedGroupHeadline,
  resolveNoiseBudgetDefault,
} from '../output/noise-budget.js';
import { describeVerdict, formatVerdictWord } from '../output/verdict-line.js';
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
 * What the model should do next for each blocking verdict.
 *
 * The reader is a model that just tried to stop. It needs the verdict, the reason, and one
 * concrete next step, in that order, before any detail. A regression is fixed by the model. A
 * coverage gap is usually infrastructure the model can reach or a file it can map. Guarded policy
 * files are the one thing the model must not touch to clear a block, so that step says so.
 */
const NEXT_STEP: Record<string, string> = {
  regression: 'Next: fix each barrier below, then stop again so usabl can re-check the change.',
  not_covered:
    'Next: make every screen under Not evaluated reachable, or map each unmapped file to a screen, then stop again.',
  approval_required:
    'Next: tell the user that guarded policy files changed and a reviewer must approve them. Do not edit those files to clear this block.',
};

/**
 * The lines every stop-hook message opens with: the verdict word and exit code, what that means
 * for the change, and the gate's own summary with its counts. Trusted scaffold, never framed.
 */
function verdictScaffold(result: Result, meaningSuffix: string): string[] {
  const verdict = describeVerdict(result);
  return [
    `${formatVerdictWord(verdict)}: ${meaningSuffix}${verdict.meaning}`,
    `Gate summary: ${result.summary}`,
  ];
}

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
 * It opens with the verdict word and exit code, what the verdict means, the gate's summary, and
 * the next step, so a model reads the decision before any detail. The trusted engine scaffold
 * stays outside the frame: those opening lines, the Rule or Barriers headline lines, the show-all
 * hint, and the Not evaluated header. Every page-derived piece, each finding experience, each fix,
 * and each gap detail, goes inside one frame, each with a short inline label so the model can map
 * evidence to cause. The noise budget bounds how many groups appear, and the assembled block is
 * never cut to length. Cutting could remove the single closing marker and hand the model an
 * unterminated block of untrusted text.
 */
function buildBlockMessage(result: Result, config?: UsablConfig): string {
  const scaffold = verdictScaffold(result, 'NOT verified. ');
  const nextStep = result.verdict === null ? undefined : NEXT_STEP[result.verdict];
  if (nextStep !== undefined) {
    scaffold.push(nextStep);
  }
  const pieces: string[] = [];
  const budget = resolveNoiseBudgetDefault(config);
  // Only gating (deterministic) findings are barriers this block is about. Advisory findings never
  // gate, so listing one here would present it as a blocker it is not. They still surface elsewhere.
  const gating = result.findings.filter((finding) => finding.evidenceClass === 'deterministic');
  const view = applyNoiseBudget(gating, budget, 'gating findings');

  if (view.groups.length === 1 && !view.collapsed) {
    const group = view.groups[0]!;
    const ruleLabel =
      group.count > 1 ? `${group.rule} (×${group.count})` : group.rule;
    scaffold.push(`Rule: ${ruleLabel}`);
    pieces.push(`experience: ${group.representative.whatUserExperiences}`);
    pieces.push(`fix: ${fixOrAbsence(group.representative)}`);
  } else if (view.groups.length > 0) {
    scaffold.push('Barriers:');
    for (const group of view.groups) {
      scaffold.push(`- ${formatCollapsedGroupHeadline(group)}`);
      pieces.push(`experience (${group.rule}): ${group.representative.whatUserExperiences}`);
      pieces.push(`fix (${group.rule}): ${fixOrAbsence(group.representative)}`);
    }
    if (view.showAllHint !== null) {
      scaffold.push(view.showAllHint);
    }
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

export function evaluateStopDecision(
  result: Result,
  ctx: HookContext,
  config?: UsablConfig,
): StopDecision {
  const safe = scrubResult(result);

  if (safe.verdict === 'verified') {
    const sourceTree = safe.receipt?.sourceTree;
    const verdict = describeVerdict(safe);
    const proof =
      sourceTree === undefined
        ? 'the gate verified this change.'
        : `the gate verified this change. Receipt sourceTree ${sourceTree}.`;
    return {
      block: false,
      message: `${formatVerdictWord(verdict)}: ${proof} You may stop.`,
    };
  }

  if (safe.exitCode === 4) {
    // A failed run proves nothing. It never says "verified" in any form, so a model skimming
    // the first word cannot mistake it for a pass, and it names what to do instead.
    return {
      block: false,
      message: [
        ...verdictScaffold(safe, ''),
        'Next: run usabl check again, or check the change by hand, before you call this change accessible.',
      ].join('\n'),
    };
  }

  if (safe.verdict === null && safe.coverage.nothingToCheck) {
    const verdict = describeVerdict(safe);
    return {
      block: false,
      message: `${formatVerdictWord(verdict)}: ${verdict.meaning} You may stop.`,
    };
  }

  const shouldBlock = safe.verdict !== null && BLOCKING_VERDICTS.has(safe.verdict);
  if (!shouldBlock) {
    // A null verdict with no idle flag and no crash can only be composed outside run(). Say
    // that usabl reached no verdict rather than guess which null state it is.
    return {
      block: false,
      message: [
        `NO VERDICT (exit ${safe.exitCode}): usabl did not reach a verdict for this change.`,
        `Gate summary: ${safe.summary}`,
      ].join('\n'),
    };
  }

  if (ctx.stopHookActive) {
    // A second block while continuation is active can loop the model and hide the real operator choice.
    return {
      block: false,
      message: [
        ...verdictScaffold(
          safe,
          'NOT verified. usabl let this stop through without blocking again (continuation already active). ',
        ),
        'Next: fix the barriers and run usabl check before you tell the user this change is accessible.',
      ].join('\n'),
    };
  }

  return {
    block: true,
    message: buildBlockMessage(safe, config),
  };
}

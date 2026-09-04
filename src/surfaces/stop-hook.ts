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
import { frameUntrustedBlock, scrubResult } from './scrub.js';

export interface HookContext {
  stopHookActive: boolean;
}

export interface StopDecision {
  block: boolean;
  message: string;
}

const BLOCKING_VERDICTS: ReadonlySet<Verdict> = new Set(['regression', 'approval_required', 'not_covered']);

function notEvaluatedPieces(result: Result): string[] {
  const disclosures = discloseGaps(result.coverage.gaps);
  return disclosures.map(
    (disclosure) => `- ${gapHeadline(disclosure)}: ${gapDetail(disclosure)}`,
  );
}

function buildBlockMessage(result: Result, config?: UsablConfig): string {
  const scaffold = [`NOT verified - ${result.summary}`];
  const pieces: string[] = [];
  const budget = resolveNoiseBudgetDefault(config);
  const view = applyNoiseBudget(result.findings, budget);

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
    return {
      block: false,
      message: `NOT verified - continuation already active. ${safe.summary}`,
    };
  }

  return {
    block: true,
    message: buildBlockMessage(safe, config),
  };
}

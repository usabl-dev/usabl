/**
 * Advisory self-check projection for an existing Result.
 * This unit reports a human-readable snapshot only.
 * It must never gate, mint a verdict, or return a process-failing exit code.
 */
import type { Result, UsablConfig } from '../contracts/index.js';
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
import { formatAppSourceLocation, formatDocsSourceLocation } from '../output/source-location.js';
import { frameUntrustedBlock, scrubResult } from './scrub.js';

const VERDICT_LABELS: Record<NonNullable<Result['verdict']>, string> = {
  verified: 'VERIFIED',
  regression: 'REGRESSION',
  not_covered: 'NOT COVERED',
  approval_required: 'APPROVAL REQUIRED',
};

/**
 * What the run did not examine, one entry per gap state, bounded by the number of states.
 *
 * Each entry pairs the trusted gap headline with the page-derived detail, so the model can map
 * a reason to its state inside the single frame the caller builds.
 */
function notEvaluatedPieces(result: Result): string[] {
  const disclosures = discloseGaps(result.coverage.gaps);
  return disclosures.map(
    (disclosure) => `- ${gapHeadline(disclosure)}: ${gapDetail(disclosure)}`,
  );
}

function appendSourceScaffold(scaffold: string[], finding: Result['findings'][number]): void {
  if (finding.docsSource?.file) {
    scaffold.push(`source: ${formatDocsSourceLocation(finding.docsSource)}`);
  } else if (finding.appSource?.file) {
    scaffold.push(`source: ${formatAppSourceLocation(finding.appSource)}`);
  } else if (finding.appSource && finding.appSource.candidates.length > 0) {
    scaffold.push(`candidates: ${finding.appSource.candidates.join(', ')}`);
  }
}

export function projectSelfCheck(
  result: Result,
  config?: UsablConfig,
): {
  advisoryExitCode: 0;
  verdict: Result['verdict'];
  message: string;
} {
  // Self-check is advisory by design so mid-task probes cannot bypass the stop-hook gate.
  const safe = scrubResult(result);
  const verdictLabel = safe.verdict === null ? 'IDLE' : VERDICT_LABELS[safe.verdict];

  // The trusted engine scaffold stays outside the frame: the verdict line, the advisory line,
  // the summary, the Rule line, the source location, and the Not evaluated header. Every
  // page-derived piece goes inside one frame with a short inline label. The pieces are bounded
  // and the assembled block is never cut, so the single closing marker cannot be lost.
  const scaffold = [
    `usabl self-check: ${verdictLabel}`,
    'advisory: the stop hook is the gate.',
    safe.summary,
  ];
  const pieces: string[] = [];
  const budget = resolveNoiseBudgetDefault(config);
  const view = applyNoiseBudget(safe.findings, budget);

  if (view.groups.length === 1 && !view.collapsed) {
    const group = view.groups[0]!;
    const ruleLabel =
      group.count > 1 ? `${group.rule} (×${group.count})` : group.rule;
    scaffold.push(`Rule: ${ruleLabel}`);
    appendSourceScaffold(scaffold, group.representative);
    pieces.push(`experience: ${group.representative.whatUserExperiences}`);
    pieces.push(`fix: ${fixOrAbsence(group.representative)}`);
  } else if (view.groups.length > 0) {
    scaffold.push('Barriers:');
    for (const group of view.groups) {
      scaffold.push(`- ${formatCollapsedGroupHeadline(group)}`);
      appendSourceScaffold(scaffold, group.representative);
      pieces.push(`experience (${group.rule}): ${group.representative.whatUserExperiences}`);
      pieces.push(`fix (${group.rule}): ${fixOrAbsence(group.representative)}`);
    }
    if (view.showAllHint !== null) {
      scaffold.push(view.showAllHint);
    }
  }

  const gapPieces = notEvaluatedPieces(safe);
  if (gapPieces.length > 0) {
    scaffold.push('Not evaluated:');
    pieces.push(...gapPieces);
  }

  const message =
    pieces.length === 0
      ? scaffold.join('\n')
      : [...scaffold, frameUntrustedBlock(pieces)].join('\n');

  return {
    advisoryExitCode: 0,
    verdict: safe.verdict,
    message,
  };
}

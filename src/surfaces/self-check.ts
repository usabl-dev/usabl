/**
 * Advisory self-check projection for an existing Result.
 * This unit reports a human-readable snapshot only.
 * It must never gate, mint a verdict, or return a process-failing exit code.
 */
import type { Result } from '../contracts/index.js';
import {
  discloseGaps,
  fixOrAbsence,
  gapDetail,
  gapHeadline,
  pickBarrier,
} from '../output/disclosure.js';
import { formatAppSourceLocation, formatDocsSourceLocation } from '../output/source-location.js';
import { frameUntrusted, scrubResult } from './scrub.js';

const VERDICT_LABELS: Record<NonNullable<Result['verdict']>, string> = {
  verified: 'VERIFIED',
  regression: 'REGRESSION',
  not_covered: 'NOT COVERED',
  approval_required: 'APPROVAL REQUIRED',
};

/**
 * Every piece of page-derived text goes through here, one call per item. Self check is read
 * mid-task by the same kind of reader as the stop hook, so it frames rather than neutralizes,
 * and it frames per item for the same reason: a forged close marker in page text can then only
 * escape the item that carried it.
 */
function framed(text: string): string {
  return frameUntrusted(text);
}

/** What the run did not examine, one entry per gap state, bounded by the number of states. */
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

export function projectSelfCheck(result: Result): {
  advisoryExitCode: 0;
  verdict: Result['verdict'];
  message: string;
} {
  // Self-check is advisory by design so mid-task probes cannot bypass the stop-hook gate.
  const safe = scrubResult(result);
  const verdictLabel = safe.verdict === null ? 'IDLE' : VERDICT_LABELS[safe.verdict];
  const lines = [`usabl self-check: ${verdictLabel}`, 'advisory: the stop hook is the gate.', safe.summary];
  const finding = pickBarrier(safe.findings);
  if (finding !== null) {
    lines.push(`Rule: ${finding.rule}`);
    lines.push(framed(finding.whatUserExperiences));
    if (finding.docsSource?.file) {
      lines.push(`source: ${formatDocsSourceLocation(finding.docsSource)}`);
    } else if (finding.appSource?.file) {
      lines.push(`source: ${formatAppSourceLocation(finding.appSource)}`);
    }
    lines.push('Fix:');
    lines.push(framed(fixOrAbsence(finding)));
  }
  lines.push(...notEvaluatedLines(safe));
  return {
    advisoryExitCode: 0,
    verdict: safe.verdict,
    message: lines.join('\n'),
  };
}

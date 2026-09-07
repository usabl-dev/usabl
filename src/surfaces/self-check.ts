/**
 * Advisory self-check projection for an existing Result.
 * This unit reports a human-readable snapshot only.
 * It must never gate, mint a verdict, or return a process-failing exit code.
 */
import type { Result, UsablConfig } from '../contracts/index.js';
import { SELF_CHECK_MESSAGE_BUDGET, assembleBoundedMessage, boundField } from '../output/bounded-text.js';
import {
  discloseGaps,
  fixOrAbsence,
  gapDetail,
  gapHeadline,
} from '../output/disclosure.js';
import {
  applyNoiseBudget,
  formatCollapsedGroupHeadlineWithoutScreen,
  resolveNoiseBudgetDefault,
  type CollapsedFindingGroup,
} from '../output/noise-budget.js';
import { formatAppSourceLocation, formatDocsSourceLocation } from '../output/source-location.js';
import { describeVerdict, formatVerdictWord } from '../output/verdict-line.js';
import { frameUntrustedBlock, scrubResult } from './scrub.js';

/**
 * What the run did not examine, one entry per gap state, bounded by the number of states.
 *
 * Each entry pairs the trusted gap headline with the page-derived detail, so the model can map
 * a reason to its state inside the single frame the caller builds.
 */
function notEvaluatedPieces(result: Result): string[] {
  const disclosures = discloseGaps(result.coverage.gaps);
  // Ref and reason are bounded on their own, before the headline with its count is attached.
  return disclosures.map((disclosure) => {
    const detail = gapDetail({
      ...disclosure,
      ref: boundField(disclosure.ref, 'gapRef'),
      reason: boundField(disclosure.reason, 'gapReason'),
    });
    return `- ${gapHeadline(disclosure)}: ${detail}`;
  });
}

// The source location goes inside the untrusted frame with the other page-derived pieces. A
// renderer-tier mapping reads the file and line from attributes on the rendered page, so a page
// can choose that text, and anything a page can choose must never be printed as trusted
// scaffold. It is bounded too: a candidate list has no upper bound of its own.
function pushSourcePieces(
  pieces: string[],
  finding: Result['findings'][number],
  label: string,
): void {
  if (finding.docsSource?.file) {
    pieces.push(`source${label}: ${boundField(formatDocsSourceLocation(finding.docsSource), 'source')}`);
  } else if (finding.appSource?.file) {
    pieces.push(`source${label}: ${boundField(formatAppSourceLocation(finding.appSource), 'source')}`);
  } else if (finding.appSource && finding.appSource.candidates.length > 0) {
    pieces.push(
      `candidates${label}: ${boundField(finding.appSource.candidates.join(', '), 'candidates')}`,
    );
  }
}

// A group whose free-text fields are bounded for printing. The count is left alone. Layer and
// rule are printed outside the frame because the first-party providers author them; the screen
// id can come from a route literal in the application, so it is printed inside the frame.
function boundGroup(group: CollapsedFindingGroup): CollapsedFindingGroup {
  return {
    ...group,
    screenId: boundField(group.screenId, 'screenId'),
    layer: boundField(group.layer, 'layer'),
    rule: boundField(group.rule, 'rule'),
  };
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
  // The same verdict words the terminal and the stop hook use, so a failed run reads as RUN
  // FAILED here too and never as IDLE.
  const verdict = describeVerdict(safe);

  // The trusted engine scaffold stays outside the frame: the verdict line, the advisory line,
  // the meaning, the Rule line, and the Not evaluated header, all engine constants. Every
  // free-text piece goes inside one frame with a short inline label: the gate's summary first,
  // because a summary can name a route-derived screen id or carry a raw error message and so is
  // not always engine-only, then the source location, the experiences, the fixes, and the gap
  // details. The frame label is being generalized to say untrusted text rather than page text,
  // so engine free text sits there correctly. The pieces are bounded per field, the whole
  // message is bounded by dropping whole pieces, never the summary, and the frame is rebuilt
  // around what survives, so the single closing marker cannot be lost.
  const scaffold = [
    `usabl self-check: ${formatVerdictWord(verdict)}`,
    'advisory: the stop hook is the gate.',
    verdict.meaning,
  ];
  const keep = scaffold.length;
  const pieces: string[] = [`engine summary: ${boundField(safe.summary, 'summary')}`];
  const budget = resolveNoiseBudgetDefault(config);
  // Gating (deterministic) findings only, as the stop hook does. Advisory findings never gate, so
  // the assistant reading this snapshot to reach verified does not act on them here.
  const gating = safe.findings.filter((finding) => finding.evidenceClass === 'deterministic');
  const view = applyNoiseBudget(gating, budget, 'gating findings');

  // Each free-text field is bounded on its own before it is labelled and framed, so a huge page
  // string shortens with a visible note and the counts around it stay whole.
  if (view.groups.length === 1 && !view.collapsed) {
    const group = boundGroup(view.groups[0]!);
    const ruleLabel =
      group.count > 1 ? `${group.rule} (×${group.count})` : group.rule;
    scaffold.push(`Rule: ${ruleLabel}`);
    pushSourcePieces(pieces, group.representative, '');
    pieces.push(`experience: ${boundField(group.representative.whatUserExperiences, 'experience')}`);
    pieces.push(`fix: ${boundField(fixOrAbsence(group.representative), 'fix')}`);
  } else if (view.groups.length > 0) {
    scaffold.push('Barriers:');
    for (const raw of view.groups) {
      const group = boundGroup(raw);
      scaffold.push(`- ${formatCollapsedGroupHeadlineWithoutScreen(group)}`);
      pieces.push(`screen (${group.rule}): ${group.screenId}`);
      pushSourcePieces(pieces, group.representative, ` (${group.rule})`);
      pieces.push(
        `experience (${group.rule}): ${boundField(group.representative.whatUserExperiences, 'experience')}`,
      );
      pieces.push(`fix (${group.rule}): ${boundField(fixOrAbsence(group.representative), 'fix')}`);
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

  // This surface prints a source or candidates piece per group on top of what the stop hook
  // prints, so it has its own budget. Nothing is dropped at the default noise budget.
  const message = assembleBoundedMessage({
    scaffold,
    keep,
    pieces,
    keepPieces: 1,
    frame: frameUntrustedBlock,
    budget: SELF_CHECK_MESSAGE_BUDGET,
  });

  return {
    advisoryExitCode: 0,
    verdict: safe.verdict,
    message,
  };
}

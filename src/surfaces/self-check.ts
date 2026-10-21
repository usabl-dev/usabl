/**
 * Advisory self-check projection for an existing Result.
 * This unit reports a human-readable snapshot only.
 * It must never gate, mint a verdict, or return a process-failing exit code.
 */
import type { Result, UsablConfig } from '../contracts/index.js';
import { SELF_CHECK_MESSAGE_BUDGET, assembleBoundedMessage, boundField } from '../output/bounded-text.js';
import { fixOrAbsence, isBlockingBarrier } from '../output/disclosure.js';
import {
  applyNoiseBudget,
  formatCollapsedGroupStatus,
  resolveNoiseBudgetDefault,
  type CollapsedFindingGroup,
} from '../output/noise-budget.js';
import { formatAppSourceLocation, formatDocsSourceLocation } from '../output/source-location.js';
import { describeVerdict, formatVerdictWord } from '../output/verdict-line.js';
import { guardedFileLines, notEvaluatedPieces } from './model-pieces.js';
import { frameUntrustedBlock, scrubResult } from './scrub.js';

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

// A group whose free-text fields are bounded for printing. The count is left alone. The screen
// id, the layer, and the rule are carried by the Result, so all three are printed inside the
// frame, whoever authored them, the same rule the stop hook and the pull request comment follow.
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
  // the meaning, the guarded-file lines when policy files changed, and the Barrier lines with
  // their checked status, severity, and count. Every value the Result carried goes inside one
  // frame with a short inline label: the gate's summary first, because a summary can name a
  // route-derived screen id or carry a raw error message and so is not always engine-only, then
  // the guarded file paths, then for each barrier a "barrier" line naming its rule, the source
  // location, the experience, and the fix, and last the "Not evaluated:" label directly above the
  // gap details, so a reader never meets that label and then reads about a button. The frame label says untrusted text, not page text, so
  // engine free text sits there correctly. The pieces are bounded per field, the whole message
  // is bounded by dropping whole pieces, never the summary, and the frame is rebuilt around what
  // survives, so the single closing marker cannot be lost.
  //
  // No next step is printed here. This surface is advisory; the stop hook owns the decision and
  // the instruction that goes with it.
  const scaffold = [
    `usabl self-check: ${formatVerdictWord(verdict)}`,
    'advisory: the stop hook is the gate.',
    verdict.meaning,
  ];
  const pieces: string[] = [`engine summary: ${boundField(safe.summary, 'summary')}`];
  if (safe.verdict === 'approval_required') {
    // Which files, how the state clears, and the one lever a person has: the same account the
    // stop hook gives, from the same unit, so the assistant reads one story on both surfaces.
    const guarded = guardedFileLines(safe);
    scaffold.push(...guarded.scaffold);
    if (guarded.piece !== null) {
      pieces.push(guarded.piece);
    }
  }
  const keep = scaffold.length;
  const keepPieces = pieces.length;
  const budget = resolveNoiseBudgetDefault(config);
  // The same barriers the stop hook shows, by the gate's own blocking rule, so the snapshot an
  // assistant reads on the way to verified names the same work the stop hook will ask for.
  const gating = safe.findings.filter(isBlockingBarrier);
  const view = applyNoiseBudget(gating, budget, 'gating findings');

  // Each free-text field is bounded on its own before it is labelled and framed, so a huge page
  // string shortens with a visible note and the counts around it stay whole.
  // The scaffold line for a group carries only its checked status, severity, and count. Groups
  // are numbered, so a scaffold line and its pieces match by number, and no label is built from a
  // value the Result carried.
  if (view.groups.length === 1 && !view.collapsed) {
    const group = boundGroup(view.groups[0]!);
    scaffold.push(`Barrier: ${formatCollapsedGroupStatus(group)}`);
    pieces.push(`barrier: ${group.rule}`);
    pushSourcePieces(pieces, group.representative, '');
    pieces.push(`experience: ${boundField(group.representative.whatUserExperiences, 'experience')}`);
    pieces.push(`fix: ${boundField(fixOrAbsence(group.representative), 'fix')}`);
  } else if (view.groups.length > 0) {
    scaffold.push('Barriers:');
    view.groups.forEach((raw, index) => {
      const group = boundGroup(raw);
      const n = index + 1;
      scaffold.push(`- barrier ${n}: ${formatCollapsedGroupStatus(group)}`);
      pieces.push(`barrier ${n}: ${group.layer}/${group.rule}`);
      pieces.push(`screen (${n}): ${group.screenId}`);
      pushSourcePieces(pieces, group.representative, ` (${n})`);
      pieces.push(`experience (${n}): ${boundField(group.representative.whatUserExperiences, 'experience')}`);
      pieces.push(`fix (${n}): ${boundField(fixOrAbsence(group.representative), 'fix')}`);
    });
    if (view.showAllHint !== null) {
      scaffold.push(view.showAllHint);
    }
  }

  const gapPieces = notEvaluatedPieces(safe);
  if (gapPieces.length > 0) {
    pieces.push('Not evaluated:', ...gapPieces);
  }

  // This surface prints a source or candidates piece per group on top of what the stop hook
  // prints, so it has its own budget. Nothing is dropped at the default noise budget.
  const message = assembleBoundedMessage({
    scaffold,
    keep,
    pieces,
    keepPieces,
    frame: frameUntrustedBlock,
    budget: SELF_CHECK_MESSAGE_BUDGET,
  });

  return {
    advisoryExitCode: 0,
    verdict: safe.verdict,
    message,
  };
}

/**
 * Terminal summary projection for Result.
 * This unit renders operator-facing text only.
 * It must never mutate Result, mint a verdict, or pass through untrusted text unsanitized.
 */
import type { Finding, Result } from '../contracts/index.js';
import { neutralize } from '../primitives/neutralize.js';
import {
  discloseGaps,
  fixOrAbsence,
  gapDetail,
  gapHeadline,
  isBlockingBarrier,
} from './disclosure.js';
import { boundField } from './bounded-text.js';
import { formatAppSourceLocation, formatDocsSourceLocation } from './source-location.js';
import { describeVerdict, formatVerdictLine } from './verdict-line.js';

/**
 * Page and scanner strings are untrusted at terminal egress.
 * Neutralize only the printed projection so the stored Result stays raw and receipt checks stay honest.
 * Gap refs and gap reasons are page-derived too, so they go through this helper before printing.
 *
 * This surface neutralizes rather than frames. Its reader is a person at a terminal, and the
 * untrusted-text frame exists to stop a language model reading page text as instructions.
 */
export function neutralizePrintedText(text: string): string {
  return neutralize(text);
}

/**
 * What the run did not examine, one line per gap state.
 *
 * A reader told "2 gap(s)" learns a number. A reader told a screen never opened learns something
 * they can act on. Grouping by state rather than listing every gap keeps a pile of unreachable
 * screens from burying a denied capability, which is usabl saying it could not run a check at all.
 * The complete list is always in the JSON projection beside this text.
 *
 * Unresolved files are not counted separately here. Both coverage planners record an unmapped file
 * in unresolvedFiles and disclose that same file as a gap, so listing both would report one
 * problem twice.
 */
function renderNotEvaluated(result: Result): string[] {
  const gaps = result.coverage.gaps;
  if (gaps.length === 0) {
    return [];
  }

  // Ref and reason are neutralized and bounded on their own, so the headline's count is never
  // cut and a provider error the size of a stack trace prints its first lines and a note.
  return [
    `  not evaluated: ${gaps.length} gap(s)`,
    ...discloseGaps(gaps).map((disclosure) => {
      const detail = gapDetail({
        ...disclosure,
        ref: boundField(neutralizePrintedText(disclosure.ref), 'gapRef'),
        reason: boundField(neutralizePrintedText(disclosure.reason), 'gapReason'),
      });
      return `    ${gapHeadline(disclosure)} ${detail}`;
    }),
  ];
}

/**
 * The two lists this surface prints, and the line that introduces each one.
 *
 * A blocking barrier is a reason the gate could not call this run verified, so it is work. Every
 * other deterministic finding the run carried is accepted debt: the gate already accounted for it,
 * a run carrying it can still be verified, and printing it under a heading that says "barriers"
 * with a "fix:" line told a developer to go and fix something that blocks nothing. That is what the
 * evidence floor promises not to do, so the two are printed apart and named for what they are.
 *
 * Membership comes from the shared predicate, so this surface cannot answer "does it block" any
 * differently from the gate or from the other surfaces.
 *
 * The recorded list holds carried and waived findings. Fixed findings are left out, as they always
 * were: a finding the run proved gone is not something a developer can act on. Advisory evidence is
 * left out too, again as before, because this surface has never listed it.
 */
const BLOCKING_HEADING = 'barriers that block this run';
const RECORDED_HEADING = 'recorded, not blocking';
const RECORDED_NOTE = 'usabl already recorded these. They do not block this run.';
const HEADROOM_HEADING = 'floor ahead of this run';
const HEADROOM_NOTE = 'Barriers were fixed here. Run usabl floor prune to re-arm the floor.';

/** The label on a fix line. Under a barrier it is work. Under recorded debt it is a choice. */
const BLOCKING_FIX_LABEL = 'fix';
const RECORDED_FIX_LABEL = 'fix when you choose to';

function isRecordedNotBlocking(finding: Finding): boolean {
  if (finding.evidenceClass !== 'deterministic' || isBlockingBarrier(finding)) {
    return false;
  }
  return finding.status === 'carried' || finding.status === 'waived';
}

/**
 * The floor entries this run found the floor ahead of, printed under the recorded group because
 * that is the group they are about.
 *
 * This never blocks and never changes the verdict, so it appears under a verified run and must not
 * read like a failure. It reads as maintenance with a command attached. Each line names the screen,
 * the rule, both numbers, and nothing page-derived: screen ids and rule names are usabl's and the
 * operator's own words, and an element key would carry a neutralized accessible name into a
 * surface that also feeds a pull request comment.
 *
 * Why an operator should care about a line that blocks nothing: while the floor claims more
 * barriers at an identity than are present, a new barrier can take the difference and be recorded
 * as debt somebody already accepted. Re-arming closes that. Blocking instead was rejected because
 * these counts track how many rows a live table renders.
 */
function renderFloorHeadroom(result: Result): string[] {
  if (result.floorHeadroom.length === 0) {
    return [];
  }
  const lines = [
    `  ${HEADROOM_HEADING}: ${result.floorHeadroom.length} entr${result.floorHeadroom.length === 1 ? 'y' : 'ies'}`,
    `    ${HEADROOM_NOTE}`,
  ];
  for (const entry of result.floorHeadroom) {
    lines.push(
      `    ${boundField(neutralizePrintedText(entry.screenId), 'screenId')} - ` +
      `${boundField(neutralizePrintedText(entry.rule), 'rule')}: ` +
      `floor records ${entry.recorded}, this run saw ${entry.observed}`,
    );
  }
  return lines;
}

/**
 * One finding, with its source mapping and its fix.
 *
 * Every free-text field is neutralized, then bounded on its own, so a huge page string prints its
 * start and a visible note. Status and severity are usabl's own words and stay whole.
 */
function renderFinding(finding: Finding, fixLabel: string): string[] {
  const lines: string[] = [];
  const rule = boundField(neutralizePrintedText(finding.rule), 'rule');
  const screenId = boundField(neutralizePrintedText(finding.screenId), 'screenId');
  const layer = boundField(neutralizePrintedText(finding.layer), 'layer');
  const whatUserExperiences = boundField(
    neutralizePrintedText(finding.whatUserExperiences),
    'experience',
  );
  // A docs finding carries a source mapping and a syntax-aware fix; prefer both so the author
  // reads their own markup, not the DOM. App findings have no docsSource and keep finding.fix.
  const source = finding.docsSource;
  const appSource = finding.appSource;
  const fix = boundField(neutralizePrintedText(fixOrAbsence(finding)), 'fix');
  lines.push(
    `    [${finding.status}] ${screenId} · ${layer}/${rule} (${finding.severity}): ${whatUserExperiences}`,
  );
  if (source && source.file) {
    lines.push(`        source: ${boundField(neutralizePrintedText(formatDocsSourceLocation(source)), 'source')}`);
    if (source.candidates.length > 1) {
      lines.push(
        `        candidates: ${boundField(source.candidates.map(neutralizePrintedText).join(', '), 'candidates')}`,
      );
    }
  } else if (appSource) {
    if (appSource.file) {
      lines.push(`        source: ${boundField(neutralizePrintedText(formatAppSourceLocation(appSource)), 'source')}`);
    }
    if (
      appSource.candidates.length > 0 &&
      (appSource.file === null || appSource.candidates.length > 1)
    ) {
      lines.push(
        `        candidates: ${boundField(appSource.candidates.map(neutralizePrintedText).join(', '), 'candidates')}`,
      );
    }
  }
  // Always printed. Most axe rules carry no curated note, so an absent fix is a common and
  // real state, and a missing line reads as a rendering bug rather than as an absence.
  lines.push(`        ${fixLabel}: ${fix}`);
  return lines;
}

/**
 * Human CLI projection of a Result. Never re-derives findings or a verdict.
 *
 * The first line is the verdict: a symbol, the verdict word, and the exit code. The second is
 * one sentence saying what that means for the change. Everything else is labelled and indented
 * under it. `verdict === null` prints NO VERDICT: IDLE (nothing to check) or NO VERDICT: RUN
 * FAILED (exit 4), never NOT COVERED and never anything that reads as a pass.
 *
 * Data lines (findings, gaps, paths) are printed whole rather than wrapped to 80 columns, so an
 * operator can grep the output for a rule, a URL, or a file and copy a line in one piece. The
 * lines usabl authors itself stay within 80 columns.
 */
export function formatSummary(result: Result): string {
  const lines: string[] = [];
  const verdict = describeVerdict(result);
  lines.push(`usabl: ${formatVerdictLine(verdict)}`);
  lines.push(`  ${verdict.meaning}`);
  if (verdict.exitCode === 4) {
    lines.push('  next: run usabl check again, or check the change by hand.');
  }
  // The gate's own summary, with its counts, printed whole and labelled so it reads as the
  // gate's sentence rather than as a second verdict.
  lines.push(`  gate summary: ${boundField(neutralizePrintedText(result.summary), 'summary')}`);

  // Blocking work first, always. Recorded debt after it, never above it: a reader who has
  // something to fix must not have to scroll past a list of things that are not blocking to
  // find it.
  const blocking = result.findings.filter(isBlockingBarrier);
  const recorded = result.findings.filter(isRecordedNotBlocking);
  if (blocking.length > 0) {
    lines.push(`  ${BLOCKING_HEADING}: ${blocking.length} finding(s)`);
    for (const finding of blocking) {
      lines.push(...renderFinding(finding, BLOCKING_FIX_LABEL));
    }
  }
  if (recorded.length > 0) {
    lines.push(`  ${RECORDED_HEADING}: ${recorded.length} finding(s)`);
    lines.push(`    ${RECORDED_NOTE}`);
    for (const finding of recorded) {
      lines.push(...renderFinding(finding, RECORDED_FIX_LABEL));
    }
  }
  lines.push(...renderFloorHeadroom(result));
  lines.push(...renderNotEvaluated(result));
  if (result.dirtyGuardedPaths.length > 0) {
    lines.push(`  guarded paths changed: ${result.dirtyGuardedPaths.join(', ')}`);
  }
  if (result.verdict === 'approval_required') {
    // result.summary already states the accessibility verdict on the headline line, so a
    // second verdict word here would repeat it. Print only the exit code, which the summary
    // does not carry.
    lines.push(`  accessibility exit code: ${result.accessibilityExitCode}`);
  }
  if (result.paidDownCount > 0) {
    lines.push(`  floor debt resolved: ${result.paidDownCount} (run usabl floor prune to re-arm)`);
  }
  if (result.receipt) {
    lines.push(`  receipt: sourceTree ${result.receipt.sourceTree} @ ${result.receipt.mintedAt}`);
  }
  return lines.join('\n');
}

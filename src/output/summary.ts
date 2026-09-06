/**
 * Terminal summary projection for Result.
 * This unit renders operator-facing text only.
 * It must never mutate Result, mint a verdict, or pass through untrusted text unsanitized.
 */
import type { Result } from '../contracts/index.js';
import { neutralize } from '../primitives/neutralize.js';
import { discloseGaps, fixOrAbsence, gapDetail, gapHeadline } from './disclosure.js';
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

  return [
    `  not evaluated: ${gaps.length} gap(s)`,
    ...discloseGaps(gaps).map(
      (disclosure) =>
        `    ${gapHeadline(disclosure)} ${neutralizePrintedText(gapDetail(disclosure))}`,
    ),
  ];
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
  lines.push(`  gate summary: ${neutralizePrintedText(result.summary)}`);

  const gating = result.findings.filter(
    (f) => f.evidenceClass === 'deterministic' && (f.status === 'new' || f.status === 'carried'),
  );
  if (gating.length > 0) {
    lines.push('  barriers:');
  }
  for (const f of gating) {
    const rule = neutralizePrintedText(f.rule);
    const whatUserExperiences = neutralizePrintedText(f.whatUserExperiences);
    // A docs finding carries a source mapping and a syntax-aware fix; prefer both so the author
    // reads their own markup, not the DOM. App findings have no docsSource and keep finding.fix.
    const source = f.docsSource;
    const appSource = f.appSource;
    const fix = neutralizePrintedText(fixOrAbsence(f));
    lines.push(
      `    [${f.status}] ${f.screenId} · ${f.layer}/${rule} (${f.severity}): ${whatUserExperiences}`,
    );
    if (source && source.file) {
      lines.push(`        source: ${neutralizePrintedText(formatDocsSourceLocation(source))}`);
      if (source.candidates.length > 1) {
        lines.push(`        candidates: ${source.candidates.map(neutralizePrintedText).join(', ')}`);
      }
    } else if (appSource) {
      if (appSource.file) {
        lines.push(`        source: ${neutralizePrintedText(formatAppSourceLocation(appSource))}`);
      }
      if (
        appSource.candidates.length > 0 &&
        (appSource.file === null || appSource.candidates.length > 1)
      ) {
        lines.push(`        candidates: ${appSource.candidates.map(neutralizePrintedText).join(', ')}`);
      }
    }
    // Always printed. Most axe rules carry no curated note, so an absent fix is a common and
    // real state, and a missing line reads as a rendering bug rather than as an absence.
    lines.push(`        fix: ${fix}`);
  }
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

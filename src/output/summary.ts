/**
 * Terminal summary projection for Result.
 * This unit renders operator-facing text only.
 * It must never mutate Result, mint a verdict, or pass through untrusted text unsanitized.
 */
import type { DocsSourceMapping, Result } from '../contracts/index.js';
import { neutralize } from '../primitives/neutralize.js';

/**
 * CLI summary output for a Result.
 * It must never re-derive findings, mint verdicts, or mutate raw Result data.
 */
const HEADLINE: Record<string, string> = {
  verified: 'VERIFIED',
  regression: 'REGRESSION',
  not_covered: 'NOT COVERED',
  approval_required: 'APPROVAL REQUIRED',
};

/**
 * Page and scanner strings are untrusted at terminal egress.
 * Neutralize only the printed projection so the stored Result stays raw and receipt checks stay honest.
 * When gap.reason or finding.why is printed in the future, route it through this helper too.
 */
export function neutralizePrintedText(text: string): string {
  return neutralize(text);
}

/**
 * The source location line for a docs finding: the file plus the author's construct when known,
 * the file plus the exact line when the renderer supplied one, otherwise the file alone. Kept raw
 * here; the caller neutralizes before printing.
 */
function sourceLocation(source: DocsSourceMapping): string {
  const file = source.file ?? '';
  if (source.construct !== null) {
    return `${file} -> ${source.construct}`;
  }
  if (source.line !== null) {
    return `${file}:${source.line}`;
  }
  return file;
}

/**
 * Human CLI projection of a Result. Never re-derives findings or a verdict.
 * `verdict === null` prints IDLE (nothing to check), not NOT COVERED.
 */
export function formatSummary(result: Result): string {
  const lines: string[] = [];
  // Idle and a failed run both leave verdict null, and they are opposite facts: idle means there
  // was nothing to prove, exit 4 means there was something and the run could not prove it. The
  // headline reads the exit code so a crash, or a run that never saw the application, cannot be
  // mistaken for a quiet pass.
  const head =
    result.exitCode === 4
      ? 'FAILED'
      : result.verdict === null
        ? 'IDLE'
        : HEADLINE[result.verdict] ?? result.verdict;
  lines.push(`usabl: ${head} - ${result.summary}`);

  const gating = result.findings.filter(
    (f) => f.evidenceClass === 'deterministic' && (f.status === 'new' || f.status === 'carried'),
  );
  for (const f of gating) {
    const rule = neutralizePrintedText(f.rule);
    const whatUserExperiences = neutralizePrintedText(f.whatUserExperiences);
    // A docs finding carries a source mapping and a syntax-aware fix; prefer both so the author
    // reads their own markup, not the DOM. App findings have no docsSource and keep finding.fix.
    const source = f.docsSource;
    const fix = neutralizePrintedText(source ? source.fix : f.fix);
    lines.push(
      `  [${f.status}] ${f.screenId} · ${f.layer}/${rule} (${f.severity}) - ${whatUserExperiences}`,
    );
    if (source && source.file) {
      lines.push(`      source: ${neutralizePrintedText(sourceLocation(source))}`);
      if (source.candidates.length > 1) {
        lines.push(`      candidates: ${source.candidates.map(neutralizePrintedText).join(', ')}`);
      }
    }
    if (fix) {
      lines.push(`      fix: ${fix}`);
    }
  }
  if (result.dirtyGuardedPaths.length > 0) {
    lines.push(`  guarded paths changed: ${result.dirtyGuardedPaths.join(', ')}`);
  }
  if (result.verdict === 'approval_required') {
    const accessibility =
      result.accessibilityVerdict === null
        ? 'IDLE'
        : (HEADLINE[result.accessibilityVerdict] ?? result.accessibilityVerdict);
    lines.push(`  accessibility ${accessibility} (${result.accessibilityExitCode})`);
  }
  if (result.paidDownCount > 0) {
    lines.push(`  floor debt resolved: ${result.paidDownCount} (run usabl floor prune to re-arm)`);
  }
  if (result.receipt) {
    lines.push(`  receipt: sourceTree ${result.receipt.sourceTree} @ ${result.receipt.mintedAt}`);
  }
  return lines.join('\n');
}

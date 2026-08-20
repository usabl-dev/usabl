import type { Result } from '../contracts/index.js';
import { neutralize } from '../primitives/neutralize.js';

const HEADLINE: Record<string, string> = {
  verified: 'VERIFIED',
  regression: 'REGRESSION',
  not_covered: 'NOT COVERED',
  approval_required: 'APPROVAL REQUIRED',
};

/**
 * Human CLI projection of a Result. Never re-derives findings or a verdict.
 * `verdict === null` prints IDLE (nothing to check), not NOT COVERED.
 */
export function formatSummary(result: Result): string {
  const lines: string[] = [];
  const head = result.verdict === null ? 'IDLE' : HEADLINE[result.verdict] ?? result.verdict;
  lines.push(`usabl: ${head} - ${result.summary}`);

  const gating = result.findings.filter(
    (f) => f.evidenceClass === 'deterministic' && (f.status === 'new' || f.status === 'carried'),
  );
  for (const f of gating) {
    // whatUserExperiences and fix are page-derived once live scanning is wired, so this terminal egress
    // neutralizes only the printed projection. Result stays raw so receipts remain honest about findings.
    const whatUserExperiences = neutralize(f.whatUserExperiences);
    const fix = neutralize(f.fix);
    lines.push(
      `  [${f.status}] ${f.screenId} · ${f.layer}/${f.rule} (${f.severity}) - ${whatUserExperiences}`,
    );
    if (fix) {
      lines.push(`      fix: ${fix}`);
    }
  }
  if (result.dirtyGuardedPaths.length > 0) {
    lines.push(`  guarded paths changed: ${result.dirtyGuardedPaths.join(', ')}`);
  }
  if (result.receipt) {
    lines.push(`  receipt: sourceTree ${result.receipt.sourceTree} @ ${result.receipt.mintedAt}`);
  }
  return lines.join('\n');
}

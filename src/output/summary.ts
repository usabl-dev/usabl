import type { Result } from '../contracts/index.js';

const HEADLINE: Record<string, string> = {
  verified: 'VERIFIED',
  regression: 'REGRESSION',
  not_covered: 'NOT COVERED',
  approval_required: 'APPROVAL REQUIRED',
};

/** Pure projection of a Result to a human summary. Never re-derives findings. */
export function formatSummary(result: Result): string {
  const lines: string[] = [];
  const head = result.verdict === null ? 'IDLE' : HEADLINE[result.verdict] ?? result.verdict;
  lines.push(`usabl: ${head} - ${result.summary}`);

  const gating = result.findings.filter(
    (f) => f.evidenceClass === 'deterministic' && (f.status === 'new' || f.status === 'carried'),
  );
  for (const f of gating) {
    lines.push(
      `  [${f.status}] ${f.screenId} · ${f.layer}/${f.rule} (${f.severity}) - ${f.whatUserExperiences}`,
    );
    if (f.fix) {
      lines.push(`      fix: ${f.fix}`);
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

import type { Result } from '../contracts/index.js';

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
    // whatUserExperiences and fix are page-derived in live scanning, so they are untrusted at this egress.
    // neutralize() must wrap both fields here before that scanner lane is wired.
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

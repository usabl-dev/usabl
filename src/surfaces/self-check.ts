/**
 * Advisory self-check projection for an existing Result.
 * This unit reports a human-readable snapshot only.
 * It must never gate, mint a verdict, or return a process-failing exit code.
 */
import type { Finding, Result } from '../contracts/index.js';
import { frameUntrusted, scrubResult } from './scrub.js';

const VERDICT_LABELS: Record<NonNullable<Result['verdict']>, string> = {
  verified: 'VERIFIED',
  regression: 'REGRESSION',
  not_covered: 'NOT COVERED',
  approval_required: 'APPROVAL REQUIRED',
};

function pickFinding(findings: Finding[]): Finding | null {
  const prioritized = findings.find((finding) => finding.status === 'new' || finding.status === 'carried');
  return prioritized ?? findings[0] ?? null;
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
  const finding = pickFinding(safe.findings);
  if (finding !== null) {
    lines.push(frameUntrusted(finding.whatUserExperiences));
  }
  return {
    advisoryExitCode: 0,
    verdict: safe.verdict,
    message: lines.join('\n'),
  };
}

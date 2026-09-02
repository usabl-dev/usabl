/**
 * Non-gating conformance projection for reporting surfaces.
 * This unit summarizes an already-gated Result.
 * It must never recompute findings, collapse into one score, or mint a verdict.
 */
import type { ConformanceSummary, Finding, Result } from '../contracts/index.js';
import { notEvaluatedCounts } from '../coverage/completeness.js';

const isDeterministic = (f: Finding): boolean => f.evidenceClass === 'deterministic';

/**
 * Read-only three-bucket view of an already-gated Result.
 * Never re-derives findings. Never a single score. Never hides not-evaluated.
 * `blocked` is true only for new deterministic failures. Judged findings never block.
 * Echoes `result.verdict`: the gate remains the authority.
 */
export function computeConformance(result: Result): ConformanceSummary {
  const det = result.findings.filter(isDeterministic);
  const newFailures = det.filter((f) => f.status === 'new' && f.confidence === 'fail').length;
  return {
    verdict: result.verdict,
    blocked: newFailures > 0,
    deterministic: {
      newFailures,
      carried: det.filter((f) => f.status === 'carried').length,
      waived: det.filter((f) => f.status === 'waived').length,
      fixed: det.filter((f) => f.status === 'fixed').length,
    },
    judged: {
      modelJudgment: result.findings.filter((f) => f.evidenceClass === 'model-judgment').length,
      preview: result.findings.filter((f) => f.evidenceClass === 'preview').length,
    },
    notEvaluated: notEvaluatedCounts(result.coverage),
  };
}

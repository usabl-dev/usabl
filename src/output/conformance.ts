import type { ConformanceSummary, Finding, Result } from '../contracts/index.js';

const isDeterministic = (f: Finding): boolean => f.evidenceClass === 'deterministic';

/**
 * Pure projection of Result into the non-gating conformance summary (Fork 1b).
 * Never re-derives findings, never collapses to a single score, never hides
 * not-evaluated. The gate verdict (result.verdict) remains the authority.
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
    notEvaluated: { unresolvedFiles: result.coverage.unresolvedFiles.length, gaps: result.coverage.gaps.length },
  };
}

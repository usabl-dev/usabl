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
 * Echoes `result.verdict` and `result.exitCode`: the gate remains the authority.
 *
 * The counts have to agree with what the surfaces list beside them. `new` counts every new
 * deterministic finding, which is the set the gate blocks on and the set the pull request comment
 * and the terminal print underneath. Counting only the failing ones put "new 1" above a list of
 * three, and `blocked` recomputed from those same failures said "no" under a NOT COVERED heading.
 * The failing and unconfirmed split is still reported, next to the headline rather than as it.
 */
export function computeConformance(result: Result): ConformanceSummary {
  const det = result.findings.filter(isDeterministic);
  const isNew = det.filter((f) => f.status === 'new');
  return {
    verdict: result.verdict,
    // The gate already decided this. Exit 0 is verified or idle; every other code stops the work,
    // including a crash, which is not a pass and must never read as one.
    blocked: result.exitCode !== 0,
    deterministic: {
      new: isNew.length,
      newFailing: isNew.filter((f) => f.confidence === 'fail').length,
      newUnconfirmed: isNew.filter((f) => f.confidence === 'unverified').length,
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

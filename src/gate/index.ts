import type { Draft, Finding, GateInput, GateOutput } from '../contracts/index.js';
import { sortBy } from '../primitives/sortKey.js';
import { computeIdentity } from '../primitives/identity.js';

const GATES = (c: Draft['evidenceClass']): boolean => c === 'deterministic';

export function gate(input: GateInput): GateOutput {
  // 1. Guard first: any diverged guarded path forces approval_required; harness never runs.
  if (input.guardDivergedPaths.length > 0) {
    return {
      verdict: 'approval_required',
      findings: [],
      exitCode: 2,
      summary: `approval required: ${input.guardDivergedPaths.length} guarded path(s) changed`,
    };
  }
  // 2. Coverage: nothing to check is an idle non-verdict.
  if (input.coverage.nothingToCheck) {
    return { verdict: null, findings: [], exitCode: 0, summary: 'nothing to check (no UI-touching files)' };
  }
  // 3. Build findings (identity + differential + waivers added in Tasks 8-9).
  const findings = buildFindings(input);

  // 4. Verdict is computed only from deterministic, still-active findings.
  const gating = findings.filter((f) => GATES(f.evidenceClass) && f.status !== 'waived' && f.status !== 'fixed');
  const hasNewFail = gating.some((f) => f.confidence === 'fail' && f.status === 'new');
  const hasUnverified = gating.some((f) => f.confidence === 'unverified') || input.coverage.unresolvedFiles.length > 0;

  if (hasNewFail) return { verdict: 'regression', findings, exitCode: 1, summary: verdictSummary('regression', gating) };
  if (hasUnverified) {
    return { verdict: 'not_covered', findings, exitCode: 3, summary: verdictSummary('not_covered', gating) };
  }
  return { verdict: 'verified', findings, exitCode: 0, summary: verdictSummary('verified', gating) };
}

/** Task 8 replaces the body with identity + dedup + differential; Task 9 adds waivers. */
export function buildFindings(input: GateInput): Finding[] {
  const findings = input.drafts.map((draft): Finding => {
    const { elementKey, identityBasis } = computeIdentity(draft);
    return { ...draft, elementKey, identityBasis, status: 'new' };
  });
  return sortBy(findings, findingKey);
}

export function findingKey(f: Finding): string {
  return `${f.screenId}|${f.layer}|${f.rule}|${f.elementKey ?? 'count'}`;
}

function verdictSummary(verdict: string, gating: Finding[]): string {
  return `${verdict}: ${gating.length} gating finding(s)`;
}

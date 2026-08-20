import type { Draft, Finding, FloorEntry, GateInput, GateOutput, Waiver } from '../contracts/index.js';
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

/** Prefer pf over axe when both fire on the same defect. */
function preferLayer(a: Finding, b: Finding): Finding {
  if (a.layer === 'pf') return a;
  if (b.layer === 'pf') return b;
  return a;
}

/** Layer-independent key for cross-layer dedup and floor comparison. */
function identityKey(f: { screenId: string; rule: string; elementKey: string | null }): string {
  return `${f.screenId}|${f.rule}|${f.elementKey ?? 'count'}`;
}

// Apply active, unexpired waivers to already-differential findings.
function applyWaivers(findings: Finding[], waivers: Waiver[], now: string): Finding[] {
  const active = waivers.filter((w) => w.expires > now);
  return findings.map((f) => {
    if (f.status === 'fixed') return f;
    const matched = active.some((w) =>
      w.rule === f.rule && w.surface === f.screenId && (w.scope === '*' || w.scope === f.elementKey),
    );
    return matched ? { ...f, status: 'waived' } : f;
  });
}

export function buildFindings(input: GateInput): Finding[] {
  // 1. Draft -> Finding with identity.
  const raw = input.drafts.map((draft: Draft): Finding => {
    const { elementKey, identityBasis } = computeIdentity(draft);
    return { ...draft, elementKey, identityBasis, status: 'new' };
  });

  // 2. Dedup across layers by identity, preferring the pf why/fix.
  const byIdentity = new Map<string, Finding>();
  const countByGroup = new Map<string, number>();
  for (const f of raw) {
    const key = identityKey(f);
    if (f.identityBasis === 'count') {
      countByGroup.set(key, (countByGroup.get(key) ?? 0) + 1);
    }
    const existing = byIdentity.get(key);
    byIdentity.set(key, existing ? preferLayer(existing, f) : f);
  }

  // 3. Differential vs the evidence floor.
  const floorByKey = new Map<string, FloorEntry>();
  for (const e of input.floor.entries) floorByKey.set(identityKey(e), e);

  const findings: Finding[] = [];
  for (const [key, f] of byIdentity) {
    const floor = floorByKey.get(key);
    if (!floor) { findings.push({ ...f, status: 'new' }); continue; }
    if (f.identityBasis === 'count') {
      const now = countByGroup.get(key) ?? 0;
      findings.push({ ...f, status: now > floor.count ? 'new' : 'carried' });
    } else {
      findings.push({ ...f, status: 'carried' });
    }
  }

  // 4. Floor entries with no current match are fixed (surfaced, never gate).
  for (const [key, e] of floorByKey) {
    if (!byIdentity.has(key)) {
      findings.push({
        rule: e.rule, layer: e.layer, severity: 'minor', evidenceClass: 'deterministic',
        screenId: e.screenId, elementPath: '', elementName: null, role: null,
        whatUserExperiences: '', why: '', fix: '', evidence: {}, confidence: 'fail',
        elementKey: e.elementKey, identityBasis: e.identityBasis, status: 'fixed',
      });
    }
  }

  return sortBy(applyWaivers(findings, input.waivers, input.now), findingKey);
}

export function findingKey(f: Finding): string {
  return `${f.screenId}|${f.layer}|${f.rule}|${f.elementKey ?? 'count'}`;
}

function verdictSummary(verdict: string, gating: Finding[]): string {
  return `${verdict}: ${gating.length} gating finding(s)`;
}

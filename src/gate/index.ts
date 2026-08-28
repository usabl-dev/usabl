/**
 * The gate is the only module that constructs a verdict.
 * Providers return Drafts. Overlays, CLI, and CI project the Result. They never mint one.
 *
 * Only `evidenceClass === 'deterministic'` participates in the verdict.
 * Preview and model-judgment findings stay on the Result for humans; they cannot
 * produce `verified` or a receipt.
 *
 * Idle (`verdict: null`, exit 0) means nothing UI-touching changed.
 * `not_covered` means there was something to prove and we could not.
 * Dirty guarded paths are `approval_required` and still carry accessibility findings.
 */
import type { AccessibilityExitCode, AccessibilityVerdict, Draft, EvidenceFacts, Finding, FloorEntry, GateInput, GateOutput, Waiver } from '../contracts/index.js';
import { sortBy } from '../primitives/sortKey.js';
import { computeIdentity } from '../primitives/identity.js';

const GATES = (c: Draft['evidenceClass']): boolean => c === 'deterministic';

export function gate(input: GateInput): GateOutput {
  const accessibility = accessibilityOutcome(input);
  if (input.guardDivergedPaths.length > 0) {
    // Policy divergence is a human approval problem, not an accessibility skip.
    // Keep the scan outcome so CI can AND a second check without GitHub inside the gate.
    return {
      verdict: 'approval_required',
      findings: accessibility.findings,
      exitCode: 2,
      summary: `approval required: ${input.guardDivergedPaths.length} guarded path(s) changed`,
      accessibilityVerdict: accessibility.verdict,
      accessibilityExitCode: accessibility.exitCode,
    };
  }
  return {
    ...accessibility,
    accessibilityVerdict: accessibility.verdict,
    accessibilityExitCode: accessibility.exitCode,
  };
}

function accessibilityOutcome(input: GateInput): {
  verdict: AccessibilityVerdict | null;
  findings: Finding[];
  exitCode: AccessibilityExitCode;
  summary: string;
} {
  // Idle is not a fifth verdict and not not_covered.
  if (input.coverage.nothingToCheck) {
    return { verdict: null, findings: [], exitCode: 0, summary: 'nothing to check (no UI-touching files)' };
  }

  const findings = buildFindings(input);

  // Waived and fixed stay visible. They do not block and they do not mint verified.
  const gating = findings.filter((f) => GATES(f.evidenceClass) && f.status !== 'waived' && f.status !== 'fixed');
  const hasNewFail = gating.some((f) => f.confidence === 'fail' && f.status === 'new');
  const hasUnverified =
    gating.some((f) => f.confidence === 'unverified') ||
    input.coverage.unresolvedFiles.length > 0 ||
    input.coverage.gaps.length > 0;

  if (hasNewFail) {
    return { verdict: 'regression', findings, exitCode: 1, summary: verdictSummary('regression', gating) };
  }
  if (hasUnverified) {
    return { verdict: 'not_covered', findings, exitCode: 3, summary: verdictSummary('not_covered', gating) };
  }
  return { verdict: 'verified', findings, exitCode: 0, summary: verdictSummary('verified', gating) };
}

/** Prefer PatternFly why/fix when axe and pf fire on the same identity. */
function mergeEvidence(winner: EvidenceFacts, loser: EvidenceFacts): EvidenceFacts {
  // Winner fields win on collision. Loser extras stay so a pf why/fix does not
  // erase the axe observation that identified the same control.
  return {
    ...loser,
    ...winner,
    ...(loser.state !== undefined || winner.state !== undefined
      ? { state: { ...loser.state, ...winner.state } }
      : {}),
    ...(loser.extra !== undefined || winner.extra !== undefined
      ? { extra: { ...loser.extra, ...winner.extra } }
      : {}),
  };
}

function preferLayer(a: Finding, b: Finding): Finding {
  const winner = a.layer === 'pf' ? a : b.layer === 'pf' ? b : a;
  const loser = winner === a ? b : a;
  return { ...winner, evidence: mergeEvidence(winner.evidence, loser.evidence) };
}

/** Cross-layer / floor key. Layer is omitted so axe and pf can collapse. */
function identityKey(f: { screenId: string; rule: string; elementKey: string | null }): string {
  return `${f.screenId}|${f.rule}|${f.elementKey ?? 'count'}`;
}

/** Expired waivers are inert. Fixed findings are never rewritten to waived. */
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
  const raw = input.drafts.map((draft: Draft): Finding => {
    const { elementKey, identityBasis } = computeIdentity(draft);
    return { ...draft, elementKey, identityBasis, status: 'new' };
  });

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

  const floorByKey = new Map<string, FloorEntry>();
  for (const e of input.floor.entries) floorByKey.set(identityKey(e), e);

  const findings: Finding[] = [];
  for (const [key, f] of byIdentity) {
    const floor = floorByKey.get(key);
    if (!floor) { findings.push({ ...f, status: 'new' }); continue; }
    // Count-based rules have no per-element key. A higher count than the floor is a regression.
    if (f.identityBasis === 'count') {
      const now = countByGroup.get(key) ?? 0;
      findings.push({ ...f, status: now > floor.count ? 'new' : 'carried' });
    } else {
      findings.push({ ...f, status: 'carried' });
    }
  }

  // Disappeared identities are `fixed`: shown, never gating, never a silent pass.
  for (const [key, e] of floorByKey) {
    if (!byIdentity.has(key)) {
      findings.push({
        rule: e.rule, layer: e.layer, severity: 'minor', evidenceClass: 'deterministic',
        screenId: e.screenId, elementPath: '', elementName: null, role: null,
        // Surfaces render these fields. Blank strings look like a missing finding,
        // not a paid-down identity the operator still needs to prune from the floor.
        whatUserExperiences: 'This previously accepted finding is no longer present on the surface.',
        why: 'The identity is on the evidence floor and was not observed in this run.',
        fix: 'Remove this identity from the evidence floor after review so a reintroduced barrier can gate as new.',
        evidence: {}, confidence: 'fail',
        elementKey: e.elementKey, identityBasis: e.identityBasis, status: 'fixed',
      });
    }
  }

  return sortBy(applyWaivers(findings, input.waivers, input.now), findingKey);
}

export function findingKey(f: Finding): string {
  return `${f.screenId}|${f.layer}|${f.rule}|${f.elementKey ?? 'count'}`;
}

function verdictSummary(verdict: AccessibilityVerdict, gating: Finding[]): string {
  return `${verdict}: ${gating.length} gating finding(s)`;
}

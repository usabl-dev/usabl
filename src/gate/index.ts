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
import type { AccessibilityExitCode, AccessibilityVerdict, Coverage, Draft, EvidenceFacts, Finding, FloorEntry, GateInput, GateOutput, Waiver } from '../contracts/index.js';
import { coverageIncomplete, decideAccessibilityVerdict, notEvaluatedCounts } from '../coverage/completeness.js';
import { sortBy } from '../primitives/sortKey.js';
import { computeIdentity, identityKey } from '../primitives/identity.js';

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
      summary: approvalSummary(input.guardDivergedPaths.length, accessibility),
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

  const blocking = findings.filter(BLOCKS);
  const hasNewFail = blocking.some((f) => f.confidence === 'fail');
  const hasUnverified =
    blocking.some((f) => f.confidence === 'unverified') || coverageIncomplete(input.coverage);

  const { verdict, exitCode } = decideAccessibilityVerdict({
    hasBlockingFailure: hasNewFail,
    hasUnverified,
  });
  return {
    verdict,
    findings,
    exitCode,
    summary: verdictSummary(verdict, blocking.length, findings.filter(RECORDED).length, input.coverage),
  };
}

/**
 * Whether a finding is a reason this run cannot be verified: deterministic evidence, new against
 * the evidence floor, and either failing or unverified.
 *
 * Uncertainty is tested on status exactly as failure is. A carried unverified finding is on the
 * evidence floor, and the floor accepted that identity whatever the confidence, so it does not
 * block, the same way a carried failure does not. Blocking on carried uncertainty would hold
 * every real application at not_covered forever, because a large UI always has some results the
 * checker declines to judge and no amount of work clears them.
 *
 * Growth at a floored identity is not lost by that. buildFindings tallies every draft that lands
 * on an identity and marks the collapsed finding `new` when the tally is above the count the
 * floor recorded, so a second barrier hiding behind one accepted entry comes back as new and
 * blocks here. The recorded count is what protects that case, not the confidence test.
 *
 * Waived and fixed need no test of their own. A status is one of new, carried, fixed and waived,
 * so requiring `new` already excludes all three of the others.
 *
 * Written once and read by both the verdict and the summary, so the count the gate prints and the
 * answer the gate reached cannot come from different sets. `isBlockingBarrier` in
 * `src/output/disclosure.ts` holds the same rule for the surfaces, pinned against this one by a
 * test that drives the gate.
 */
const BLOCKS = (f: Finding): boolean =>
  GATES(f.evidenceClass) &&
  f.status === 'new' &&
  (f.confidence === 'fail' || f.confidence === 'unverified');

/**
 * Deterministic debt already accounted for: carried by the evidence floor, or covered by a live
 * waiver. Visible on every surface, never blocking.
 *
 * Fixed is left out, matching the terminal report and the inspector panel. A finding the run
 * proved gone is not debt the reader is still carrying.
 */
const RECORDED = (f: Finding): boolean =>
  GATES(f.evidenceClass) && (f.status === 'carried' || f.status === 'waived');

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

  // Count every key, not only count-basis keys. Several barriers can neutralize to the same
  // name or structural key and then collapse into one finding here. Without a tally, three
  // barriers behind one floored identity read as the single barrier the floor accepted.
  const byIdentity = new Map<string, Finding>();
  const countByGroup = new Map<string, number>();
  for (const f of raw) {
    const key = identityKey(f);
    countByGroup.set(key, (countByGroup.get(key) ?? 0) + 1);
    const existing = byIdentity.get(key);
    byIdentity.set(key, existing ? preferLayer(existing, f) : f);
  }

  const floorByKey = new Map<string, FloorEntry>();
  for (const e of input.floor.entries) floorByKey.set(identityKey(e), e);

  // Version 1 floors wrote a literal 1 for name and structural entries, so those counts are
  // not observations. Comparing them would report untouched surfaces as regressions. run()
  // discloses a coverage gap for that case so the verdict cannot be a green we cannot support.
  const countsAreObserved = (basis: Finding['identityBasis']): boolean =>
    basis === 'count' || input.floor.version >= 2;

  const findings: Finding[] = [];
  for (const [key, f] of byIdentity) {
    const floor = floorByKey.get(key);
    if (!floor) { findings.push({ ...f, status: 'new' }); continue; }
    if (countsAreObserved(f.identityBasis)) {
      // More barriers at this identity than the floor accepted means new debt.
      // Fewer is progress, never a regression, so it stays carried.
      const now = countByGroup.get(key) ?? 0;
      findings.push({ ...f, status: now > floor.count ? 'new' : 'carried' });
    } else {
      findings.push({ ...f, status: 'carried' });
    }
  }

  // Disappeared identities are `fixed`: shown, never gating, never a silent pass. But only when the
  // screen was actually measured this run. A floored identity is absent from the drafts either
  // because the barrier is gone or because nobody scanned its screen, and those are opposite facts.
  // cleanlyScannedScreens is the only signal that separates them, so an identity whose screen is not
  // in it is omitted rather than claimed fixed: making no claim about a screen you did not measure is
  // the honest default, and it matches the rule that silence is not evidence. Omitting cannot
  // manufacture a green. A scanned-but-gapped screen already carries its gap into the verdict, and an
  // out-of-scope screen is one the receipt makes no claim about at all, so neither reads as clean.
  // One residual remains, tracked in #186: a screen whose chrome mounts but whose content silently
  // fails to mount has no gap, so it enters cleanlyScannedScreens and a floored identity there is
  // still claimed fixed. Catching a partial render needs a signal this gate does not have; membership
  // in cleanlyScannedScreens is not a guarantee the screen was fully measured, only that nothing
  // flagged it.
  for (const [key, e] of floorByKey) {
    if (byIdentity.has(key)) continue;
    if (!input.cleanlyScannedScreens.has(e.screenId)) continue;
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

  return sortBy(applyWaivers(findings, input.waivers, input.now), findingKey);
}

export function findingKey(f: Finding): string {
  return `${f.screenId}|${f.layer}|${f.rule}|${f.elementKey ?? 'count'}`;
}

/**
 * The approval line, carrying the accessibility outcome it used to discard.
 *
 * The gate already ran the accessibility side before reaching this branch, and already carries its
 * findings, verdict and exit code through. Only the summary was dropped, so a run that diverged
 * policy and also failed to reach some screens said nothing about the second fact. Nobody was
 * misled about why they were blocked, because the guarded path is the block and the line names it.
 * They were left to meet the incomplete coverage on the next run instead.
 *
 * The accessibility half is the untouched accessibility summary, not a second phrasing of it. That
 * keeps one source for the coverage count and gives the line a property worth having: it is the
 * same text the run will print once the approval lands and policy stops diverging.
 *
 * A run with no UI-touching file has no accessibility verdict and no coverage claim, so the clause
 * is omitted rather than filled with "nothing to check". This is the same rule the accessibility
 * summary already follows for a clean run, where inventing "0 gap(s)" would teach the reader to
 * skip the clause on the runs where it carries something.
 */
function approvalSummary(
  divergedPaths: number,
  accessibility: { verdict: AccessibilityVerdict | null; summary: string },
): string {
  const head = `approval required: ${divergedPaths} guarded path(s) changed`;
  if (accessibility.verdict === null) {
    return head;
  }
  return `${head}; accessibility ${accessibility.summary}`;
}

/**
 * The one line an operator is most likely to read, and the only one a model is given on the stop
 * hook and the self check. Every number in it has to mean what the verdict means.
 *
 * It used to count the deterministic findings that were neither waived nor fixed and call them
 * gating. That set holds carried debt, which does not gate, so a verified run carrying an
 * accepted floor read "verified: 29 gating finding(s)" while the panel under it said none of the
 * 29 blocked anything. Two lines on one screen disagreed, and this one is labelled as the gate's
 * own sentence, so it was the one that got believed. The count is now the blocking set, the same
 * set the verdict was decided from, and accepted debt is named separately as recorded.
 *
 * "nothing blocking" rather than "0 blocking finding(s)". A zero is the answer on most runs, and
 * a line that opens with one trains the reader to skip the number on the runs where it is not
 * zero. It also cannot be misread as a verdict: the verdict word is already the first token, and
 * it is the gate's own, so this clause only ever qualifies it.
 *
 * The cause of the verdict is always on the line. A blocked run names either a blocking finding
 * or unseen coverage, so `not_covered: nothing blocking` with nothing after it cannot be built:
 * not_covered with no blocking finding means coverage was incomplete, which adds a clause.
 *
 * The recorded count is appended only when there is debt, and the gap count only when there is a
 * gap, for the same reason: inventing "0 recorded" or "0 gap(s)" on a whole run teaches the
 * reader to skip the clause on the runs where it carries something.
 *
 * Recorded counts carried and waived findings, which is exactly what the terminal report and the
 * inspector panel group under "recorded, not blocking", so the number here and the number there
 * are the same number.
 *
 * Unseen coverage is reported as one number, not two. Unresolved files are not added to the gap
 * count: both coverage planners record an unmapped file in unresolvedFiles and disclose that same
 * file as a gap, so gaps already contains every unresolved file plus the surfaces and checks that
 * failed for other reasons. Adding the two counts would report one unmapped file as two problems.
 * The per-gap breakdown, including which gaps are unmapped files, is already rendered for every
 * gap by the PR comment and the overlay.
 */
function verdictSummary(
  verdict: AccessibilityVerdict,
  blocking: number,
  recorded: number,
  coverage: Coverage,
): string {
  const notEvaluated = notEvaluatedCounts(coverage);
  const clauses = [blocking === 0 ? 'nothing blocking' : `${blocking} blocking finding(s)`];

  if (recorded > 0) {
    clauses.push(`${recorded} recorded`);
  }
  if (notEvaluated.gaps > 0) {
    clauses.push(`${notEvaluated.gaps} gap(s)`);
  } else if (notEvaluated.unresolvedFiles > 0) {
    // Unreachable while every unmapped file is also disclosed as a gap, which is what both
    // planners do today. It is written out rather than assumed so that the guarantee this
    // function owes the operator, that a blocked run always names its cause, does not rest on a
    // rule enforced in another module.
    clauses.push(`${notEvaluated.unresolvedFiles} unmapped file(s)`);
  }
  return `${verdict}: ${clauses.join(', ')}`;
}

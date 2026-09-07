/**
 * The gate is the only module that constructs a verdict.
 * Providers return Drafts. Overlays, CLI, and CI project the Result. They never mint one.
 *
 * Only `evidenceClass === 'deterministic'` participates in the verdict.
 * Preview and model-judgment findings stay on the Result for humans. They cannot move the verdict
 * in either direction, so they neither block a run nor stand in the way of one: a verified run
 * with a receipt can and does carry them.
 *
 * Idle (`verdict: null`, exit 0) means nothing UI-touching changed.
 * `not_covered` means there was something to prove and we could not.
 * Dirty guarded paths are `approval_required` and still carry accessibility findings.
 */
import type { AccessibilityExitCode, AccessibilityVerdict, Coverage, CoverageGap, Draft, EvidenceFacts, EvidenceFloor, Finding, FloorEntry, FloorHeadroom, GateInput, GateOutput, Waiver } from '../contracts/index.js';
import { coverageIncomplete, decideAccessibilityVerdict, notEvaluatedCounts } from '../coverage/completeness.js';
import { sortBy } from '../primitives/sortKey.js';
import { computeIdentity, identityKey } from '../primitives/identity.js';
import { canonicalize } from '../primitives/canonical.js';

const GATES = (c: Draft['evidenceClass']): boolean => c === 'deterministic';

// Declared here rather than imported from the baseline module, which imports run(), which imports
// this one. run.ts keeps its own copy for the same reason.
const EVIDENCE_FLOOR_PATH = '.usabl-evidence.json';

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
      // Carried through, not dropped. The accessibility half ran and reached these, and a reader
      // blocked on approval still needs to know the floor needs re-arming before the next run.
      floorGaps: accessibility.floorGaps,
      floorHeadroom: accessibility.floorHeadroom,
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
  floorGaps: CoverageGap[];
  floorHeadroom: FloorHeadroom[];
} {
  // Idle is not a fifth verdict and not not_covered. A run with no UI-touching file measured
  // nothing, so it makes no claim the floor could be stale against and discloses none.
  if (input.coverage.nothingToCheck) {
    return { verdict: null, findings: [], exitCode: 0, summary: 'nothing to check (no UI-touching files)', floorGaps: [], floorHeadroom: [] };
  }

  const { findings, staleIdentities } = differential(input);

  // A floor that predates barrier counting cannot be compared at all, so it is a coverage gap and
  // the run is not covered. Headroom is different and is deliberately not a gap: see floorHeadroom.
  const floorGaps = staleFloorGaps(input.floor);

  // The gate weighs and reports its own gaps. Handing the caller a gap it did not count would let
  // the Result show a gap the summary never mentioned, which is the same line-against-surface
  // contradiction the summary counts exist to avoid.
  const coverage: Coverage =
    floorGaps.length === 0
      ? input.coverage
      : { ...input.coverage, gaps: [...input.coverage.gaps, ...floorGaps] };

  const blocking = findings.filter(BLOCKS);
  const hasNewFail = blocking.some((f) => f.confidence === 'fail');
  const hasUnverified =
    blocking.some((f) => f.confidence === 'unverified') || coverageIncomplete(coverage);

  const { verdict, exitCode } = decideAccessibilityVerdict({
    hasBlockingFailure: hasNewFail,
    hasUnverified,
  });
  return {
    verdict,
    findings,
    exitCode,
    floorGaps,
    floorHeadroom: staleIdentities,
    summary: verdictSummary(
      verdict,
      blocking.length,
      findings.filter(RECORDED).length,
      staleIdentities.length,
      coverage,
    ),
  };
}

/**
 * The disclosure owed when the floor predates count tracking.
 *
 * A version 1 floor recorded a literal 1 for every name and structural entry instead of the
 * barriers it actually saw. Several barriers can neutralize to one of those keys, so the gate
 * cannot tell one accepted barrier from many and cannot compare their counts. Any green against
 * such a floor would be unproven.
 *
 * This lives in the gate, not in `run()`, because `gate()` is exported and CI, the overlay and the
 * page helper can reach it directly. While the check sat in the run path only, the bare exported
 * gate returned verified on a version 1 floor that the full path blocked, so the verdict depended
 * on which door the caller came through. Count-basis entries always carried real counts, so they
 * need no disclosure.
 */
function staleFloorGaps(floor: EvidenceFloor): CoverageGap[] {
  if (floor.version >= 2) return [];
  const collapsible = floor.entries.filter((entry) => entry.identityBasis !== 'count');
  if (collapsible.length === 0) return [];
  return [{
    ref: EVIDENCE_FLOOR_PATH,
    state: 'not-covered',
    reason:
      `${EVIDENCE_FLOOR_PATH} predates count tracking (version 1), so ${collapsible.length} name or ` +
      'structural entr' + (collapsible.length === 1 ? 'y' : 'ies') + ' record a placeholder count of 1 ' +
      'instead of the barriers observed. Several barriers can share one of those identities, so this ' +
      'run cannot compare their counts and cannot prove no new barrier is hiding behind an accepted one. ' +
      'Run "usabl baseline" to regenerate the floor with real counts, then review and merge the diff.',
  }];
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
 * Growth at a floored identity is what catches a barrier hiding behind an accepted one, not the
 * confidence test. buildFindings tallies the deterministic drafts landing on an identity and marks
 * the collapsed finding `new` when the tally rises above the count the floor recorded, and that
 * blocks here.
 *
 * The tally is not a complete guard, and the gap is deliberate rather than overlooked. While the
 * floor is ahead of the application, a new barrier can fill the difference without raising the
 * tally, and a barrier swapped in for one fixed in the same change never moves it at all. Both are
 * counted as carried. usabl discloses the first on every run it can see it (see floorHeadroom) and
 * documents the second, and neither is closed by requiring a status on the confidence test: this
 * hole is open for definite failures in exactly the same way.
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

/**
 * Rank for choosing which of two findings at one identity survives as the representative.
 *
 * Evidence class outranks layer. Deterministic evidence is the only class that gates, so if a
 * preview draft and a deterministic draft land on one identity, the survivor has to be the
 * deterministic one or the collapse quietly disarms the barrier. Ranking by class first also
 * makes the choice independent of the order the drafts arrived in: the old rule compared layer
 * only and fell back to whichever came first, so the same two drafts in the other order produced
 * a different verdict.
 */
const CLASS_RANK: Record<Draft['evidenceClass'], number> = {
  deterministic: 0,
  'human-confirmed': 1,
  'model-judgment': 2,
  preview: 3,
};

/**
 * A total order over the drafts collapsed onto one identity, used to pick the one that represents
 * them. Total, not pairwise: every comparison ends in a decision that does not depend on the order
 * the drafts arrived in, because the last tie-break is the draft's own text.
 *
 * Class first, because only deterministic evidence gates and a surviving preview draft would
 * quietly disarm a barrier. Then the PatternFly layer, whose why and fix are written for the
 * design system and read better than the generic axe wording. Then element path and layer, which
 * decide nothing about the verdict and exist only so the same inputs always render the same way.
 */
const SEVERITY_RANK: Record<Finding['severity'], number> = {
  critical: 0,
  serious: 1,
  moderate: 2,
  minor: 3,
};

/**
 * Everything about a draft that two drafts at one identity can still differ on once class, layer,
 * element path and severity have tied. Canonical, so the key does not depend on the order a
 * provider happened to build the evidence object in.
 */
function tieBreakKey(f: Finding): string {
  return canonicalize([
    f.confidence,
    f.role,
    f.elementName,
    f.whatUserExperiences,
    f.why,
    f.fix,
    f.evidence,
  ]);
}

function byPreference(a: Finding, b: Finding): number {
  const byClass = CLASS_RANK[a.evidenceClass] - CLASS_RANK[b.evidenceClass];
  if (byClass !== 0) return byClass;
  const byLayer = Number(b.layer === 'pf') - Number(a.layer === 'pf');
  if (byLayer !== 0) return byLayer;
  const byPath = a.elementPath.localeCompare(b.elementPath);
  if (byPath !== 0) return byPath;
  const byLayerName = a.layer.localeCompare(b.layer);
  if (byLayerName !== 0) return byLayerName;
  // Worst severity wins the presentation. A reader who sees one row standing for several barriers
  // should see the most serious of them, not whichever the scanner happened to report first.
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;
  // The last resort, and the one that makes the order total. Without it two drafts that tie on
  // every field above but differ in prose, evidence or confidence still collapsed to whichever
  // arrived first, so the finding BYTES moved with arrival order even where the verdict did not.
  // Only drafts identical on every field compared here can tie now, and those are interchangeable.
  return tieBreakKey(a).localeCompare(tieBreakKey(b));
}

/**
 * The confidence the collapsed finding carries, aggregated across the drafts it stands for rather
 * than inherited from whichever one won the presentation tie-break.
 *
 * `fail` dominates `unverified`. That is the verdict priority the engine already documents: a
 * blocking failure outranks missing coverage, because a real barrier is the actionable answer and
 * answering not_covered first would bury it. A definite barrier and an unconfirmed one at the same
 * identity means there is a definite barrier there.
 *
 * Aggregating here is what makes the verdict order independent. The representative's confidence is
 * a verdict input, so while it was inherited, one `fail` draft and one `unverified` draft at one
 * identity produced `regression` in one arrival order and `not_covered` in the other. Only drafts
 * of the winner's own class are aggregated, so advisory evidence can never raise the confidence of
 * a deterministic finding.
 */
function aggregateConfidence(group: Finding[], evidenceClass: Draft['evidenceClass']): Draft['confidence'] {
  const sameClass = group.filter((f) => f.evidenceClass === evidenceClass);
  return sameClass.some((f) => f.confidence === 'fail') ? 'fail' : 'unverified';
}

/**
 * One finding standing for every draft that landed on one identity.
 *
 * The evidence of the drafts that did not win is folded in behind the winner's, so a PatternFly
 * why and fix does not erase the axe observation that identified the same control. Folding runs in
 * sorted order for the same reason the winner is chosen by a total order: the merged evidence must
 * not depend on arrival order either.
 */
function collapse(group: Finding[]): Finding {
  const sorted = [...group].sort(byPreference);
  const winner = sorted[0]!;
  let evidence = winner.evidence;
  for (const loser of sorted.slice(1)) {
    evidence = mergeEvidence(evidence, loser.evidence);
  }
  return { ...winner, evidence, confidence: aggregateConfidence(group, winner.evidenceClass) };
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

/** The findings for a run, plus the floored identities whose recorded count this run cannot account for. */
interface Differential {
  findings: Finding[];
  staleIdentities: FloorHeadroom[];
}

export function buildFindings(input: GateInput): Finding[] {
  return differential(input).findings;
}

function differential(input: GateInput): Differential {
  const raw = input.drafts.map((draft: Draft): Finding => {
    const { elementKey, identityBasis } = computeIdentity(draft);
    return { ...draft, elementKey, identityBasis, status: 'new' };
  });

  // Count every key, not only count-basis keys. Several barriers can neutralize to the same
  // name or structural key and then collapse into one finding here. Without a tally, three
  // barriers behind one floored identity read as the single barrier the floor accepted.
  //
  // Only deterministic drafts are counted, because only deterministic drafts are what
  // `usabl baseline` wrote the floor counts from. Counting every class here compared this run's
  // mixed tally against a deterministic-only floor, so one preview draft sharing an identity with
  // a deterministic one read as growth and reported a barrier that was not there.
  const groups = new Map<string, Finding[]>();
  const countByGroup = new Map<string, number>();
  for (const f of raw) {
    const key = identityKey(f);
    if (GATES(f.evidenceClass)) {
      countByGroup.set(key, (countByGroup.get(key) ?? 0) + 1);
    }
    const group = groups.get(key);
    if (group) group.push(f);
    else groups.set(key, [f]);
  }
  const byIdentity = new Map<string, Finding>();
  for (const [key, group] of groups) byIdentity.set(key, collapse(group));

  const floorByKey = new Map<string, FloorEntry>();
  for (const e of input.floor.entries) floorByKey.set(identityKey(e), e);

  // Version 1 floors wrote a literal 1 for name and structural entries, so those counts are
  // not observations. Comparing them would report untouched surfaces as regressions. The gate
  // discloses a coverage gap for that case so the verdict cannot be a green we cannot support.
  const countsAreObserved = (basis: Finding['identityBasis']): boolean =>
    basis === 'count' || input.floor.version >= 2;

  const findings: Finding[] = [];
  const staleIdentities: Differential['staleIdentities'] = [];
  for (const [key, f] of byIdentity) {
    const floor = floorByKey.get(key);
    if (!floor) { findings.push({ ...f, status: 'new' }); continue; }
    if (countsAreObserved(f.identityBasis)) {
      const now = countByGroup.get(key) ?? 0;
      // More barriers at this identity than the floor accepted means new debt.
      findings.push({ ...f, status: now > floor.count ? 'new' : 'carried' });
      // Fewer than the floor accepted is headroom, and headroom is DISCLOSED, NEVER BLOCKING.
      //
      // What headroom is: the recorded count is a high-water mark that only `usabl floor prune`
      // lowers, so once a barrier at a floored identity is fixed and the entry is not re-armed,
      // the difference is room a new barrier can take. It arrives, fills the freed slot, keeps the
      // tally at or under the recorded count, and is marked carried. That is a real hole, it is
      // open until the floor is re-armed, and usabl cannot close it by counting.
      //
      // Why this does not block, decided against a real brownfield floor: several collapsed
      // identities on that application count icon buttons in table rows, one entry standing at 15.
      // The count therefore tracks how many rows the live application happens to render, and a
      // jobs list or a user list changes size on its own. Blocking on "below the recorded count"
      // would fail an unchanged codebase whenever a list came back one row shorter, the operator
      // would prune, and the next run with one more row would report a new barrier. That is
      // flapping on dynamic content, and it would make the ratchet unusable on exactly the kind of
      // application it exists for. A verdict that moves with row counts is worse than a disclosed
      // hole, because nobody keeps reading a gate that cries wolf.
      //
      // So the finding stays carried, the verdict is untouched, and every surface says the floor
      // is ahead of what is here and names the command that re-arms it. The operator, not the row
      // count, decides when to close it.
      if (now < floor.count) {
        staleIdentities.push({ screenId: f.screenId, rule: f.rule, recorded: floor.count, observed: now });
      }
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
    // Absent is the largest headroom there is, not the absence of headroom. The entry still holds
    // capacity for every barrier it recorded until a prune removes it, so a barrier arriving here
    // before that lands at a tally at or under the accepted count and is marked carried, which is
    // the exact window this disclosure exists for. Reporting it only when at least one barrier
    // survived would have hidden the widest case.
    if (countsAreObserved(e.identityBasis) && e.count > 0) {
      staleIdentities.push({ screenId: e.screenId, rule: e.rule, recorded: e.count, observed: 0 });
    }
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

  return {
    findings: sortBy(applyWaivers(findings, input.waivers, input.now), findingKey),
    staleIdentities: sortBy(staleIdentities, (s) => `${s.screenId}|${s.rule}`),
  };
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
  headroom: number,
  coverage: Coverage,
): string {
  const notEvaluated = notEvaluatedCounts(coverage);
  const clauses = [blocking === 0 ? 'nothing blocking' : `${blocking} blocking finding(s)`];

  if (recorded > 0) {
    clauses.push(`${recorded} recorded`);
  }
  // Named as a relation, not as work. "To re-arm" would presume the barriers were fixed, and this
  // count cannot tell that from a table rendering fewer rows today. "Ahead of this run" is what was
  // actually observed, and it matches the heading the terminal prints. It is neither a barrier nor
  // a gap and it does not move the verdict. It appears on a verified run, which is the point: that
  // is when the floor drifts ahead of the application and nothing else would say so.
  if (headroom > 0) {
    clauses.push(`${headroom} floor entr${headroom === 1 ? 'y' : 'ies'} ahead of this run`);
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

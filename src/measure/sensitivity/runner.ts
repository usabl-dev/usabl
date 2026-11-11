/**
 * The sensitivity runner: for one catalog entry on one screen, scan the page clean, scan it again
 * with the entry's mutation, and say whether the real checks and the real gate caught the defect.
 *
 * Both scans go through the real check runner. Both results go through the real gate(), as a
 * library call: the clean scan once against an empty floor, and the mutated scan against a floor
 * made from what the clean scan found, so only what the mutation added can be new. The outcome is
 * read from what the gate returned. This unit decides no verdict, mints no receipt, and writes
 * nothing; its result is a measurement of the engine, not a judgment of a screen.
 */
import type {
  CheckRunner,
  Coverage,
  EvidenceFloor,
  FloorEntry,
  Finding,
  GateOutput,
  ProfileName,
  RequirementBundle,
  ScreenScan,
} from '../../contracts/index.js';
import { markUnseenScreens } from '../../coverage/unseen.js';
import { deterministicCountsByIdentity, findingKey, gate, renderEvidenceOf } from '../../gate/index.js';
import { computeIdentity, identityKey } from '../../primitives/identity.js';
import type { CatalogEntry, ReportedOn } from './catalog.js';
import type { MutatingBrowser } from './browser.js';
import type { AppliedEdit, ElementPlace } from './edits.js';
import { ruleMatches } from './rules.js';

export type SensitivityOutcome =
  | 'caught'
  | 'caught by another rule'
  | 'missed'
  | 'preview only'
  | 'not applicable'
  | 'unreadable';

export const SENSITIVITY_OUTCOMES: readonly SensitivityOutcome[] = [
  'caught',
  'caught by another rule',
  'missed',
  'preview only',
  'not applicable',
  'unreadable',
];

export interface SensitivityScreen {
  id: string;
  url: string;
  profile?: ProfileName;
}

export interface EntryMeasurement {
  entry: string;
  screen: string;
  outcome: SensitivityOutcome;
  // The rules that reported the defect: the expected ones for caught, the others otherwise. Empty
  // when nothing new was reported.
  rules: string[];
  // Why, for every outcome other than caught. For a catch it is null, or a note when the change did
  // not hold to the end of the scan. Engine words, and rule ids and screen ids.
  reason: string | null;
}

export interface SensitivityRunnerDeps {
  checkRunner: CheckRunner;
  browser: MutatingBrowser;
  requirements: RequirementBundle;
  // Set when the design requirements could not be loaded, with the reason. An entry that needs a
  // requirement is then unreadable: an empty bundle would read as a screen with no requirement.
  requirementsError?: string | null;
  // The gate reads a time for waiver expiry. No waiver is passed, so it decides nothing here.
  now: string;
}

// The gate's current floor version: it keys a control in a keyed table row per row.
const FLOOR_VERSION = 3;

function coverageOf(scan: ScreenScan): Coverage {
  return {
    changedFiles: [],
    affected: [{ screenId: scan.screenId, url: scan.url, provenance: 'manual' }],
    unresolvedFiles: [],
    gaps: scan.gaps,
    nothingToCheck: false,
  };
}

function gateScan(scan: ScreenScan, floor: EvidenceFloor, now: string): GateOutput {
  return gate({
    coverage: coverageOf(scan),
    guardDivergedPaths: [],
    drafts: scan.drafts,
    floor,
    waivers: [],
    now,
    cleanlyScannedScreens: new Set(scan.gaps.length === 0 ? [scan.screenId] : []),
    renderEvidence: renderEvidenceOf([scan]),
  });
}

/**
 * The floor that accepts everything the clean scan found, at the counts it found. The identities
 * and the chosen representative come from the gate's own findings; the counts come from the gate's
 * own tally. So the mutated scan's new findings are exactly what the gate calls new against it.
 */
function floorFrom(clean: ScreenScan, gated: GateOutput): EvidenceFloor {
  const counts = deterministicCountsByIdentity(clean.drafts);
  const entries: FloorEntry[] = gated.findings
    .filter((finding) => finding.evidenceClass === 'deterministic' && finding.status === 'new')
    .map((finding) => ({
      screenId: finding.screenId,
      layer: finding.layer,
      rule: finding.rule,
      elementKey: finding.elementKey,
      identityBasis: finding.identityBasis,
      count: counts.get(identityKey(finding)) ?? 1,
    }));
  return { version: FLOOR_VERSION, entries };
}

/** The element paths of the scan's deterministic drafts, by the identity the gate gives them. */
function draftPathsByIdentity(scan: ScreenScan): Map<string, string[]> {
  const paths = new Map<string, string[]>();
  for (const draft of scan.drafts) {
    if (draft.evidenceClass !== 'deterministic') continue;
    const key = identityKey({ screenId: draft.screenId, rule: draft.rule, elementKey: computeIdentity(draft).elementKey });
    paths.set(key, [...(paths.get(key) ?? []), draft.elementPath]);
  }
  return paths;
}

function rulePathKey(rule: string, elementPath: string): string {
  return JSON.stringify([rule, elementPath]);
}

/** Each rule and element path the scan's deterministic drafts report. */
function rulePathPairs(scan: ScreenScan): Set<string> {
  return new Set(
    scan.drafts.filter((draft) => draft.evidenceClass === 'deterministic').map((draft) => rulePathKey(draft.rule, draft.elementPath)),
  );
}

function seen(scan: ScreenScan): ScreenScan {
  return markUnseenScreens([scan]).screens[0] ?? scan;
}

function gapReasons(scan: ScreenScan): string {
  return scan.gaps.map((gap) => gap.reason).join(' ');
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

const PLACES_FOR: Readonly<Record<ReportedOn, readonly ElementPlace[]>> = {
  target: ['target'],
  'inside-target': ['target', 'inside'],
  'around-target': ['target', 'around'],
  screen: ['target', 'inside', 'around', 'elsewhere', 'unresolved'],
};

function expectedText(entry: CatalogEntry): string {
  return entry.expectedRules.length === 0 ? 'no shipped rule claims this defect' : `expected ${entry.expectedRules.join(' or ')}`;
}

/** Why a screen cannot carry this entry's defect at all, before anything is loaded. */
export function precondition(entry: CatalogEntry, screen: SensitivityScreen, requirements: RequirementBundle): string | null {
  const needs = entry.needs;
  if (needs?.profile === 'docs' && screen.profile !== 'docs') {
    return 'the defect is checked on documentation pages, and this screen is not one';
  }
  // An unapproved requirement gives only preview drafts, which no gate reads, so its defect could
  // never be caught. Only approved requirements count.
  if (needs?.requirement === 'flow') {
    const has = requirements.requirements.some(
      (requirement) =>
        requirement.approved &&
        requirement.surface === screen.id &&
        requirement.assertion.type === 'flow' &&
        requirement.assertion.expectedAnnouncement !== undefined,
    );
    if (!has) return 'no approved flow requirement with an expected announcement names this screen';
  }
  if (needs?.requirement === 'voice') {
    const has = requirements.requirements.some(
      (requirement) =>
        requirement.approved &&
        requirement.surface === screen.id &&
        requirement.assertion.type === 'voice' &&
        requirement.assertion.obligations.some((obligation) => obligation.mustAnnounce),
    );
    if (!has) return 'no approved voice requirement that must hear a live region names this screen';
  }
  return null;
}

function result(entry: CatalogEntry, screen: SensitivityScreen, outcome: SensitivityOutcome, rules: string[], reason: string | null): EntryMeasurement {
  return { entry: entry.id, screen: screen.id, outcome, rules, reason };
}

export async function measureEntry(
  deps: SensitivityRunnerDeps,
  entry: CatalogEntry,
  screen: SensitivityScreen,
): Promise<EntryMeasurement> {
  if (entry.needs?.requirement !== undefined && typeof deps.requirementsError === 'string') {
    return result(
      entry,
      screen,
      'unreadable',
      [],
      `the design requirements could not be loaded, so this entry cannot be measured: ${deps.requirementsError}`,
    );
  }
  const unmet = precondition(entry, screen, deps.requirements);
  if (unmet !== null) {
    return result(entry, screen, 'not applicable', [], unmet);
  }

  const target = { id: screen.id, url: screen.url, ...(screen.profile === undefined ? {} : { profile: screen.profile }) };
  const clean = seen(await deps.checkRunner.scan(target));
  if (clean.gaps.length > 0) {
    return result(entry, screen, 'unreadable', [], `the clean scan had a coverage gap, so it proves nothing: ${gapReasons(clean)}`);
  }

  const armed = deps.browser.arm(entry.mutation);
  try {
    const mutated = seen(await deps.checkRunner.scan(target));
    if (mutated.gaps.length > 0) {
      return result(entry, screen, 'unreadable', [], `the mutated scan had a coverage gap, so it proves nothing: ${gapReasons(mutated)}`);
    }
    const record = armed.record();
    if (record.kind === 'no-target') {
      return result(entry, screen, 'not applicable', [], record.reason);
    }
    if (record.kind !== 'applied') {
      return result(entry, screen, 'unreadable', [], `the mutation was not made: ${record.reason}`);
    }
    // A defect the clean page already had on the target cannot be made new, so the gate would carry
    // it, and the entry would read as missed when nothing was missed.
    const targets = new Set(record.targets);
    const alreadyThere = clean.drafts.some(
      (draft) => targets.has(draft.elementPath) && entry.expectedRules.some((pattern) => ruleMatches(pattern, draft.rule)),
    );
    if (alreadyThere) {
      return result(entry, screen, 'not applicable', [], 'the defect was already on this element before the edit');
    }
    // Read the change back on the page the checks left, after the last provider. A change the page
    // undid, or got around, means the checks may never have seen the defect, so a miss proves
    // nothing. A catch stands: a definite failure where the entry says it reports, new in the mutated
    // scan, was measured while the defect was there.
    const check = await record.edit.check();
    const decided = await decide(deps, entry, screen, clean, mutated, record, check.held ? check.note : null);
    if (check.held) {
      return decided;
    }
    if (decided.outcome === 'caught' || decided.outcome === 'caught by another rule') {
      const note = `the checks reported the defect, then the change did not hold to the end of the scan: ${check.reason}`;
      return { ...decided, reason: decided.reason === null ? note : `${decided.reason}; ${note}` };
    }
    return result(entry, screen, 'unreadable', [], `the change did not hold through the scan, so it proves nothing: ${check.reason}`);
  } finally {
    await armed.release();
  }
}

/** The outcome read from the two scans and the gate, before the second read of the change. */
async function decide(
  deps: SensitivityRunnerDeps,
  entry: CatalogEntry,
  screen: SensitivityScreen,
  clean: ScreenScan,
  mutated: ScreenScan,
  record: { edit: AppliedEdit },
  missNote: string | null,
): Promise<EntryMeasurement> {
  const cleanGate = gateScan(clean, { version: FLOOR_VERSION, entries: [] }, deps.now);
  const mutatedGate = gateScan(mutated, floorFrom(clean, cleanGate), deps.now);

  const gatedNew: Finding[] =
    mutatedGate.accessibilityVerdict === 'verified'
      ? []
      : mutatedGate.findings.filter((finding) => finding.status === 'new' && finding.evidenceClass === 'deterministic');
  if (mutatedGate.accessibilityVerdict !== 'verified' && gatedNew.length === 0) {
    return result(entry, screen, 'unreadable', [], `the gate did not verify the mutated scan, and no new finding explains it: ${mutatedGate.summary}`);
  }

  // The gate keys a finding by the element's name first. An edit that changes a name moves a
  // finding the clean page already had to a new identity, so the floor cannot absorb it. A new
  // finding whose every draft has a rule and element path the clean scan already reported is that
  // old finding, and it is dropped.
  const pathsByIdentity = draftPathsByIdentity(mutated);
  const pathsBehind = (finding: Finding): string[] => pathsByIdentity.get(identityKey(finding)) ?? [finding.elementPath];
  const cleanPairs = rulePathPairs(clean);
  const newGating = gatedNew.filter((finding) => !pathsBehind(finding).every((path) => cleanPairs.has(rulePathKey(finding.rule, path))));

  // An unverified finding is the checks saying they could not tell. The gate counts it as a gap,
  // not a failure, so only a definite failure can count as a catch.
  const definite = newGating.filter((finding) => finding.confidence === 'fail');
  if (newGating.length > 0 && definite.length === 0) {
    const rules = sortedUnique(newGating.map((finding) => finding.rule));
    return result(entry, screen, 'unreadable', rules, `the checks could not confirm the defect either way: ${rules.join(', ')}`);
  }

  if (definite.length > 0) {
    // The gate collapses every draft at one identity into one finding, and its representative can
    // be another element than the mutated one. So each finding is located by every draft of the
    // mutated scan behind it.
    const pathsOf = definite.map(pathsBehind);
    const places = await record.edit.locate(pathsOf.flat());
    const allowed = PLACES_FOR[entry.reportedOn];
    let next = 0;
    const onTargetFlags = pathsOf.map((paths) => {
      const own = places.slice(next, next + paths.length);
      next += paths.length;
      return own.some((place) => allowed.includes(place));
    });
    const onTarget = definite.filter((_finding, index) => onTargetFlags[index] === true);
    const expected = onTarget.filter((finding) => entry.expectedRules.some((pattern) => ruleMatches(pattern, finding.rule)));
    if (expected.length > 0) {
      return result(entry, screen, 'caught', sortedUnique(expected.map((finding) => finding.rule)), null);
    }
    if (onTarget.length > 0) {
      const rules = sortedUnique(onTarget.map((finding) => finding.rule));
      return result(entry, screen, 'caught by another rule', rules, `reported by ${rules.join(', ')}; ${expectedText(entry)}`);
    }
    // The clean and mutated scans are two loads of the page. A finding that is new away from the
    // change can come from the page itself differing between loads, so it says nothing about the
    // defect either way.
    const rules = sortedUnique(definite.map((finding) => finding.rule));
    return result(
      entry,
      screen,
      'unreadable',
      rules,
      `a new finding appeared away from the change, so the two loads differ and this proves nothing about the defect: ${rules.join(', ')}`,
    );
  }

  const cleanPreview = new Set(cleanGate.findings.filter((finding) => finding.evidenceClass === 'preview').map(findingKey));
  const newPreview = mutatedGate.findings.filter(
    (finding) => finding.evidenceClass === 'preview' && !cleanPreview.has(findingKey(finding)),
  );
  if (newPreview.length > 0) {
    const rules = sortedUnique(newPreview.map((finding) => finding.rule));
    return result(entry, screen, 'preview only', rules, `only preview findings were new, and preview never gates: ${rules.join(', ')}`);
  }

  const note = missNote === null ? '' : `${missNote}; `;
  return result(entry, screen, 'missed', [], `nothing new gated; ${note}${expectedText(entry)}`);
}

/** Every entry on every screen it is measured on, in catalog order, then screen order. */
export async function measureCatalog(
  deps: SensitivityRunnerDeps,
  plan: ReadonlyArray<{ entry: CatalogEntry; screens: readonly SensitivityScreen[] }>,
): Promise<EntryMeasurement[]> {
  const measurements: EntryMeasurement[] = [];
  for (const { entry, screens } of plan) {
    for (const screen of screens) {
      measurements.push(await measureEntry(deps, entry, screen));
    }
  }
  return measurements;
}

/**
 * Evidence floor drafting for the explicit `usabl baseline` command.
 * This unit writes a deterministic floor draft from two gated Results and returns.
 * It must never mint a verdict, write waivers, or re-consume newly written floor bytes in the same process.
 *
 * It scans the application twice and records only the barriers both scans found. A barrier one
 * scan saw and the other did not is not stable debt: a table showed a row that later went away, or
 * a tooltip the scanner opened was still fading out. Recording it would leave headroom on every
 * run without it, and headroom is where a new barrier can hide. It is listed instead, by screen
 * and rule, never by element key, because a key can carry page text.
 */
import type { CoverageGap, Deps, EvidenceFloor, FloorEntry, Finding, Result, UsablConfig } from '../contracts/index.js';
import { buildFindings } from '../gate/index.js';
import { coverageIncomplete, notEvaluatedCounts } from '../coverage/completeness.js';
import { parseDocsManifest } from '../coverage/docs-manifest.js';
import { neutralize } from '../primitives/neutralize.js';
import { computeIdentity, FLOOR_VERSION, identityKey } from '../primitives/identity.js';
import { sortBy } from '../primitives/sortKey.js';
import { runWithFloorGaps } from '../run.js';
import { checkGuard } from '../trust/guard.js';

export const EVIDENCE_FLOOR_PATH = '.usabl-evidence.json';

export interface BaselineFs {
  writeFile(path: string, contents: string): Promise<void>;
}

export interface BaselineOutcome {
  // Exit 3 is not_covered: the run reported coverage gaps and the operator did not ask for a
  // partial floor, or asked for one but nothing was cleanly scanned. This matches how the check
  // path treats incomplete coverage through decideAccessibilityVerdict.
  exitCode: 0 | 2 | 3 | 4;
  wrote: boolean;
  message: string;
  entryCount: number;
}

function findingKey(entry: FloorEntry): string {
  return `${entry.screenId}|${entry.layer}|${entry.rule}|${entry.elementKey ?? 'count'}`;
}

function countDeterministicDrafts(result: Result): Map<string, number> {
  const counts = new Map<string, number>();
  for (const screen of result.screens) {
    for (const draft of screen.drafts) {
      if (draft.evidenceClass !== 'deterministic') {
        continue;
      }
      // The floor is written with the current keys, whatever keys the committed floor used.
      const identity = computeIdentity(draft);
      const key = identityKey({
        screenId: draft.screenId,
        rule: draft.rule,
        elementKey: identity.elementKey,
      });
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function toFloorEntry(finding: Finding, deterministicDraftCounts: Map<string, number>): FloorEntry {
  // Every basis can collapse several drafts onto one identity, not just the count basis.
  // Two dialogs at the same neutralized path share a structural key; two controls with the
  // same accessible name share a name key. Recording the observed count for all of them is
  // what lets the gate tell one accepted barrier from three.
  const count = deterministicDraftCounts.get(identityKey(finding)) ?? 0;
  return {
    screenId: finding.screenId,
    layer: finding.layer,
    rule: finding.rule,
    elementKey: finding.elementKey,
    identityBasis: finding.identityBasis,
    count,
  };
}

/**
 * The deterministic findings of one run, keyed the way a new floor is written.
 *
 * The Result's own findings were keyed against the committed floor, and a floor from before row
 * keys is compared with its old keys. A new floor must not inherit those, so the run's drafts are
 * keyed again here through the gate's own differential against an empty current-version floor.
 * That reuses the gate's dedup and its choice of which draft represents an identity, so the floor
 * names the same layer the gate will show.
 */
function currentFindings(result: Result): Finding[] {
  return buildFindings({
    coverage: result.coverage,
    guardDivergedPaths: [],
    drafts: result.screens.flatMap((screen) => screen.drafts),
    floor: { version: FLOOR_VERSION, entries: [] },
    waivers: [],
    now: '1970-01-01T00:00:00.000Z',
    cleanlyScannedScreens: new Set(),
  }).filter((finding) => finding.evidenceClass === 'deterministic');
}

/** One run's observed floor entries, by identity. */
function observedEntries(result: Result): Map<string, FloorEntry> {
  const counts = countDeterministicDrafts(result);
  const entries = new Map<string, FloorEntry>();
  for (const finding of currentFindings(result)) {
    entries.set(identityKey(finding), toFloorEntry(finding, counts));
  }
  return entries;
}

/** Barriers one scan found and the other did not, counted by screen and rule. */
interface IntermittentGroup {
  screenId: string;
  rule: string;
  count: number;
}

interface StableFloor {
  entries: FloorEntry[];
  intermittent: IntermittentGroup[];
}

/**
 * What both scans found, and what only one did.
 *
 * An identity both scans found is recorded at the smaller of its two counts, because that is how
 * many barriers both scans saw there. The rest of its count, and every identity only one scan found,
 * is intermittent. The entry is copied from the first scan; the second can only differ in which
 * layer represents the identity, which is not part of the identity.
 */
function stableFloor(first: Result, second: Result, keep: (screenId: string) => boolean): StableFloor {
  const a = observedEntries(first);
  const b = observedEntries(second);
  const entries: FloorEntry[] = [];
  const intermittent = new Map<string, IntermittentGroup>();
  const addIntermittent = (entry: FloorEntry, count: number): void => {
    if (count <= 0) return;
    const key = JSON.stringify([entry.screenId, entry.rule]);
    const group = intermittent.get(key) ?? { screenId: entry.screenId, rule: entry.rule, count: 0 };
    group.count += count;
    intermittent.set(key, group);
  };

  for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const inFirst = a.get(key);
    const inSecond = b.get(key);
    const entry = inFirst ?? inSecond!;
    if (!keep(entry.screenId)) continue;
    const firstCount = inFirst?.count ?? 0;
    const secondCount = inSecond?.count ?? 0;
    const both = Math.min(firstCount, secondCount);
    if (inFirst !== undefined && inSecond !== undefined && both > 0) {
      entries.push({ ...inFirst, count: both });
    }
    addIntermittent(entry, Math.max(firstCount, secondCount) - both);
  }

  return {
    entries: sortBy(entries, findingKey),
    intermittent: sortBy([...intermittent.values()], (group) => JSON.stringify([group.screenId, group.rule])),
  };
}

// The screen ids that were scanned and reported no gap of their own. This is the same notion the
// gate and floor prune use for cleanlyScannedScreens: scanned and no gap.
function cleanlyScannedScreenIds(result: Result): Set<string> {
  return new Set(
    result.screens.filter((screen) => screen.gaps.length === 0).map((screen) => screen.screenId),
  );
}

function intermittentTotal(groups: IntermittentGroup[]): number {
  return groups.reduce((sum, group) => sum + group.count, 0);
}

/**
 * The stability lines of a baseline report. Screen ids come from the operator's config and rules
 * from usabl, but both are neutralized anyway, as every line here is. No element key is printed:
 * a key can carry page text, and a screen and rule are enough to find the barrier with usabl check.
 */
function formatStability(groups: IntermittentGroup[]): string[] {
  if (groups.length === 0) {
    return ['scanned twice: both scans found the same barriers.'];
  }
  const total = intermittentTotal(groups);
  return [
    `scanned twice: ${total} barrier${total === 1 ? '' : 's'} came and went between the two scans (intermittent) and ${total === 1 ? 'was' : 'were'} not recorded:`,
    ...groups.map((group) => `  - screen ${neutralize(group.screenId)}, rule ${neutralize(group.rule)}: ${group.count}`),
    'an intermittent barrier is not on the floor, so it blocks as new on any later run where it appears.',
    'to handle one: fix it (a control repeated in every table row is usually one fix);',
    'or check the screen against fixed data, so it shows the same rows on every run;',
    'or, when the page changes on its own, waive the rule on that screen with an expiry in a reviewed commit.',
    'then run baseline again.',
  ];
}

function formatDirtyGuardedPaths(paths: string[]): string {
  const lines = [
    `refused: guarded paths other than ${EVIDENCE_FLOOR_PATH} are dirty`,
    ...paths.map((path) => `  - ${neutralize(path)}`),
  ];
  return lines.join('\n');
}

function entriesWord(count: number): string {
  return `${count} floor entr${count === 1 ? 'y' : 'ies'}`;
}

function formatSuccessReport(entryCount: number, intermittent: IntermittentGroup[]): string {
  return [
    `wrote ${entriesWord(entryCount)} to ${EVIDENCE_FLOOR_PATH}.`,
    'draft only: review and merge this working-tree diff.',
    // "extra findings" would promise more than the floor can deliver. What gates is a finding at
    // an identity the floor does not hold, or a count above what it recorded there.
    'after merge, matching findings carry; a new identity, or more barriers at a recorded one, gates.',
    ...formatStability(intermittent),
  ].join('\n');
}

// The default refusal when coverage is incomplete. A floor is an acceptance of existing debt, so a
// run that admits it did not see everything must not mint one. Name the numbers and the two ways
// out: fix coverage, or ask for a partial floor over only the cleanly scanned screens.
function formatCoverageRefusal(unresolvedFiles: number, gaps: number): string {
  return [
    'refused: coverage gaps remain, so no baseline floor was written.',
    `  gaps: ${gaps}, unresolved files: ${unresolvedFiles}.`,
    'a floor accepts existing debt, so it must come from a run that saw the whole application.',
    'fix coverage first (session, auth, or URL), then re-run baseline.',
    `or re-run with --partial to floor only the cleanly scanned screens.`,
  ].join('\n');
}

// The refusal when --partial was asked for but no screen was cleanly scanned. Writing an empty
// floor would look like a real acceptance of an empty debt set, so refuse instead.
function formatNothingCleanRefusal(): string {
  return [
    'refused: --partial was requested but nothing was cleanly scanned.',
    'every screen reported a coverage gap, so there is no clean screen to floor.',
    'fix coverage first (session, auth, or URL), then re-run baseline.',
  ].join('\n');
}

// The report for a partial floor. It says the scope is limited, lists the screens it covered, and
// lists the screens it skipped because they had gaps, so a reader knows exactly what was accepted.
function formatPartialReport(
  entryCount: number,
  coveredScreens: string[],
  skippedScreens: string[],
  intermittent: IntermittentGroup[],
): string {
  const lines = [
    `wrote ${entriesWord(entryCount)} to ${EVIDENCE_FLOOR_PATH} as a partial baseline.`,
    'draft only: review and merge this working-tree diff.',
    // Same correction as the full report: "extra findings" promises more than the floor delivers.
    'after merge, matching findings carry; a new identity, or more barriers at a recorded one, gates.',
    `covered ${coveredScreens.length} cleanly scanned screen${coveredScreens.length === 1 ? '' : 's'}: ${coveredScreens.join(', ')}.`,
  ];
  if (skippedScreens.length > 0) {
    lines.push(
      `skipped ${skippedScreens.length} screen${skippedScreens.length === 1 ? '' : 's'} with coverage gaps: ${skippedScreens.join(', ')}.`,
    );
  }
  lines.push(...formatStability(intermittent));
  return lines.join('\n');
}

/**
 * The run's coverage without the gaps that come from comparing it with the committed floor.
 *
 * The gate raises a gap when the committed floor is too old to compare: a version 1 floor with
 * placeholder counts, or a version 1 or 2 floor that predates row keys. Those gaps say "regenerate
 * the floor", and this command is the one that does it, so they must not stop it. The gate hands
 * them over as a list of its own, and exactly those objects are dropped. A gap is never dropped for
 * its ref or its reason: a check runner can return a gap whose ref is the floor file name. Every
 * other gap is a measurement gap, and a baseline still refuses on it, because a floor accepts debt
 * only from a run that saw the whole application.
 */
function measuredCoverage(coverage: Result['coverage'], floorGaps: readonly CoverageGap[]): Result['coverage'] {
  const gateRaised = new Set(floorGaps);
  return { ...coverage, gaps: coverage.gaps.filter((gap) => !gateRaised.has(gap)) };
}

/**
 * Why a run cannot be part of a baseline, or null when it can. A run with no verdict is not
 * evidence of clean debt, and exit 4 covers both a crash and a run that never saw the
 * application, so the run's own summary says which.
 */
function refusedRun(result: Result): BaselineOutcome | null {
  if (result.exitCode === 4) {
    return {
      exitCode: 4,
      wrote: false,
      message: `refused: ${result.summary}. No baseline floor was written.`,
      entryCount: 0,
    };
  }
  if (result.coverage.nothingToCheck) {
    return {
      exitCode: 2,
      wrote: false,
      message: 'refused: no UI files matched uiFileGlobs for baseline.',
      entryCount: 0,
    };
  }
  return null;
}

export async function runBaseline(
  deps: Deps,
  config: UsablConfig,
  floorFs: BaselineFs,
  opts: { trustedRef?: string; partial?: boolean } = {},
): Promise<BaselineOutcome> {
  const trustedRef = opts.trustedRef ?? 'HEAD';
  const dirtyGuardedPaths = await checkGuard(deps, config, trustedRef);
  const otherGuardedDirty = dirtyGuardedPaths.filter((path) => path !== EVIDENCE_FLOOR_PATH);
  // Baseline drafts must stay reviewable. Mixing floor updates with other guarded edits is refused.
  if (otherGuardedDirty.length > 0) {
    return {
      exitCode: 2,
      wrote: false,
      message: formatDirtyGuardedPaths(otherGuardedDirty),
      entryCount: 0,
    };
  }

  // The floor must absorb docs debt too, not only app debt. uiFileGlobs never matches docs source
  // files, so enumerate every docs page source from the manifest and add them to the change set.
  // That makes run() scan every docs page (each source maps to its page) so its barriers are floored
  // in the same commit. Absent manifest leaves the app-only behavior byte-identical. Reaching this
  // point means no guarded file other than the floor is dirty, so the working-tree manifest matches
  // the trusted one; enumerating its sources cannot smuggle in attacker-chosen scan targets.
  const appFiles = await deps.fs.glob(config.uiFileGlobs);
  const docsManifest = await parseDocsManifest(deps.fs);
  const docsSourceFiles =
    docsManifest === null ? [] : docsManifest.pages.flatMap((page) => page.sources);
  const changedFiles = [...new Set([...appFiles, ...docsSourceFiles])].sort();
  const runOptions = {
    ...(opts.trustedRef === undefined ? {} : { trustedRef: opts.trustedRef }),
    changedFiles,
  };
  // Two full scans, one after the other, on the same tree. Only what both found is recorded.
  const firstRun = await runWithFloorGaps(deps, config, runOptions);
  const first = firstRun.result;
  const firstRefusal = refusedRun(first);
  if (firstRefusal !== null) {
    return firstRefusal;
  }
  const secondRun = await runWithFloorGaps(deps, config, runOptions);
  const second = secondRun.result;
  const secondRefusal = refusedRun(second);
  if (secondRefusal !== null) {
    return secondRefusal;
  }

  // Coverage must be complete in both scans. A screen one scan could not reach is not one the
  // floor can speak for, whichever scan missed it.
  const incompleteRun = [firstRun, secondRun]
    .map(({ result, floorGaps }) => ({ ...result, coverage: measuredCoverage(result.coverage, floorGaps) }))
    .find((result) => coverageIncomplete(result.coverage));

  // Default baseline refuses when coverage is incomplete. A floor is an acceptance of existing
  // debt, so it must not be minted from a run that admits it did not see the whole application.
  // Exit 3 is not_covered, the same channel the check path uses for incomplete coverage.
  if (incompleteRun !== undefined && opts.partial !== true) {
    const counts = notEvaluatedCounts(incompleteRun.coverage);
    return {
      exitCode: 3,
      wrote: false,
      message: formatCoverageRefusal(counts.unresolvedFiles, counts.gaps),
      entryCount: 0,
    };
  }

  // A partial baseline over runs that were already complete is just a complete baseline. The flag
  // is a no-op, so fall through to the complete write below and omit the scope field.
  if (opts.partial === true && incompleteRun !== undefined) {
    // Clean in both scans. A screen with a gap in either one is skipped.
    const cleanInSecond = cleanlyScannedScreenIds(second);
    const cleanScreenIds = new Set([...cleanlyScannedScreenIds(first)].filter((id) => cleanInSecond.has(id)));
    // Nothing was cleanly scanned means there is no clean screen to floor. Refuse rather than
    // write an empty floor, which would read as a real acceptance of an empty debt set.
    if (cleanScreenIds.size === 0) {
      return {
        exitCode: 3,
        wrote: false,
        message: formatNothingCleanRefusal(),
        entryCount: 0,
      };
    }
    // Keying on entry.screenId is sound only because every provider stamps a draft's screenId from
    // the scan context, never from page-derived data. If a provider ever set screenId from the page,
    // a gapped screen's finding could carry a cleanly scanned screen's id and slip into this floor.
    const stable = stableFloor(first, second, (screenId) => cleanScreenIds.has(screenId));
    const partialFloor: EvidenceFloor = { version: FLOOR_VERSION, scope: 'partial', entries: stable.entries };
    await floorFs.writeFile(EVIDENCE_FLOOR_PATH, `${JSON.stringify(partialFloor, null, 2)}\n`);
    const coveredScreens = [...cleanScreenIds].sort();
    const skippedScreens = [...new Set([...first.screens, ...second.screens].map((screen) => screen.screenId))]
      .filter((id) => !cleanScreenIds.has(id))
      .sort();
    return {
      exitCode: 0,
      wrote: true,
      entryCount: partialFloor.entries.length,
      message: formatPartialReport(partialFloor.entries.length, coveredScreens, skippedScreens, stable.intermittent),
    };
  }

  const stable = stableFloor(first, second, () => true);
  const floor: EvidenceFloor = { version: FLOOR_VERSION, entries: stable.entries };
  await floorFs.writeFile(EVIDENCE_FLOOR_PATH, `${JSON.stringify(floor, null, 2)}\n`);
  return {
    exitCode: 0,
    wrote: true,
    entryCount: floor.entries.length,
    message: formatSuccessReport(floor.entries.length, stable.intermittent),
  };
}

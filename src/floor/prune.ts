/**
 * Evidence floor prune for explicit `usabl floor prune`.
 * This unit writes a floor prune draft from a gated scan.
 * It must never mint a verdict, never edit the floor inside `run()`, and never treat an unscanned screen as fixed.
 */
import type { Deps, FloorEntry, ScreenScan, UsablConfig } from '../contracts/index.js';
import { EVIDENCE_FLOOR_PATH } from '../baseline/index.js';
import { coverageIncomplete } from '../coverage/completeness.js';
import { parseEvidenceFloor } from '../evidence/floor.js';
import { computeIdentity, identityKey } from '../primitives/identity.js';
import { sortBy } from '../primitives/sortKey.js';
import { run } from '../run.js';
import { checkGuard } from '../trust/guard.js';
import { neutralize } from '../primitives/neutralize.js';

export interface FloorPruneFs {
  readFile?(path: string): Promise<string | null>;
  writeFile(path: string, contents: string): Promise<void>;
}

export interface FloorPruneOutcome {
  exitCode: 0 | 2 | 4;
  wrote: boolean;
  message: string;
  prunedCount: number;
  // Entries kept but re-armed to the count this run observed. A pay-down that removes some but not
  // all barriers at one identity lowers a count without removing an entry, so a run can write a
  // floor diff with prunedCount 0. Reported separately because the two are different work: one is
  // an identity that is gone, the other is an identity with fewer barriers behind it than before.
  loweredCount: number;
}

function formatDirtyGuardedPaths(paths: string[]): string {
  const lines = [
    `refused: guarded paths other than ${EVIDENCE_FLOOR_PATH} are dirty`,
    ...paths.map((path) => `  - ${neutralize(path)}`),
  ];
  return lines.join('\n');
}

function floorEntrySortKey(value: { screenId: string; layer: string; rule: string; elementKey: string | null }): string {
  return `${value.screenId}|${value.layer}|${value.rule}|${value.elementKey ?? 'count'}`;
}

/**
 * How many deterministic barriers this run actually observed at each identity.
 *
 * Counts, not a presence set. An entry whose identity is still observed used to be kept exactly as
 * written, so the recorded count only ever went up, through `usabl baseline`, and never came back
 * down. That made the count a high-water mark: after a barrier at a floored identity was fixed, the
 * entry still claimed the old number, and the gate had no way to tell a new barrier taking the
 * freed slot from the accepted one that used to hold it. Lowering the count here is what re-arms
 * the gate, and it is what makes the pay-down message this unit already prints true.
 *
 * Deterministic drafts only, matching what `usabl baseline` counts and what the gate compares
 * against. Counting advisory evidence here would write a number the gate never sees.
 */
function observedDeterministicCounts(screens: ScreenScan[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const screen of screens) {
    for (const draft of screen.drafts) {
      if (draft.evidenceClass !== 'deterministic') {
        continue;
      }
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

function formatNoopReport(): string {
  return `nothing was pruned from ${EVIDENCE_FLOOR_PATH}.`;
}

function formatSuccessReport(prunedCount: number, loweredCount: number, hasCoverageGaps: boolean): string {
  // Both numbers, and only the ones that happened. A prune that lowered a count without removing
  // an entry would otherwise report "removed 0 floor entries" over a real floor diff.
  const changes: string[] = [];
  if (prunedCount > 0) {
    changes.push(`removed ${prunedCount} floor entr${prunedCount === 1 ? 'y' : 'ies'}`);
  }
  if (loweredCount > 0) {
    changes.push(`lowered the barrier count on ${loweredCount} entr${loweredCount === 1 ? 'y' : 'ies'}`);
  }
  const lines = [
    `${changes.join(' and ')} in ${EVIDENCE_FLOOR_PATH}.`,
    'pruning re-arms the gate, so a reintroduced barrier gates as new.',
    'review and merge this floor diff with the fix.',
  ];
  if (hasCoverageGaps) {
    lines.push('coverage gaps remain, so floor entries on unscanned screens were kept.');
  }
  return lines.join('\n');
}

export async function runFloorPrune(
  deps: Deps,
  config: UsablConfig,
  floorFs: FloorPruneFs,
  opts: { trustedRef?: string } = {},
): Promise<FloorPruneOutcome> {
  try {
    const trustedRef = opts.trustedRef ?? 'HEAD';
    const dirtyGuardedPaths = await checkGuard(deps, config, trustedRef);
    const otherGuardedDirty = dirtyGuardedPaths.filter((path) => path !== EVIDENCE_FLOOR_PATH);
    // Prune writes a draft diff. Mixing other guarded edits would hide scope inside one approval.
    if (otherGuardedDirty.length > 0) {
      return {
        exitCode: 2,
        wrote: false,
        message: formatDirtyGuardedPaths(otherGuardedDirty),
        prunedCount: 0,
        loweredCount: 0,
      };
    }

    // Use working-tree floor bytes for prune, even when run() reads an untrusted
    // empty floor during policy divergence. That preserves paid-down identities.
    const readFloor = floorFs.readFile ?? deps.fs.readFile;
    const rawFloor = await readFloor(EVIDENCE_FLOOR_PATH);
    if (rawFloor === null || rawFloor.trim().length === 0) {
      return { exitCode: 0, wrote: false, message: formatNoopReport(), prunedCount: 0, loweredCount: 0 };
    }
    const floor = parseEvidenceFloor(JSON.parse(rawFloor));
    if (floor.entries.length === 0) {
      return { exitCode: 0, wrote: false, message: formatNoopReport(), prunedCount: 0, loweredCount: 0 };
    }

    const changedFiles = [...new Set(await deps.fs.glob(config.uiFileGlobs))].sort();
    const result = await run(deps, config, {
      ...(opts.trustedRef === undefined ? {} : { trustedRef: opts.trustedRef }),
      changedFiles,
    });
    // Exit 4 covers a crash and a run that never saw the application. Either way there is no
    // observation to prune against, and the run's own summary says which one happened.
    if (result.exitCode === 4) {
      return {
        exitCode: 4,
        wrote: false,
        message: `refused: ${result.summary}. No floor entries were pruned.`,
        prunedCount: 0,
        loweredCount: 0,
      };
    }
    if (result.coverage.nothingToCheck) {
      return {
        exitCode: 2,
        wrote: false,
        message: 'refused: no UI files matched uiFileGlobs for floor prune.',
        prunedCount: 0,
        loweredCount: 0,
      };
    }

    // A floor entry is paid down only if its screen was actually verified this run.
    // `coverage.affected` records intent to scan; a screen that was affected but
    // gapped (for example, browser unavailable) still appears there yet yields no
    // drafts. Treating that absence as a fix would prune real debt and re-arm the
    // gate against a barrier that is still present, forcing a false regression on
    // the next clean scan. Narrow the prune set to screens whose scan had no gaps.
    const cleanlyScannedScreens = new Set(
      result.screens.filter((screen) => screen.gaps.length === 0).map((screen) => screen.screenId),
    );
    const observedCounts = observedDeterministicCounts(result.screens);
    // The same test the gate applies before it compares a count. A version 1 floor wrote a
    // placeholder 1 for name and structural entries, so those numbers are not observations and the
    // gate ignores them. Writing a real count into one would present it as observed debt while the
    // file still says version 1, which is the confusion the version field exists to prevent. Those
    // entries are re-armed by `usabl baseline`, which rewrites the floor at version 2.
    const countIsObserved = (entry: FloorEntry): boolean =>
      entry.identityBasis === 'count' || floor.version >= 2;

    const keptEntries: typeof floor.entries = [];
    let prunedCount = 0;
    let loweredCount = 0;
    for (const entry of floor.entries) {
      // Keep entries for any screen we did not fully verify this run: not affected,
      // not scanned, or scanned with a coverage gap. Absence is not proof of a fix.
      if (!cleanlyScannedScreens.has(entry.screenId)) {
        keptEntries.push(entry);
        continue;
      }
      const observed = observedCounts.get(identityKey(entry)) ?? 0;
      if (observed === 0) {
        prunedCount += 1;
        continue;
      }
      // Lower only, never raise. Fewer barriers than the floor accepted is a pay-down this run
      // measured, and recording it is what re-arms the gate. More barriers than the floor accepted
      // is new debt, and accepting that silently here would let prune do the job `usabl baseline`
      // exists to do under review. The gate already reports that case as a regression.
      if (countIsObserved(entry) && observed < entry.count) {
        keptEntries.push({ ...entry, count: observed });
        loweredCount += 1;
        continue;
      }
      keptEntries.push(entry);
    }

    if (prunedCount === 0 && loweredCount === 0) {
      return { exitCode: 0, wrote: false, message: formatNoopReport(), prunedCount: 0, loweredCount: 0 };
    }

    const hasCoverageGaps = coverageIncomplete(result.coverage);
    // Prune removes entries and lowers counts. It never raises one and never adds an identity, so
    // it must keep the version it read. Claiming version 2 over version 1 counts would present
    // placeholder counts as observed debt.
    const nextFloor = { version: floor.version, entries: sortBy(keptEntries, floorEntrySortKey) };
    await floorFs.writeFile(EVIDENCE_FLOOR_PATH, `${JSON.stringify(nextFloor, null, 2)}\n`);
    return {
      exitCode: 0,
      wrote: true,
      // Removing paid-down identities and lowering the counts behind the ones that remain closes
      // the disarmed window where a reintroduced barrier would otherwise stay carried instead of
      // new.
      message: formatSuccessReport(prunedCount, loweredCount, hasCoverageGaps),
      prunedCount,
      loweredCount,
    };
  } catch (err) {
    // The error can carry page-derived text with control bytes. Neutralize it before
    // it reaches stderr, matching every other output path in this unit.
    const message = neutralize(err instanceof Error ? err.message : String(err));
    return {
      exitCode: 4,
      wrote: false,
      message: `refused: floor prune crashed (${message}).`,
      prunedCount: 0,
      loweredCount: 0,
    };
  }
}

/**
 * Evidence floor prune for explicit `usabl floor prune`.
 * This unit writes a floor prune draft from a gated scan.
 * It must never mint a verdict, never edit the floor inside `run()`, and never treat an unscanned screen as fixed.
 */
import type { Deps, ScreenScan, UsablConfig } from '../contracts/index.js';
import { EVIDENCE_FLOOR_PATH } from '../baseline/index.js';
import { parseEvidenceFloor } from '../evidence/floor.js';
import { computeIdentity } from '../primitives/identity.js';
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
}

function formatDirtyGuardedPaths(paths: string[]): string {
  const lines = [
    `refused: guarded paths other than ${EVIDENCE_FLOOR_PATH} are dirty`,
    ...paths.map((path) => `  - ${neutralize(path)}`),
  ];
  return lines.join('\n');
}

function identityKey(value: { screenId: string; rule: string; elementKey: string | null }): string {
  return `${value.screenId}|${value.rule}|${value.elementKey ?? 'count'}`;
}

function floorEntrySortKey(value: { screenId: string; layer: string; rule: string; elementKey: string | null }): string {
  return `${value.screenId}|${value.layer}|${value.rule}|${value.elementKey ?? 'count'}`;
}

function observedDeterministicKeys(screens: ScreenScan[]): Set<string> {
  const keys = new Set<string>();
  for (const screen of screens) {
    for (const draft of screen.drafts) {
      if (draft.evidenceClass !== 'deterministic') {
        continue;
      }
      const identity = computeIdentity(draft);
      keys.add(
        identityKey({
          screenId: draft.screenId,
          rule: draft.rule,
          elementKey: identity.elementKey,
        }),
      );
    }
  }
  return keys;
}

function formatNoopReport(): string {
  return `nothing was pruned from ${EVIDENCE_FLOOR_PATH}.`;
}

function formatSuccessReport(prunedCount: number, hasCoverageGaps: boolean): string {
  const lines = [
    `removed ${prunedCount} floor entr${prunedCount === 1 ? 'y' : 'ies'} from ${EVIDENCE_FLOOR_PATH}.`,
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
      };
    }

    // Use working-tree floor bytes for prune, even when run() reads an untrusted
    // empty floor during policy divergence. That preserves paid-down identities.
    const readFloor = floorFs.readFile ?? deps.fs.readFile;
    const rawFloor = await readFloor(EVIDENCE_FLOOR_PATH);
    if (rawFloor === null || rawFloor.trim().length === 0) {
      return { exitCode: 0, wrote: false, message: formatNoopReport(), prunedCount: 0 };
    }
    const floor = parseEvidenceFloor(JSON.parse(rawFloor));
    if (floor.entries.length === 0) {
      return { exitCode: 0, wrote: false, message: formatNoopReport(), prunedCount: 0 };
    }

    const changedFiles = [...new Set(await deps.fs.glob(config.uiFileGlobs))].sort();
    const result = await run(deps, config, {
      ...(opts.trustedRef === undefined ? {} : { trustedRef: opts.trustedRef }),
      changedFiles,
    });
    if (result.exitCode === 4) {
      return {
        exitCode: 4,
        wrote: false,
        message: 'refused: scan crashed, so no floor entries were pruned.',
        prunedCount: 0,
      };
    }
    if (result.coverage.nothingToCheck) {
      return {
        exitCode: 2,
        wrote: false,
        message: 'refused: no UI files matched uiFileGlobs for floor prune.',
        prunedCount: 0,
      };
    }

    const affectedScreens = new Set(result.coverage.affected.map((screen) => screen.screenId));
    const observedKeys = observedDeterministicKeys(result.screens);
    const keptEntries: typeof floor.entries = [];
    let prunedCount = 0;
    for (const entry of floor.entries) {
      // A screen we did not scan is not paid down evidence. Keep those entries so
      // prune never treats not-covered surfaces as fixed debt.
      if (!affectedScreens.has(entry.screenId)) {
        keptEntries.push(entry);
        continue;
      }
      if (observedKeys.has(identityKey(entry))) {
        keptEntries.push(entry);
        continue;
      }
      prunedCount += 1;
    }

    if (prunedCount === 0) {
      return { exitCode: 0, wrote: false, message: formatNoopReport(), prunedCount: 0 };
    }

    const hasCoverageGaps = result.coverage.unresolvedFiles.length > 0 || result.coverage.gaps.length > 0;
    const nextFloor = { version: 1 as const, entries: sortBy(keptEntries, floorEntrySortKey) };
    await floorFs.writeFile(EVIDENCE_FLOOR_PATH, `${JSON.stringify(nextFloor, null, 2)}\n`);
    return {
      exitCode: 0,
      wrote: true,
      // Removing only paid-down identities closes the disarmed window where
      // a reintroduced barrier would otherwise stay carried instead of new.
      message: formatSuccessReport(prunedCount, hasCoverageGaps),
      prunedCount,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 4,
      wrote: false,
      message: `refused: floor prune crashed (${message}).`,
      prunedCount: 0,
    };
  }
}

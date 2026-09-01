/**
 * Evidence floor drafting for the explicit `usabl baseline` command.
 * This unit writes a deterministic floor draft from a gated Result and returns.
 * It must never mint a verdict, write waivers, or re-consume newly written floor bytes in the same process.
 */
import type { Deps, EvidenceFloor, FloorEntry, Finding, Result, UsablConfig } from '../contracts/index.js';
import { parseDocsManifest } from '../coverage/docs-manifest.js';
import { neutralize } from '../primitives/neutralize.js';
import { computeIdentity } from '../primitives/identity.js';
import { sortBy } from '../primitives/sortKey.js';
import { run } from '../run.js';
import { checkGuard } from '../trust/guard.js';

export const EVIDENCE_FLOOR_PATH = '.usabl-evidence.json';

export interface BaselineFs {
  writeFile(path: string, contents: string): Promise<void>;
}

export interface BaselineOutcome {
  exitCode: 0 | 2 | 4;
  wrote: boolean;
  message: string;
  entryCount: number;
}

function identityKey(value: { screenId: string; rule: string; elementKey: string | null }): string {
  return `${value.screenId}|${value.rule}|${value.elementKey ?? 'count'}`;
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
  // Count-basis findings collapse to one identity in gate output.
  // The floor keeps observed debt count from raw deterministic drafts so count-compare stays honest.
  const count =
    finding.identityBasis === 'count'
      ? (deterministicDraftCounts.get(identityKey(finding)) ?? 0)
      : 1;
  return {
    screenId: finding.screenId,
    layer: finding.layer,
    rule: finding.rule,
    elementKey: finding.elementKey,
    identityBasis: finding.identityBasis,
    count,
  };
}

export function buildEvidenceFloorDraft(result: Result): EvidenceFloor {
  const deterministicDraftCounts = countDeterministicDrafts(result);
  // Only deterministic findings belong in the floor draft.
  // Fixed findings are synthesized disappearances from the previous floor, not observed debt.
  const entries = result.findings
    .filter((finding) => finding.evidenceClass === 'deterministic' && finding.status !== 'fixed')
    .map((finding) => toFloorEntry(finding, deterministicDraftCounts));
  return {
    version: 1,
    entries: sortBy(entries, findingKey),
  };
}

function formatDirtyGuardedPaths(paths: string[]): string {
  const lines = [
    `refused: guarded paths other than ${EVIDENCE_FLOOR_PATH} are dirty`,
    ...paths.map((path) => `  - ${neutralize(path)}`),
  ];
  return lines.join('\n');
}

function formatSuccessReport(entryCount: number, hasCoverageGaps: boolean): string {
  const lines = [
    `wrote ${entryCount} floor entr${entryCount === 1 ? 'y' : 'ies'} to ${EVIDENCE_FLOOR_PATH}.`,
    'draft only: review and merge this working-tree diff.',
    'after merge, matching findings carry and extra findings still gate as new.',
  ];
  if (hasCoverageGaps) {
    lines.push('coverage gaps remain, so this baseline draft is incomplete.');
  }
  return lines.join('\n');
}

export async function runBaseline(
  deps: Deps,
  config: UsablConfig,
  floorFs: BaselineFs,
  opts: { trustedRef?: string } = {},
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
  const result = await run(deps, config, {
    ...(opts.trustedRef === undefined ? {} : { trustedRef: opts.trustedRef }),
    changedFiles,
  });
  // A crash is not evidence of clean debt. Refuse instead of snapshotting a broken run as an empty floor.
  if (result.exitCode === 4) {
    return {
      exitCode: 4,
      wrote: false,
      message: 'refused: scan crashed, so no baseline floor was written.',
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

  const floor = buildEvidenceFloorDraft(result);
  await floorFs.writeFile(EVIDENCE_FLOOR_PATH, `${JSON.stringify(floor, null, 2)}\n`);
  return {
    exitCode: 0,
    wrote: true,
    entryCount: floor.entries.length,
    message: formatSuccessReport(
      floor.entries.length,
      result.coverage.unresolvedFiles.length > 0 || result.coverage.gaps.length > 0,
    ),
  };
}

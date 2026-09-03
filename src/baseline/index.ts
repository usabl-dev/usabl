/**
 * Evidence floor drafting for the explicit `usabl baseline` command.
 * This unit writes a deterministic floor draft from a gated Result and returns.
 * It must never mint a verdict, write waivers, or re-consume newly written floor bytes in the same process.
 */
import type { Deps, EvidenceFloor, FloorEntry, Finding, Result, UsablConfig } from '../contracts/index.js';
import { coverageIncomplete, notEvaluatedCounts } from '../coverage/completeness.js';
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
  // Exit 3 is not_covered: the run reported coverage gaps and the operator did not ask for a
  // partial floor, or asked for one but nothing was cleanly scanned. This matches how the check
  // path treats incomplete coverage through decideAccessibilityVerdict.
  exitCode: 0 | 2 | 3 | 4;
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

export function buildEvidenceFloorDraft(result: Result): EvidenceFloor {
  const deterministicDraftCounts = countDeterministicDrafts(result);
  // Only deterministic findings belong in the floor draft.
  // Fixed findings are synthesized disappearances from the previous floor, not observed debt.
  const entries = result.findings
    .filter((finding) => finding.evidenceClass === 'deterministic' && finding.status !== 'fixed')
    .map((finding) => toFloorEntry(finding, deterministicDraftCounts));
  return {
    version: 2,
    entries: sortBy(entries, findingKey),
  };
}

// The screen ids that were scanned and reported no gap of their own. This is the same notion the
// gate and floor prune use for cleanlyScannedScreens: scanned and no gap.
function cleanlyScannedScreenIds(result: Result): Set<string> {
  return new Set(
    result.screens.filter((screen) => screen.gaps.length === 0).map((screen) => screen.screenId),
  );
}

// A floor draft built from only the cleanly scanned screens, marked partial so a reader of the
// committed file can tell it apart from a whole-application floor. Entries for screens that had a
// gap are dropped, so nothing an unrendered or half-measured screen produced enters the floor.
function buildPartialEvidenceFloorDraft(result: Result, cleanScreenIds: Set<string>): EvidenceFloor {
  const full = buildEvidenceFloorDraft(result);
  return {
    version: full.version,
    scope: 'partial',
    // Keying on entry.screenId is sound only because every provider stamps a draft's screenId from
    // the scan context, never from page-derived data. If a provider ever set screenId from the page,
    // a gapped screen's finding could carry a cleanly scanned screen's id and slip into this floor.
    entries: full.entries.filter((entry) => cleanScreenIds.has(entry.screenId)),
  };
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

function formatSuccessReport(entryCount: number): string {
  return [
    `wrote ${entriesWord(entryCount)} to ${EVIDENCE_FLOOR_PATH}.`,
    'draft only: review and merge this working-tree diff.',
    'after merge, matching findings carry and extra findings still gate as new.',
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
function formatPartialReport(entryCount: number, coveredScreens: string[], skippedScreens: string[]): string {
  const lines = [
    `wrote ${entriesWord(entryCount)} to ${EVIDENCE_FLOOR_PATH} as a partial baseline.`,
    'draft only: review and merge this working-tree diff.',
    'after merge, matching findings carry and extra findings still gate as new.',
    `covered ${coveredScreens.length} cleanly scanned screen${coveredScreens.length === 1 ? '' : 's'}: ${coveredScreens.join(', ')}.`,
  ];
  if (skippedScreens.length > 0) {
    lines.push(
      `skipped ${skippedScreens.length} screen${skippedScreens.length === 1 ? '' : 's'} with coverage gaps: ${skippedScreens.join(', ')}.`,
    );
  }
  return lines.join('\n');
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
  const result = await run(deps, config, {
    ...(opts.trustedRef === undefined ? {} : { trustedRef: opts.trustedRef }),
    changedFiles,
  });
  // A run that produced no verdict is not evidence of clean debt. Refuse instead of snapshotting
  // it as an empty floor. Exit 4 covers a crash and a run that never saw the application, and the
  // run's own summary says which, so the operator is not sent to look for the wrong failure.
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

  const incomplete = coverageIncomplete(result.coverage);

  // Default baseline refuses when coverage is incomplete. A floor is an acceptance of existing
  // debt, so it must not be minted from a run that admits it did not see the whole application.
  // Exit 3 is not_covered, the same channel the check path uses for incomplete coverage.
  if (incomplete && opts.partial !== true) {
    const counts = notEvaluatedCounts(result.coverage);
    return {
      exitCode: 3,
      wrote: false,
      message: formatCoverageRefusal(counts.unresolvedFiles, counts.gaps),
      entryCount: 0,
    };
  }

  // A partial baseline over a run that was already complete is just a complete baseline. The flag
  // is a no-op, so fall through to the complete write below and omit the scope field.
  if (opts.partial === true && incomplete) {
    const cleanScreenIds = cleanlyScannedScreenIds(result);
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
    const partialFloor = buildPartialEvidenceFloorDraft(result, cleanScreenIds);
    await floorFs.writeFile(EVIDENCE_FLOOR_PATH, `${JSON.stringify(partialFloor, null, 2)}\n`);
    const coveredScreens = [...cleanScreenIds].sort();
    const skippedScreens = result.screens
      .filter((screen) => screen.gaps.length > 0)
      .map((screen) => screen.screenId)
      .sort();
    return {
      exitCode: 0,
      wrote: true,
      entryCount: partialFloor.entries.length,
      message: formatPartialReport(partialFloor.entries.length, coveredScreens, skippedScreens),
    };
  }

  const floor = buildEvidenceFloorDraft(result);
  await floorFs.writeFile(EVIDENCE_FLOOR_PATH, `${JSON.stringify(floor, null, 2)}\n`);
  return {
    exitCode: 0,
    wrote: true,
    entryCount: floor.entries.length,
    message: formatSuccessReport(floor.entries.length),
  };
}

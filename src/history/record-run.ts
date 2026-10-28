/**
 * `usabl history record`: scan every screen of main and build the history record for that scan.
 *
 * It scans the whole application, the way `usabl baseline` does, so every screen gets an
 * observation on every scan of main and a fix can be confirmed by the next one. It writes nothing
 * to git. The record goes to a file, and `usabl history append` adds it to the history branch in a
 * separate job, so the job that runs the application never holds write access to the repository.
 *
 * It refuses to record a run that never saw the application, a run with nothing to check, and a
 * checkout whose guarded files differ from HEAD, because a record speaks for the committed floor.
 */
import type { Deps, EvidenceFloor, Result, UsablConfig } from '../contracts/index.js';
import { everyScannableFile, EVIDENCE_FLOOR_PATH } from '../baseline/index.js';
import { parseEvidenceFloor } from '../evidence/floor.js';
import { computePolicyHash } from '../evidence/receipt.js';
import { run } from '../run.js';
import { buildGuardedSet, expandGuardedSet } from '../trust/guard.js';
import { buildRecord, HISTORY_BRANCH, type HistoryRecord } from './record.js';

// The floor run() uses when there is none, so a record of a run with no floor carries the same
// floor hash the run compared with.
const EMPTY_FLOOR: EvidenceFloor = { version: 2, entries: [] };

export interface RecordOutcome {
  exitCode: 0 | 2 | 4;
  message: string;
  record: HistoryRecord | null;
  result: Result | null;
}

function refused(exitCode: 2 | 4, message: string, result: Result | null = null): RecordOutcome {
  return { exitCode, message: `refused: ${message} No history record was written.`, record: null, result };
}

export async function recordMainScan(
  deps: Deps,
  config: UsablConfig,
  opts: { trustedRef?: string } = {},
): Promise<RecordOutcome> {
  const changedFiles = await everyScannableFile(deps, config);
  const result = await run(deps, config, {
    changedFiles,
    ...(opts.trustedRef === undefined ? {} : { trustedRef: opts.trustedRef }),
  });
  if (result.exitCode === 4) return refused(4, `${result.summary}.`, result);
  if (result.coverage.nothingToCheck) {
    return refused(2, 'no UI files matched uiFileGlobs, so there is no screen to record.', result);
  }
  if (result.dirtyGuardedPaths.length > 0) {
    return refused(
      2,
      `${result.dirtyGuardedPaths.length} guarded file(s) differ from HEAD. A record speaks for the committed floor, ` +
        'so record only from a clean checkout of main.',
      result,
    );
  }

  let floor: EvidenceFloor;
  try {
    const text =
      opts.trustedRef === undefined
        ? await deps.fs.readFile(EVIDENCE_FLOOR_PATH)
        : await deps.git.show(opts.trustedRef, EVIDENCE_FLOOR_PATH);
    floor = text === null ? EMPTY_FLOOR : parseEvidenceFloor(JSON.parse(text));
  } catch {
    return refused(4, `${EVIDENCE_FLOOR_PATH} could not be read.`, result);
  }

  const guarded = await expandGuardedSet(deps, buildGuardedSet(config));
  const [commit, sourceTree, policyHash] = await Promise.all([
    deps.git.headRef(),
    deps.git.writeTree(),
    computePolicyHash(deps, guarded),
  ]);
  const record = buildRecord({
    time: deps.clock(),
    commit,
    sourceTree,
    policyHash,
    runnerVersion: deps.runnerVersion,
    scannerVersions: deps.scannerVersions,
    floor,
    screens: result.screens,
  });
  const full = record.screens.filter((screen) => screen.coverage === 'full').length;
  const observed = record.screens.reduce((sum, screen) => sum + screen.identities.length, 0);
  return {
    exitCode: 0,
    record,
    result,
    message:
      `Recorded the scan of main at ${commit.slice(0, 12)}: ${record.screens.length} screen(s), ${full} fully scanned, ` +
      `${observed} floored identit${observed === 1 ? 'y' : 'ies'} observed. The run on main was ${result.summary}. ` +
      `Next: run "usabl history append" with this record in the job that may write the ${HISTORY_BRANCH} branch.`,
  };
}

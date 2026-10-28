/**
 * The floor a run is judged against, and the debt counts the run reports.
 *
 * A pull request is judged against the base commit's floor, minus every fix the history confirmed
 * on main up to the base commit. When tracking is off for any reason, the floor is the committed
 * floor, unchanged, and the counts say tracking is off and why.
 *
 * This unit folds and counts. It must never decide a verdict.
 */
import type { DebtStatus, EvidenceFloor, FloorHeadroom, HistoryReader } from '../contracts/index.js';
import { FLOOR_VERSION } from '../primitives/identity.js';
import { off, readHistory, type HistoryRead } from './read.js';
import { trackDebt, type TrackedIdentity } from './track.js';

export interface DebtTracking {
  // The floor as committed.
  floor: EvidenceFloor;
  // The floor the run is judged against. The committed floor when tracking is off.
  effectiveFloor: EvidenceFloor;
  read: HistoryRead;
  // Per identity, when tracking is on. Empty when it is off.
  identities: TrackedIdentity[];
}

/**
 * The floor a run is judged against, and what the history said. Never throws.
 *
 * A floor from before row keys (version 1 or 2) is not tracked. Its collapsed entries count rows
 * together, so an observation there cannot say which row was fixed, and the gate already asks for a
 * new baseline when such a floor meets a keyed row.
 */
export async function loadDebtTracking(
  reader: HistoryReader | undefined,
  floor: EvidenceFloor,
  baseRef: string,
): Promise<DebtTracking> {
  const read = await readHistory(reader, baseRef);
  if (read.kind === 'off') return { floor, effectiveFloor: floor, read, identities: [] };
  if (floor.version < FLOOR_VERSION && floor.entries.length > 0) {
    return { floor, effectiveFloor: floor, read: off('old-floor', read.head), identities: [] };
  }
  const track = trackDebt(floor, read.records);
  return { floor, effectiveFloor: track.floor, read, identities: track.identities };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function total(counts: readonly number[]): number {
  return counts.reduce((sum, count) => sum + count, 0);
}

/**
 * The counts a run reports about its debt. `headroom` is the gate's own floorHeadroom, computed
 * against the effective floor, so what it calls fewer than accepted is what this run fixed of the
 * debt it accepted. `now` is the run's clock value, so the ages are the same for the same date.
 */
export function debtStatusOf(tracking: DebtTracking, headroom: readonly FloorHeadroom[], now: string): DebtStatus {
  const floorBarriers = total(tracking.floor.entries.map((entry) => entry.count));
  const acceptedBarriers = total(tracking.effectiveFloor.entries.map((entry) => entry.count));
  const fixedThisRun = Math.min(acceptedBarriers, total(headroom.map((entry) => Math.max(0, entry.recorded - entry.observed))));
  const nowMs = Date.parse(now);
  let oldestOpenDays: number | null = null;
  let intermittent = 0;
  for (const identity of tracking.identities) {
    if (identity.accepted === 0) continue;
    if (identity.state === 'intermittent') intermittent += identity.accepted;
    if (identity.firstSeen === null || !Number.isFinite(nowMs)) continue;
    const days = Math.max(0, Math.floor((nowMs - Date.parse(identity.firstSeen)) / DAY_MS));
    oldestOpenDays = oldestOpenDays === null ? days : Math.max(oldestOpenDays, days);
  }
  const read = tracking.read;
  return {
    tracking: read.kind === 'on' ? 'on' : 'off',
    off: read.kind === 'off' ? { cause: read.cause, detail: read.detail } : null,
    historyHead: read.head,
    floorBarriers,
    acceptedBarriers,
    confirmedFixed: floorBarriers - acceptedBarriers,
    fixedThisRun,
    remaining: acceptedBarriers - fixedThisRun,
    oldestOpenDays,
    intermittent,
  };
}

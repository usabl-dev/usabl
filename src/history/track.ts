/**
 * Effective accepted debt: the evidence floor, lowered by the fixes main has confirmed.
 *
 * The floor's count for an identity is a high-water mark. When barriers there are fixed, the count
 * stays where it was, and a new barrier arriving at that identity takes the freed slot and reads
 * as carried. This unit closes the slot without anyone running `usabl floor prune`: once two
 * consecutive scans of main, each with that screen fully scanned, see fewer barriers at an identity
 * than the floor accepts, the accepted count for it becomes what they saw.
 *
 * The rule this unit holds to: the history can only lower the accepted debt. Every identity it
 * returns is a floor identity, and every accepted count is at most the floor's count, whatever the
 * records say. A record that names an identity the floor does not hold is ignored, and a record
 * that claims more barriers than the floor accepts can only stop a release. So a wrong or forged
 * history can make a run stricter, never greener than the floor alone.
 *
 * Intermittent. Two scans of the same source tree that see different counts at one identity show
 * the barrier comes and goes with the page's content, not with the code. Such an identity is
 * labelled intermittent, gets its full floor count back, and is never released again under this
 * floor. That covers a confirmed fix that reappears on an unchanged tree, and a table row that
 * shows in one scan and not the next. Each identity is judged on its own, so a row identity is
 * judged by its own row and never by how many rows the table showed.
 *
 * Only records written against this exact floor (the same floorHashOf) count toward a release. A
 * floor written again by baseline or prune is a new acceptance, made by a person, and starts a new
 * history. First-seen dates read every record, because the identity hash does not change.
 *
 * Pure: the same floor and records always give the same result.
 */
import type { EvidenceFloor, FloorEntry } from '../contracts/index.js';
import { FLOOR_VERSION, identityKey } from '../primitives/identity.js';
import { floorHashOf, identityId, type HistoryRecord } from './record.js';

export type TrackedState = 'open' | 'confirmed-fixed' | 'intermittent';

export interface TrackedIdentity {
  entry: FloorEntry;
  id: string;
  // The barriers accepted at this identity after confirmed fixes. Never above entry.count.
  accepted: number;
  state: TrackedState;
  // The time of the first record that saw a barrier here, or null when no record did.
  firstSeen: string | null;
  // The first and the latest count a full scan observed here under this floor, or null.
  firstCount: number | null;
  lastCount: number | null;
}

export interface DebtTrack {
  // The floor a run is judged against: the same version and scope, the same identities or fewer,
  // and no count above the committed floor's. An identity whose accepted count is zero is left out.
  floor: EvidenceFloor;
  identities: TrackedIdentity[];
}

interface Observation {
  sourceTree: string;
  count: number;
}

/**
 * Tracks every floor identity through the records, oldest first.
 *
 * `records` must already be the ones that apply: written on main at the base commit or one of its
 * ancestors, in the order they were appended.
 */
export function trackDebt(floor: EvidenceFloor, records: readonly HistoryRecord[]): DebtTrack {
  const hash = floorHashOf(floor);
  // Identities whose 16 character hashes collide on one screen cannot be told apart in a record, so
  // they are not tracked and keep their full count.
  const idUses = new Map<string, number>();
  for (const entry of floor.entries) {
    const key = `${entry.screenId}\u0000${identityId(entry)}`;
    idUses.set(key, (idUses.get(key) ?? 0) + 1);
  }

  const identities: TrackedIdentity[] = floor.entries.map((entry) => {
    const id = identityId(entry);
    const trackable = floor.version >= FLOOR_VERSION && idUses.get(`${entry.screenId}\u0000${id}`) === 1;
    const sameFloor: Observation[] = [];
    let firstSeen: string | null = null;
    for (const record of records) {
      const observed = observationIn(record, entry, id);
      if (observed === null) continue;
      if (firstSeen === null && observed.count > 0) firstSeen = record.time;
      if (record.floorHash === hash) sameFloor.push(observed);
    }
    const tracked = trackable ? follow(entry.count, sameFloor) : { accepted: entry.count, state: 'open' as const };
    return {
      entry,
      id,
      accepted: Math.min(entry.count, tracked.accepted),
      state: tracked.state,
      firstSeen,
      firstCount: sameFloor[0]?.count ?? null,
      lastCount: sameFloor[sameFloor.length - 1]?.count ?? null,
    };
  });

  const entries = identities
    .filter((identity) => identity.accepted > 0)
    .map((identity) => ({ ...identity.entry, count: identity.accepted }));
  const effective: EvidenceFloor =
    floor.scope === undefined ? { version: floor.version, entries } : { version: floor.version, scope: floor.scope, entries };
  return { floor: effective, identities: identities.sort((a, b) => identityKey(a.entry).localeCompare(identityKey(b.entry))) };
}

/**
 * What one record saw at one floor identity, or null when it holds no observation of it: the screen
 * was not in the scan, was scanned with a gap, or the identity was absent with nothing to show its
 * part of the page rendered. The rule and basis must match the floor entry too, so a record that
 * reuses a hash for another rule observes nothing.
 */
function observationIn(record: HistoryRecord, entry: FloorEntry, id: string): Observation | null {
  const screen = record.screens.find((candidate) => candidate.screenId === entry.screenId);
  if (screen === undefined || screen.coverage !== 'full') return null;
  const identity = screen.identities.find((candidate) => candidate.id === id);
  if (identity === undefined || identity.rule !== entry.rule || identity.basis !== entry.identityBasis) return null;
  return { sourceTree: record.sourceTree, count: identity.count };
}

/**
 * The accepted count and state after a sequence of observations, oldest first.
 *
 * Released: two observations in a row below the accepted count. The new accepted count is the
 * higher of the two, so a page that shows either reading again is not a regression.
 *
 * Intermittent: two observations of one source tree with different counts. The code did not change
 * and the reading did, so the barrier comes and goes. It gets the floor count back for good.
 */
function follow(floorCount: number, observations: readonly Observation[]): { accepted: number; state: TrackedState } {
  let accepted = floorCount;
  let state: TrackedState = 'open';
  let pending: Observation | null = null;
  const countsByTree = new Map<string, Set<number>>();
  for (const observation of observations) {
    const seenOnTree = countsByTree.get(observation.sourceTree) ?? new Set<number>();
    const differs = [...seenOnTree].some((count) => count !== observation.count);
    seenOnTree.add(observation.count);
    countsByTree.set(observation.sourceTree, seenOnTree);
    if (state === 'intermittent') continue;
    if (differs) {
      state = 'intermittent';
      accepted = floorCount;
      pending = null;
      continue;
    }
    if (observation.count < accepted) {
      if (pending !== null) {
        accepted = Math.max(pending.count, observation.count);
        state = 'confirmed-fixed';
        pending = null;
      } else {
        pending = observation;
      }
    } else {
      pending = null;
    }
  }
  return { accepted: Math.min(accepted, floorCount), state };
}

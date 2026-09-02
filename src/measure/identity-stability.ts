/**
 * Measurement-only harness for finding-identity stability across repeated scans.
 * Scanning an unchanged page twice should produce the same element keys. When it does not,
 * the differential engine sees one barrier as both fixed and new and reports a false regression.
 * This unit reports that drift. It must never call the gate, mint a verdict, or write a receipt.
 */
import type { Draft } from '../contracts/index.js';
import { computeIdentity } from '../primitives/identity.js';

// One observation of one screen in one round. `gap` means the round could not observe the screen
// completely, so its keys are disclosed as missing rather than compared.
export interface ScreenObservation {
  screenId: string;
  keys: string[];
  gap?: string;
}

export type StabilityRound = ScreenObservation[];

export interface ScreenStability {
  screenId: string;
  keyCountPerRound: Array<number | null>; // null where the round did not observe the screen
  unionSize: number;
  unstableKeys: string[]; // present in some observed rounds but not all
  driftRate: number; // unstable keys over the union; 0 when the union is empty
  stability: 'stable' | 'unstable' | 'inconclusive';
  gaps: string[];
}

export interface IdentityStabilityReport {
  rounds: number;
  screens: ScreenStability[];
  allScreensStable: boolean;
  note: 'measurement-only: no verdict minted, no receipt written, nothing gated';
}

const NOTE = 'measurement-only: no verdict minted, no receipt written, nothing gated';

// Four decimals keeps a ratio like 1/3 readable in JSON without pretending to more precision.
function driftRateOf(unstable: number, union: number): number {
  if (union === 0) {
    return 0;
  }
  return Math.round((unstable / union) * 10_000) / 10_000;
}

/**
 * Identity keys for one screen's drafts, in provider order and deduplicated.
 * The basis is part of the key: a control that stops resolving a name moves from a `name` key to a
 * `structural` key, and that swap is exactly the drift we are hunting, so it must not hide.
 * Identity-weak rules carry no element key, so they are numbered per screen and rule. That keeps
 * a change in how many such findings exist visible without inventing a name we do not have.
 */
export function identityKeysForDrafts(drafts: Draft[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const countOrdinals = new Map<string, number>();

  for (const draft of drafts) {
    const { elementKey, identityBasis } = computeIdentity(draft);
    let key: string;
    if (elementKey === null) {
      const bucket = `${draft.screenId}|${draft.rule}`;
      const ordinal = (countOrdinals.get(bucket) ?? 0) + 1;
      countOrdinals.set(bucket, ordinal);
      key = `count:${bucket}#${ordinal}`;
    } else {
      key = `${identityBasis}:${elementKey}`;
    }

    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }

  return keys;
}

function summarizeScreen(screenId: string, rounds: StabilityRound[]): ScreenStability {
  const keyCountPerRound: Array<number | null> = [];
  const gaps: string[] = [];
  const union: string[] = [];
  const observedRounds: Array<Set<string>> = [];

  rounds.forEach((round, index) => {
    const label = `round ${index + 1}`;
    const observation = round.find((entry) => entry.screenId === screenId);

    if (observation === undefined) {
      keyCountPerRound.push(null);
      gaps.push(`${label}: screen was not reported`);
      return;
    }

    if (observation.gap !== undefined) {
      // A partial key set would read as drift that the page did not cause, so the round is
      // disclosed and left out of the comparison instead of being scored.
      keyCountPerRound.push(null);
      gaps.push(`${label}: ${observation.gap}`);
      return;
    }

    const keys = new Set(observation.keys);
    observedRounds.push(keys);
    keyCountPerRound.push(keys.size);
    for (const key of keys) {
      if (!union.includes(key)) {
        union.push(key);
      }
    }
  });

  const unstableKeys = union.filter((key) => !observedRounds.every((keys) => keys.has(key)));

  // One comparable round cannot show drift, so it must not read as proof of stability.
  if (gaps.length === 0 && observedRounds.length < 2) {
    gaps.push('one round cannot show drift; run at least two');
  }

  return {
    screenId,
    keyCountPerRound,
    unionSize: union.length,
    unstableKeys,
    driftRate: driftRateOf(unstableKeys.length, union.length),
    stability: unstableKeys.length > 0 ? 'unstable' : gaps.length > 0 ? 'inconclusive' : 'stable',
    gaps,
  };
}

/**
 * Compares the key sets that N rounds produced for the same screens.
 * Screens keep first-seen order so the report reads in the order the operator listed them.
 */
export function analyzeIdentityStability(rounds: StabilityRound[]): IdentityStabilityReport {
  const screenIds: string[] = [];
  for (const round of rounds) {
    for (const observation of round) {
      if (!screenIds.includes(observation.screenId)) {
        screenIds.push(observation.screenId);
      }
    }
  }

  const screens = screenIds.map((screenId) => summarizeScreen(screenId, rounds));

  return {
    rounds: rounds.length,
    screens,
    // No screens measured is not stability. An empty run stays false so it cannot read as a pass.
    allScreensStable: screens.length > 0 && screens.every((screen) => screen.stability === 'stable'),
    note: NOTE,
  };
}

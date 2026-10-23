/**
 * Floor entries a run did not see and cannot call fixed, for the commands that rewrite the floor.
 *
 * `usabl floor prune` and `usabl baseline` both drop entries the run saw go away. A clean scan is
 * not enough to say that: a screen whose content failed to mount is scanned cleanly and shows every
 * barrier in that content as absent. So both commands ask the gate's own rule, paydownConfirmed,
 * with render evidence built from the same scans, and keep what it cannot confirm. One rule in one
 * place means the floor a command writes and the claim a run makes cannot disagree.
 *
 * The lines name screens and rules, never an element key, because a key carries page text.
 */
import type { FloorEntry, RenderEvidence, ScreenScan } from '../contracts/index.js';
import { paydownConfirmed, renderEvidenceOf } from '../gate/index.js';
import { computeIdentity, identityKey } from '../primitives/identity.js';
import { neutralize } from '../primitives/neutralize.js';

/** Absent entries on one screen that the run cannot confirm were fixed. */
export interface UnconfirmedOnScreen {
  screenId: string;
  rules: Set<string>;
  entries: number;
  barriers: number;
}

/** What one run showed, read once and asked about each floor entry. */
export interface FloorObservation {
  cleanlyScanned: Set<string>;
  observedCounts: Map<string, number>;
  renderEvidence: Map<string, RenderEvidence>;
}

/**
 * How many deterministic barriers the run observed at each identity, which screens it scanned with
 * no gap, and what each screen showed of itself. Deterministic drafts only, matching what baseline
 * writes and what the gate compares.
 */
export function observeFloor(screens: readonly ScreenScan[]): FloorObservation {
  const observedCounts = new Map<string, number>();
  for (const screen of screens) {
    for (const draft of screen.drafts) {
      if (draft.evidenceClass !== 'deterministic') {
        continue;
      }
      const key = identityKey({ screenId: draft.screenId, rule: draft.rule, elementKey: computeIdentity(draft).elementKey });
      observedCounts.set(key, (observedCounts.get(key) ?? 0) + 1);
    }
  }
  return {
    cleanlyScanned: new Set(screens.filter((screen) => screen.gaps.length === 0).map((screen) => screen.screenId)),
    observedCounts,
    renderEvidence: renderEvidenceOf(screens),
  };
}

/** Absent on a cleanly scanned screen, with nothing to show its part of the page rendered. */
export function isUnconfirmedAbsence(entry: FloorEntry, seen: FloorObservation): boolean {
  return (
    seen.cleanlyScanned.has(entry.screenId) &&
    (seen.observedCounts.get(identityKey(entry)) ?? 0) === 0 &&
    !paydownConfirmed(entry, seen.renderEvidence.get(entry.screenId))
  );
}

/** Groups entries by screen, in screen order, so the lines do not depend on floor order. */
export function groupByScreen(entries: readonly FloorEntry[]): UnconfirmedOnScreen[] {
  const byScreen = new Map<string, UnconfirmedOnScreen>();
  for (const entry of entries) {
    const screen = byScreen.get(entry.screenId) ?? { screenId: entry.screenId, rules: new Set<string>(), entries: 0, barriers: 0 };
    screen.rules.add(entry.rule);
    screen.entries += 1;
    screen.barriers += entry.count;
    byScreen.set(entry.screenId, screen);
  }
  return [...byScreen.keys()].sort().map((screenId) => byScreen.get(screenId)!);
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The lines for entries a command kept because the run cannot confirm they were fixed. */
export function keptUnconfirmedLines(screens: readonly UnconfirmedOnScreen[]): string[] {
  return screens.map((screen) => {
    const they = screen.entries === 1 ? 'it' : 'they';
    const are = screen.entries === 1 ? 'is' : 'are';
    return (
      `kept ${plural(screen.entries, 'floor entry', 'floor entries')} (${plural(screen.barriers, 'barrier', 'barriers')}) ` +
      `on screen ${neutralize(screen.screenId)} (${[...screen.rules].sort().map((rule) => neutralize(rule)).join(', ')}) ` +
      `that this run did not see, because nothing shows that part of the page rendered, so ${they} ${are} not ` +
      `claimed fixed. If ${they} ${are} fixed, add a reachedWhen signal for this screen or run usabl floor prune --unconfirmed.`
    );
  });
}

/** The lines for entries prune removed because the operator passed --unconfirmed. */
export function removedUnconfirmedLines(screens: readonly UnconfirmedOnScreen[]): string[] {
  return screens.map((screen) => {
    const one = screen.entries === 1;
    return (
      `${screen.entries} of them (${plural(screen.barriers, 'barrier', 'barriers')}) on screen ` +
      `${neutralize(screen.screenId)} ${one ? 'was' : 'were'} removed because you passed --unconfirmed: ` +
      `this run did not see ${one ? 'it' : 'them'} and cannot show that part of the page rendered.`
    );
  });
}

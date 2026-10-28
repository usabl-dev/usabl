/**
 * Floor entries a run did not see and cannot call fixed, for the commands that rewrite the floor.
 *
 * `usabl floor prune` and `usabl baseline` both drop entries the run saw go away. A clean scan is
 * not enough to say that: a screen whose content failed to mount is scanned cleanly and shows every
 * barrier in that content as absent. So both commands ask the gate's own rule, paydownConfirmed,
 * with render evidence built from the same scans, and keep what it cannot confirm. One rule in one
 * place means the floor a command writes and the claim a run makes cannot disagree.
 *
 * The lines name screens and rules, never an element key, because a key carries page text. Each
 * screen id and rule goes through the same scrubber the Result surfaces use, so a value the id
 * grammar allows, such as one carrying a token, is redacted before it is printed.
 */
import type { FloorEntry, RenderEvidence, ScreenScan } from '../contracts/index.js';
import { deterministicCountsByIdentity, floorEntryAbsent, paydownConfirmed, renderEvidenceOf } from '../gate/index.js';
import { identityKey, type IdentityScheme } from '../primitives/identity.js';
import { sortBy } from '../primitives/sortKey.js';
import { scrubString } from '../surfaces/scrub.js';

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
export function observeFloor(screens: readonly ScreenScan[], scheme: IdentityScheme = 'row-scoped'): FloorObservation {
  // The gate's own tally, keyed with the floor's scheme as the gate keys it, so an identity is
  // absent here exactly when it is absent there.
  const observedCounts = deterministicCountsByIdentity(screens.flatMap((screen) => screen.drafts), scheme);
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
    floorEntryAbsent(entry, seen.observedCounts) &&
    !paydownConfirmed(entry, seen.renderEvidence.get(entry.screenId))
  );
}

/**
 * Groups entries by screen, in screen order, so the lines do not depend on floor order. The
 * entries are added in identity order, which has no ties, so a sum past the range a number holds
 * exactly still comes out the same whatever order the floor listed them in.
 */
export function groupByScreen(entries: readonly FloorEntry[]): UnconfirmedOnScreen[] {
  const byScreen = new Map<string, UnconfirmedOnScreen>();
  for (const entry of sortBy([...entries], identityKey)) {
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
      `on screen ${scrubString(screen.screenId)} (${[...screen.rules].sort().map((rule) => scrubString(rule)).join(', ')}) ` +
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
      `${scrubString(screen.screenId)} ${one ? 'was' : 'were'} removed because you passed --unconfirmed: ` +
      `this run did not see ${one ? 'it' : 'them'} and cannot show that part of the page rendered.`
    );
  });
}

/**
 * The checks gate() runs on its own input before it reads any of it.
 *
 * gate() is exported, so a library caller can build a GateInput by hand and skip every file
 * reader that would have checked it. Two gaps follow from that. A floor with two entries at one
 * identity is indexed last-wins, so which entry survives decides whether a barrier reads as new
 * or carried, and one ordering is a false green. And an id the shared grammar refuses can reach
 * the gate on any of the id fields, where it can never match the screen it seems to name.
 *
 * So the gate parses the floor with the same parser the floor file goes through, and checks
 * every screen and surface id against the shared id grammar. A refusal is an InputRefusedError
 * that names the field and its position and never repeats the value. On the command path every
 * one of these inputs already passed a file reader, so these checks refuse nothing there that a
 * reader would have accepted.
 *
 * This unit validates input only. It must never decide a verdict.
 */
import type { EvidenceFloor, GateInput } from '../contracts/index.js';
import { parseEvidenceFloor } from '../evidence/floor.js';
import { assertIdField, InputRefusedError } from '../intake/input-refusal.js';

const SOURCE = 'gate() input';

function assertArray(field: string, value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new InputRefusedError(field, `${SOURCE} ${field} must be an array.`);
  }
}

function itemAt(list: unknown[], index: number, field: string): Record<string, unknown> {
  const item = list[index];
  if (typeof item !== 'object' || item === null) {
    throw new InputRefusedError(field, `${SOURCE} ${field} must be an object.`);
  }
  return item as Record<string, unknown>;
}

/**
 * Checks a GateInput and returns the floor as the floor parser returned it. The gate reads that
 * floor, not the one it was handed, so nothing it reads skipped the parser.
 */
export function checkGateInput(input: GateInput): EvidenceFloor {
  const floor = parseEvidenceFloor(input.floor, { source: SOURCE, path: 'floor' });

  const coverage: unknown = input.coverage;
  if (typeof coverage !== 'object' || coverage === null) {
    throw new InputRefusedError('coverage', `${SOURCE} coverage must be an object.`);
  }
  const affected = (coverage as Record<string, unknown>)['affected'];
  assertArray('coverage.affected', affected);
  affected.forEach((_, index) => {
    const field = `coverage.affected[${index}]`;
    assertIdField(SOURCE, `${field}.screenId`, itemAt(affected, index, field)['screenId']);
  });

  const drafts: unknown = input.drafts;
  assertArray('drafts', drafts);
  drafts.forEach((_, index) => {
    const field = `drafts[${index}]`;
    assertIdField(SOURCE, `${field}.screenId`, itemAt(drafts, index, field)['screenId']);
  });

  const waivers: unknown = input.waivers;
  assertArray('waivers', waivers);
  waivers.forEach((_, index) => {
    const field = `waivers[${index}]`;
    assertIdField(SOURCE, `${field}.surface`, itemAt(waivers, index, field)['surface']);
  });

  // A set has no index of its own. The position is the order the set yields its members, which is
  // the order they were added, so a caller can find the member by counting from zero.
  const screens: unknown = input.cleanlyScannedScreens;
  if (
    typeof screens !== 'object' ||
    screens === null ||
    typeof (screens as ReadonlySet<unknown>).has !== 'function' ||
    typeof (screens as Iterable<unknown>)[Symbol.iterator] !== 'function'
  ) {
    throw new InputRefusedError('cleanlyScannedScreens', `${SOURCE} cleanlyScannedScreens must be a Set of screen ids.`);
  }
  let position = 0;
  for (const screenId of screens as Iterable<unknown>) {
    assertIdField(SOURCE, `cleanlyScannedScreens[${position}]`, screenId);
    position += 1;
  }

  return floor;
}

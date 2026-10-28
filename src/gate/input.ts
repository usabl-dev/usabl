/**
 * The checks gate() runs on its own input before it decides anything.
 *
 * gate() is exported, so a library caller can build a GateInput by hand and skip every reader
 * that would have checked it. Any field the verdict depends on can then be the wrong type, and a
 * wrong type is read in a way that looks like a pass: a `nothingToCheck` of "false" is truthy, so
 * the run reads as idle; an `evidenceClass` of "Deterministic" never gates; a `gaps` object with
 * no length reads as no gaps. A floor with two entries at one identity is indexed last-wins, so
 * entry order decides whether a barrier reads as new or carried.
 *
 * So the gate reads every input field once, checks what it read, and gates only the checked copy:
 *
 * - `coverage`, every draft, the floor, and every waiver go through the same readers their
 *   documents and files go through: the Result contract reader for coverage and drafts, and the
 *   floor and waiver parsers. Every closed set (evidence class, confidence, severity, gap state,
 *   provenance, identity basis) must hold one of its contract values, and every other field must
 *   be the type the contract gives it. A layer is a string: the contract leaves layers open.
 * - Every screen and surface id is checked against the shared id grammar.
 * - `guardDivergedPaths` must be a list of strings and `now` an ISO-8601 UTC timestamp.
 * - `cleanlyScannedScreens` must be a real Set. Its members are copied into a new Set, so the
 *   gate asks only that copy, never a `has` the caller supplied.
 * - `renderEvidence` is optional. When present it must be a real Map from screen id to an object
 *   with a boolean `signalHeld` and a real Set of string `elementSlots`. It is copied the same way,
 *   so the gate asks only its own Map and Sets. Dropping it would be quiet: every absent floored
 *   barrier would read as unconfirmed, and a library caller's pay-down would never happen.
 *
 * Reading once is the point of the copy. A getter that returned a checked value to the check and
 * a different value to the gate would otherwise put an unchecked value in the verdict.
 *
 * A refusal is an InputRefusedError that names the field and its position and never repeats the
 * value. On the command path every one of these inputs comes from the engine or from a reader that
 * already applies these checks, so these refuse nothing there that a reader would have accepted.
 *
 * This unit validates input only. It must never decide a verdict.
 */
import type { GateInput, RenderEvidence } from '../contracts/index.js';
import { parseEvidenceFloor } from '../evidence/floor.js';
import { parseWaiver, type WaiverOrigin } from '../evidence/waivers.js';
import { assertIdField, InputRefusedError } from '../intake/input-refusal.js';
import { readCoverageShape, readDraftShape } from '../intake/result-document.js';
import { assertIso8601Utc } from '../primitives/iso8601.js';

const SOURCE = 'gate() input';

const GATE_WAIVERS: WaiverOrigin = {
  source: SOURCE,
  label: (name, index) => `${SOURCE} waivers[${index}]${name.length === 0 ? '' : `.${name}`}`,
  field: (name, index) => `waivers[${index}]${name.length === 0 ? '' : `.${name}`}`,
};

function list(field: string, value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new InputRefusedError(field, `${SOURCE} ${field} must be an array.`);
  }
  // A copy, so the gate never reads the caller's array again.
  return Array.from(value);
}

/**
 * Checks a GateInput and returns a checked copy of it. The gate reads only the copy.
 */
export function checkGateInput(input: GateInput): GateInput {
  // Each top-level field is read exactly once, here.
  const rawCoverage: unknown = input.coverage;
  const rawGuard: unknown = input.guardDivergedPaths;
  const rawDrafts: unknown = input.drafts;
  const rawFloor: unknown = input.floor;
  const rawWaivers: unknown = input.waivers;
  const rawNow: unknown = input.now;
  const rawScreens: unknown = input.cleanlyScannedScreens;
  const rawEvidence: unknown = input.renderEvidence;

  const floor = parseEvidenceFloor(rawFloor, { source: SOURCE, path: 'floor' });

  const coverage = readCoverageShape(rawCoverage, 'coverage', SOURCE);
  coverage.affected.forEach((screen, index) =>
    assertIdField(SOURCE, `coverage.affected[${index}].screenId`, screen.screenId),
  );

  const guardDivergedPaths = list('guardDivergedPaths', rawGuard).map((path, index) => {
    if (typeof path !== 'string') {
      throw new InputRefusedError(`guardDivergedPaths[${index}]`, `${SOURCE} guardDivergedPaths[${index}] must be a string.`);
    }
    return path;
  });

  const drafts = list('drafts', rawDrafts).map((value, index) => {
    const draft = readDraftShape(value, `drafts[${index}]`, SOURCE);
    assertIdField(SOURCE, `drafts[${index}].screenId`, draft.screenId);
    return draft;
  });

  const waivers = list('waivers', rawWaivers).map((value, index) => parseWaiver(value, index, GATE_WAIVERS));

  if (typeof rawNow !== 'string') {
    throw new InputRefusedError('now', `${SOURCE} now must be a string.`);
  }
  try {
    assertIso8601Utc(rawNow, `${SOURCE} now`);
  } catch (err) {
    throw new InputRefusedError('now', err instanceof Error ? err.message : String(err));
  }

  // A real Set, read through Set's own iterator, so an object that only claims to be a set, or a
  // subclass that overrides has() or its iterator, cannot answer for members it does not hold.
  if (!(rawScreens instanceof Set)) {
    throw new InputRefusedError('cleanlyScannedScreens', `${SOURCE} cleanlyScannedScreens must be a Set of screen ids.`);
  }
  const cleanlyScannedScreens = new Set<string>();
  let position = 0;
  for (const screenId of Set.prototype.values.call(rawScreens)) {
    // The position is the order the set yields its members, which is the order they were added,
    // so a caller can find the member by counting from zero.
    assertIdField(SOURCE, `cleanlyScannedScreens[${position}]`, screenId);
    cleanlyScannedScreens.add(screenId);
    position += 1;
  }

  const renderEvidence = rawEvidence === undefined ? undefined : checkRenderEvidence(rawEvidence);

  const checked: GateInput = { coverage, guardDivergedPaths, drafts, floor, waivers, now: rawNow, cleanlyScannedScreens };
  if (renderEvidence !== undefined) checked.renderEvidence = renderEvidence;
  return checked;
}

/**
 * Checks render evidence and returns a copy built from what the Map and its Sets really hold, read
 * through Map's and Set's own iterators, so an overridden get(), has(), or iterator cannot answer
 * for entries they do not hold. A position counts from zero in the order the Map yields its
 * entries. A field is named by position, never by its key or slot, because a slot carries page
 * text.
 */
function checkRenderEvidence(raw: unknown): Map<string, RenderEvidence> {
  if (!(raw instanceof Map)) {
    throw new InputRefusedError('renderEvidence', `${SOURCE} renderEvidence must be a Map from screen id to render evidence.`);
  }
  const copy = new Map<string, RenderEvidence>();
  let position = 0;
  for (const [screenId, value] of Map.prototype.entries.call(raw) as IterableIterator<[unknown, unknown]>) {
    const at = `renderEvidence[${position}]`;
    assertIdField(SOURCE, `${at}.key`, screenId);
    if (typeof value !== 'object' || value === null) {
      throw new InputRefusedError(`${at}.value`, `${SOURCE} ${at}.value must be an object.`);
    }
    const record = value as Record<string, unknown>;
    const signalHeld = record['signalHeld'];
    const rawSlots = record['elementSlots'];
    if (typeof signalHeld !== 'boolean') {
      throw new InputRefusedError(`${at}.value.signalHeld`, `${SOURCE} ${at}.value.signalHeld must be a boolean.`);
    }
    if (!(rawSlots instanceof Set)) {
      throw new InputRefusedError(`${at}.value.elementSlots`, `${SOURCE} ${at}.value.elementSlots must be a Set of strings.`);
    }
    const elementSlots = new Set<string>();
    let slotPosition = 0;
    for (const slot of Set.prototype.values.call(rawSlots) as IterableIterator<unknown>) {
      if (typeof slot !== 'string') {
        const field = `${at}.value.elementSlots[${slotPosition}]`;
        throw new InputRefusedError(field, `${SOURCE} ${field} must be a string.`);
      }
      elementSlots.add(slot);
      slotPosition += 1;
    }
    copy.set(screenId, { signalHeld, elementSlots });
    position += 1;
  }
  return copy;
}

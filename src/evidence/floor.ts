/**
 * Evidence floor parser shared by run, floor prune, doctor, and the gate.
 * This unit validates floor values only.
 * It must never decide verdicts, infer debt status, or mutate parsed entries.
 *
 * The run path parses the floor file with it, and the exported gate() parses the floor it is
 * handed with it again, so a library caller that builds a floor by hand gets the same checks a
 * file gets. Every refusal is an InputRefusedError that names the field and its position and never
 * repeats the value, because a floor identity carries page-derived text.
 */
import type { EvidenceFloor, FloorEntry } from '../contracts/index.js';
import { identityKey } from '../primitives/identity.js';
import { assertIdField, InputRefusedError } from '../intake/input-refusal.js';

/**
 * Where a floor came from, for refusal messages. `source` names the file or the call, and `path`
 * is the field path of the floor inside it: empty for the file itself, `floor` for the gate input.
 */
export interface FloorOrigin {
  source: string;
  path: string;
}

const FLOOR_FILE: FloorOrigin = { source: 'evidence floor', path: '' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function fieldOf(path: string, name: string): string {
  return path.length === 0 ? name : `${path}.${name}`;
}

function refuse(origin: FloorOrigin, field: string, problem: string): never {
  const named = field.length === 0 ? '' : ` ${field}`;
  throw new InputRefusedError(field, `${origin.source}${named} ${problem}`);
}

export function parseFloorEntry(value: unknown, origin: FloorOrigin = FLOOR_FILE, at = 'entry'): FloorEntry {
  if (!isRecord(value)) {
    refuse(origin, at, 'must be an object');
  }

  const screenId = value['screenId'];
  const layer = value['layer'];
  const rule = value['rule'];
  const elementKey = value['elementKey'];
  const identityBasis = value['identityBasis'];
  const count = value['count'];

  // The screen id answers to the shared id grammar, the rule every other screen id answers to. A
  // floor entry the grammar refuses can never match a screen this engine scans, so it would sit in
  // the floor accepting nothing while reading as accepted debt.
  assertIdField(origin.source, fieldOf(at, 'screenId'), screenId);
  if (typeof layer !== 'string') refuse(origin, fieldOf(at, 'layer'), 'must be a string');
  if (typeof rule !== 'string') refuse(origin, fieldOf(at, 'rule'), 'must be a string');
  if (elementKey !== null && typeof elementKey !== 'string') {
    refuse(origin, fieldOf(at, 'elementKey'), 'must be a string or null');
  }
  if (identityBasis !== 'name' && identityBasis !== 'structural' && identityBasis !== 'count') {
    refuse(origin, fieldOf(at, 'identityBasis'), 'must be name, structural, or count');
  }
  // isSafeInteger, not isInteger: a value past 2^53 has already lost precision in the JSON parse
  // (9007199254740993 becomes ...992), so accepting it would compare the gate against a tally that
  // does not match what the file says. Reject anything that cannot be represented faithfully.
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    refuse(origin, fieldOf(at, 'count'), 'must be a non-negative safe integer');
  }

  return { screenId, layer, rule, elementKey, identityBasis, count };
}

export function parseEvidenceFloor(value: unknown, origin: FloorOrigin = FLOOR_FILE): EvidenceFloor {
  if (!isRecord(value)) {
    refuse(origin, origin.path, 'must be an object');
  }
  const version = value['version'];
  if (version !== 1 && version !== 2) {
    refuse(origin, fieldOf(origin.path, 'version'), 'must be 1 or 2');
  }
  const entriesField = fieldOf(origin.path, 'entries');
  const entriesRaw = value['entries'];
  if (!Array.isArray(entriesRaw)) {
    refuse(origin, entriesField, 'must be an array');
  }
  const scope = value['scope'];
  if (scope !== undefined && scope !== 'partial') {
    refuse(origin, fieldOf(origin.path, 'scope'), "must be 'partial' when present");
  }
  const entries = entriesRaw.map((entry, index) => parseFloorEntry(entry, origin, `${entriesField}[${index}]`));
  // The gate indexes the floor by screen|rule|elementKey (no layer). Two entries that share that
  // key would last-win, so a hand-edited or corrupt floor could drop debt, and which entry won
  // would decide the verdict. Fail closed so a quiet verdict cannot rest on an ambiguous floor.
  // Use the shared identityKey so this check keys the floor exactly as the gate does. The two
  // entries are named by position, never by key, because the key carries page-derived text.
  const firstIndexByIdentity = new Map<string, number>();
  entries.forEach((entry, index) => {
    const key = identityKey(entry);
    const firstIndex = firstIndexByIdentity.get(key);
    if (firstIndex !== undefined) {
      refuse(
        origin,
        `${entriesField}[${index}]`,
        `has a duplicate identity: it has the same screenId, rule, and elementKey as ${entriesField}[${firstIndex}]. ` +
          'The floor is keyed by that identity, so one entry would silently replace the other. ' +
          'Merge the two entries into one, or run "usabl baseline" to write the floor again.',
      );
    }
    firstIndexByIdentity.set(key, index);
  });
  // The version is carried through, not normalized. Readers need it to know whether the
  // per-entry counts are observed debt (version 2) or a placeholder 1 (version 1).
  // Scope is optional. Absent means a complete whole-application floor, so it is left off the
  // parsed object rather than defaulted, and no consumer changes behavior on it.
  return scope === undefined ? { version, entries } : { version, scope, entries };
}

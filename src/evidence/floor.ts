/**
 * Evidence floor JSON parser shared by run and floor-prune.
 * This unit validates floor bytes only.
 * It must never decide verdicts, infer debt status, or mutate parsed entries.
 */
import type { EvidenceFloor, FloorEntry } from '../contracts/index.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseFloorEntry(value: unknown): FloorEntry {
  if (!isRecord(value)) {
    throw new Error('evidence floor entry must be an object');
  }

  const screenId = value['screenId'];
  const layer = value['layer'];
  const rule = value['rule'];
  const elementKey = value['elementKey'];
  const identityBasis = value['identityBasis'];
  const count = value['count'];

  if (typeof screenId !== 'string') throw new Error('evidence floor entry screenId must be a string');
  if (typeof layer !== 'string') throw new Error('evidence floor entry layer must be a string');
  if (typeof rule !== 'string') throw new Error('evidence floor entry rule must be a string');
  if (elementKey !== null && typeof elementKey !== 'string') {
    throw new Error('evidence floor entry elementKey must be a string or null');
  }
  if (identityBasis !== 'name' && identityBasis !== 'structural' && identityBasis !== 'count') {
    throw new Error('evidence floor entry identityBasis must be name, structural, or count');
  }
  if (typeof count !== 'number') throw new Error('evidence floor entry count must be a number');

  return { screenId, layer, rule, elementKey, identityBasis, count };
}

export function parseEvidenceFloor(value: unknown): EvidenceFloor {
  if (!isRecord(value)) {
    throw new Error('evidence floor must be an object');
  }
  const version = value['version'];
  if (version !== 1 && version !== 2) {
    throw new Error('evidence floor version must be 1 or 2');
  }
  const entriesRaw = value['entries'];
  if (!Array.isArray(entriesRaw)) {
    throw new Error('evidence floor entries must be an array');
  }
  const scope = value['scope'];
  if (scope !== undefined && scope !== 'partial') {
    throw new Error("evidence floor scope must be 'partial' when present");
  }
  const entries = entriesRaw.map((entry) => parseFloorEntry(entry));
  // The version is carried through, not normalized. Readers need it to know whether the
  // per-entry counts are observed debt (version 2) or a placeholder 1 (version 1).
  // Scope is optional. Absent means a complete whole-application floor, so it is left off the
  // parsed object rather than defaulted, and no consumer changes behavior on it.
  return scope === undefined ? { version, entries } : { version, scope, entries };
}

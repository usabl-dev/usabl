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
  if (value['version'] !== 1) {
    throw new Error('evidence floor version must be 1');
  }
  const entriesRaw = value['entries'];
  if (!Array.isArray(entriesRaw)) {
    throw new Error('evidence floor entries must be an array');
  }
  return { version: 1, entries: entriesRaw.map((entry) => parseFloorEntry(entry)) };
}

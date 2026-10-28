/**
 * Waiver parser shared by the waiver ledger reader in run, doctor, and the gate.
 * This unit validates waiver values only. It must never decide a verdict or whether a waiver
 * applies.
 *
 * The run path parses `.usabl-waivers.json` with it, and the exported gate() parses the waivers it
 * is handed with it again, so a library caller that builds a waiver by hand gets the checks a
 * ledger file gets. The gate compares `expires` to its clock as text, which is only a date
 * comparison when both are ISO-8601 UTC, so "garbage" would otherwise read as later than any date
 * and the waiver would never expire.
 */
import type { Waiver } from '../contracts/index.js';
import { assertIdField, InputRefusedError } from '../intake/input-refusal.js';
import { assertIso8601Utc } from '../primitives/iso8601.js';

/**
 * Where a waiver came from, for refusal messages. `label` names a field in prose, and `field`
 * names its path with the waiver's position. The ledger file keeps the labels it always used,
 * such as "waiver expires", so its messages read as before.
 */
export interface WaiverOrigin {
  source: string;
  label: (name: string, index: number) => string;
  field: (name: string, index: number) => string;
}

export const WAIVER_LEDGER: WaiverOrigin = {
  source: 'waiver ledger',
  label: (name) => (name.length === 0 ? 'waiver entry' : `waiver ${name}`),
  field: (name, index) => `waivers[${index}]${name.length === 0 ? '' : `.${name}`}`,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const TEXT_FIELDS = ['rule', 'scope', 'reason', 'owner', 'approvedBy'] as const;

/** Parses one waiver, reading each field once, and returns a copy built from the checked fields. */
export function parseWaiver(value: unknown, index: number, origin: WaiverOrigin = WAIVER_LEDGER): Waiver {
  const refuse = (name: string, problem: string): never => {
    throw new InputRefusedError(origin.field(name, index), `${origin.label(name, index)} ${problem}`);
  };
  if (!isRecord(value)) {
    refuse('', 'must be an object');
  }
  const record = value as Record<string, unknown>;
  const text: Record<string, string> = {};
  for (const name of TEXT_FIELDS) {
    const field = record[name];
    if (typeof field !== 'string') refuse(name, 'must be a string');
    text[name] = field as string;
  }
  // The surface is a screen id, so it answers to the shared id grammar. A surface the grammar
  // refuses can never match a screen, so the waiver would match nothing while reading as live.
  // The refusal names the waiver by position and never repeats the id.
  const surface = record['surface'];
  assertIdField(origin.source, origin.field('surface', index), surface);
  const dates: Record<'created' | 'expires', string> = { created: '', expires: '' };
  for (const name of ['created', 'expires'] as const) {
    const field = record[name];
    if (typeof field !== 'string') refuse(name, 'must be a string');
    try {
      assertIso8601Utc(field as string, origin.label(name, index));
    } catch (err) {
      // The timestamp check never quotes the value, so its message is passed through as is.
      throw new InputRefusedError(origin.field(name, index), err instanceof Error ? err.message : String(err));
    }
    dates[name] = field as string;
  }
  return {
    rule: text['rule']!,
    surface,
    scope: text['scope']!,
    reason: text['reason']!,
    owner: text['owner']!,
    approvedBy: text['approvedBy']!,
    created: dates.created,
    expires: dates.expires,
  };
}

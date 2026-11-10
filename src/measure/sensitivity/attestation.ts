/**
 * The sensitivity attestation: what the catalog measured, written to `.usabl/sensitivity.json`, and
 * the short summary printed with it.
 *
 * It says what was measured and nothing more. It carries no verdict and no receipt, and the gate,
 * the stop hook, and every other verdict path never read it. It is deterministic: the same tree,
 * versions, and pages give the same bytes apart from the date, which is an input. It is scrubbed on
 * the way out like every other output, because a gap reason can carry a URL or page words.
 */
import { scrubOutboundData, scrubString } from '../../surfaces/scrub.js';
import {
  catalogHash,
  GENERAL_NOT_EXERCISED_REASON,
  NOT_EXERCISED_REASONS,
  OFF_BY_DEFAULT_REASON,
  SENSITIVITY_CATALOG,
  SENSITIVITY_CATALOG_VERSION,
  type CatalogEntry,
} from './catalog.js';
import { ruleMatches, shippedRules, type ShippedRule } from './rules.js';
import { SENSITIVITY_OUTCOMES, type EntryMeasurement, type SensitivityOutcome } from './runner.js';

export const SENSITIVITY_ATTESTATION_PATH = '.usabl/sensitivity.json';
export const SENSITIVITY_SCHEMA = 'usabl.sensitivity.v1';
const NOTE = 'measurement only: no verdict minted, no receipt written, nothing gated';

export type SensitivityLevel = 'fixture' | 'app';

export interface AttestationEntry {
  entry: string;
  description: string;
  criterion: string;
  expectedRules: string[];
  expectedClass: 'deterministic' | 'preview';
  screen: string;
  outcome: SensitivityOutcome;
  rules: string[];
  reason: string | null;
}

export interface AttestationLevel {
  screens: string[];
  entries: AttestationEntry[];
  totals: Record<SensitivityOutcome, number>;
  // Entries whose mutation was made and whose two scans were readable: everything but not
  // applicable and unreadable. The "of M" in the summary.
  measured: number;
}

export interface SensitivityAttestation {
  schemaVersion: typeof SENSITIVITY_SCHEMA;
  note: typeof NOTE;
  date: string;
  engineVersion: string;
  scannerVersions: { axeCore: string; playwright: string; chromium: string };
  catalog: { version: number; hash: string; entries: number };
  levels: { fixture: AttestationLevel | null; app: AttestationLevel | null };
  notExercised: Array<{ rule: string; layer: ShippedRule['layer']; reason: string }>;
}

export interface AttestationInput {
  date: string;
  engineVersion: string;
  scannerVersions: { axeCore: string; playwright: string; chromium: string };
  fixture: { screens: readonly string[]; measurements: readonly EntryMeasurement[] } | null;
  app: { screens: readonly string[]; measurements: readonly EntryMeasurement[] } | null;
  catalog?: readonly CatalogEntry[];
}

function emptyTotals(): Record<SensitivityOutcome, number> {
  return Object.fromEntries(SENSITIVITY_OUTCOMES.map((outcome) => [outcome, 0])) as Record<SensitivityOutcome, number>;
}

const UNMEASURED: ReadonlySet<SensitivityOutcome> = new Set(['not applicable', 'unreadable']);

function buildLevel(
  input: { screens: readonly string[]; measurements: readonly EntryMeasurement[] },
  catalog: readonly CatalogEntry[],
): AttestationLevel {
  const order = new Map(catalog.map((entry, index) => [entry.id, index]));
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  const sorted = [...input.measurements].sort((a, b) => {
    const byEntry = (order.get(a.entry) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.entry) ?? Number.MAX_SAFE_INTEGER);
    if (byEntry !== 0) return byEntry;
    return a.screen < b.screen ? -1 : a.screen > b.screen ? 1 : 0;
  });
  const totals = emptyTotals();
  const entries = sorted.map((measurement): AttestationEntry => {
    totals[measurement.outcome] += 1;
    const entry = byId.get(measurement.entry);
    return {
      entry: measurement.entry,
      description: entry?.description ?? '',
      criterion: entry === undefined ? '' : `${entry.criterion.id} ${entry.criterion.name}`,
      expectedRules: [...(entry?.expectedRules ?? [])],
      expectedClass: entry?.expectedClass ?? 'deterministic',
      screen: measurement.screen,
      outcome: measurement.outcome,
      rules: [...measurement.rules].sort(),
      reason: measurement.reason,
    };
  });
  return {
    screens: [...input.screens].sort(),
    entries,
    totals,
    measured: entries.filter((entry) => !UNMEASURED.has(entry.outcome)).length,
  };
}

/** Every shipped rule no catalog entry expects, with the reason. */
export function notExercised(catalog: readonly CatalogEntry[] = SENSITIVITY_CATALOG): SensitivityAttestation['notExercised'] {
  const expected = catalog.flatMap((entry) => entry.expectedRules);
  return shippedRules()
    .filter((rule) => !expected.some((pattern) => ruleMatches(pattern, rule.rule)))
    .map((rule) => ({
      rule: rule.rule,
      layer: rule.layer,
      reason: NOT_EXERCISED_REASONS[rule.rule] ?? (rule.offByDefault === true ? OFF_BY_DEFAULT_REASON : GENERAL_NOT_EXERCISED_REASON),
    }));
}

export function buildAttestation(input: AttestationInput): SensitivityAttestation {
  const catalog = input.catalog ?? SENSITIVITY_CATALOG;
  const attestation: SensitivityAttestation = {
    schemaVersion: SENSITIVITY_SCHEMA,
    note: NOTE,
    date: input.date,
    engineVersion: input.engineVersion,
    scannerVersions: {
      axeCore: input.scannerVersions.axeCore,
      playwright: input.scannerVersions.playwright,
      chromium: input.scannerVersions.chromium,
    },
    catalog: { version: SENSITIVITY_CATALOG_VERSION, hash: catalogHash(), entries: catalog.length },
    levels: {
      fixture: input.fixture === null ? null : buildLevel(input.fixture, catalog),
      app: input.app === null ? null : buildLevel(input.app, catalog),
    },
    notExercised: notExercised(catalog),
  };
  return scrubOutboundData(attestation);
}

/** The file's bytes: two-space JSON and a final newline. */
export function serializeAttestation(attestation: SensitivityAttestation): string {
  return `${JSON.stringify(attestation, null, 2)}\n`;
}

const LEVEL_PLACE: Record<SensitivityLevel, string> = {
  fixture: 'the fixture pages',
  app: 'the app screens',
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function levelLines(level: SensitivityLevel, data: AttestationLevel): string[] {
  const place = LEVEL_PLACE[level];
  const lines: string[] = [];
  if (data.measured === 0) {
    lines.push(`On ${place}: measured nothing. No catalog defect could be made and read on these screens, so this is not a pass.`);
  } else {
    lines.push(`On ${place}: caught ${data.totals.caught} of ${data.measured} catalog defects.`);
  }
  lines.push(`  ${SENSITIVITY_OUTCOMES.map((outcome) => `${outcome} ${data.totals[outcome]}`).join(', ')}`);
  const listed: Array<[SensitivityOutcome, string]> = [
    ['missed', 'Missed'],
    ['caught by another rule', 'Caught by another rule'],
    ['preview only', 'Preview only'],
    ['unreadable', 'Unreadable'],
    ['not applicable', 'Not applicable'],
  ];
  for (const [outcome, heading] of listed) {
    const entries = data.entries.filter((entry) => entry.outcome === outcome);
    if (entries.length === 0) continue;
    lines.push(`  ${heading}:`);
    for (const entry of entries) {
      const expected = entry.expectedRules.length === 0 ? 'no shipped rule' : entry.expectedRules.join(' or ');
      lines.push(`    ${entry.entry} on ${entry.screen}. Expected: ${expected}. ${entry.reason ?? ''}`.trimEnd());
    }
  }
  return lines;
}

/** The terminal summary. Counts with their totals, every miss by name, and nothing more. */
export function formatAttestationSummary(attestation: SensitivityAttestation, writtenTo: string): string {
  const lines = ['usabl verify sensitivity: measurement only. It decides no verdict and writes no receipt.'];
  for (const level of ['fixture', 'app'] as const) {
    const data = attestation.levels[level];
    if (data !== null) {
      lines.push(...levelLines(level, data));
    }
  }
  lines.push(`${plural(attestation.notExercised.length, 'shipped rule')} not exercised by the catalog are listed in the file.`);
  lines.push(`Wrote ${writtenTo}.`);
  return `${lines.map((line) => scrubString(line)).join('\n')}\n`;
}

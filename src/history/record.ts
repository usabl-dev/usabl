/**
 * One debt history record: what one scan of main saw of the accepted debt.
 *
 * The history lives on its own branch in the team's repository, as JSON Lines files with one file
 * per month. Only the default-branch CI job writes it, after a scan of main. A pull request run
 * reads it as git objects from the fetched branch, never from the pull request tree.
 *
 * A record holds hashes and counts only. Per screen it says whether the screen was scanned with no
 * gap, and per floored identity it holds a 16 hex character hash of the identity key, the rule,
 * the identity basis, and how many barriers the scan saw there. It never holds an element key or
 * any page text. The parser refuses any field it does not know, so a record cannot carry text the
 * writer did not put there.
 *
 * This unit builds, writes, and reads records. It must never decide a verdict.
 */
import type { EvidenceFloor, FloorEntry, IdentityBasis, RenderEvidence, ScreenScan } from '../contracts/index.js';
import { paydownConfirmed } from '../gate/index.js';
import { canonicalHash, sha256 } from '../primitives/canonical.js';
import { assertIso8601Utc } from '../primitives/iso8601.js';
import { identityKey, identitySchemeFor } from '../primitives/identity.js';
import { sortBy } from '../primitives/sortKey.js';
import { describeIdProblem } from '../intake/id-grammar.js';
import { observeFloor } from '../floor/unconfirmed.js';

export const HISTORY_SCHEMA = 'usabl.history.v1';
/** The branch the history lives on, in the team's own repository. */
export const HISTORY_BRANCH = 'usabl/history';
/** Where a run reads the history: the branch as fetched from the remote. */
export const HISTORY_REMOTE_REF = `origin/${HISTORY_BRANCH}`;

export interface HistoryIdentity {
  id: string; // first 16 hex characters of sha256(identityKey(entry))
  rule: string;
  basis: IdentityBasis;
  count: number; // deterministic barriers the scan saw at this identity
}

export interface HistoryScreen {
  screenId: string;
  // full: every scan of the screen had no coverage gap. partial: it did not, and the record then
  // holds no identities for it, because a gapped scan observes nothing usabl can rely on.
  coverage: 'full' | 'partial';
  identities: HistoryIdentity[];
}

export interface HistoryRecord {
  schema: typeof HISTORY_SCHEMA;
  time: string; // ISO-8601 UTC, when the scan ran
  commit: string; // the main commit that was scanned
  // The four receipt bindings of the scan.
  sourceTree: string;
  policyHash: string;
  runnerVersion: string;
  scannerVersions: { axeCore: string; playwright: string; chromium: string };
  floorHash: string; // floorHashOf the evidence floor the scan was compared with
  screens: HistoryScreen[];
}

/** The hash a record names a floored identity by. Never the key itself, which carries page text. */
export function identityId(entry: { screenId: string; rule: string; elementKey: string | null }): string {
  return sha256(identityKey(entry)).slice(0, 16);
}

/**
 * The hash of an evidence floor, independent of entry order. A record only speaks for the floor it
 * was compared with: a floor written again by baseline or prune starts a new history.
 */
export function floorHashOf(floor: EvidenceFloor): string {
  return canonicalHash({
    version: floor.version,
    scope: floor.scope ?? null,
    entries: sortBy(
      floor.entries.map((entry) => [entry.screenId, entry.rule, entry.elementKey, entry.identityBasis, entry.count]),
      (entry) => JSON.stringify(entry),
    ),
  });
}

/** The month file a record at this time is appended to, for example "2026-10.jsonl". */
export function historyFileFor(time: string): string {
  return `${time.slice(0, 7)}.jsonl`;
}

/** True for a name the writer gives a month file. Other files on the branch are not read. */
export function isHistoryFile(path: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])\.jsonl$/.test(path);
}

export interface RecordInput {
  time: string;
  commit: string;
  sourceTree: string;
  policyHash: string;
  runnerVersion: string;
  scannerVersions: { axeCore: string; playwright: string; chromium: string };
  floor: EvidenceFloor;
  screens: readonly ScreenScan[];
}

/**
 * The record for one scan of main.
 *
 * An identity is observed on a screen only when every scan of that screen had no gap. Its count is
 * the deterministic tally the gate compares, keyed with the floor's scheme. A count at or above the
 * floor's count is recorded as seen. A count below it is recorded only when the scan shows the
 * identity's part of the page rendered (lowerCountConfirmed). Otherwise the record holds no
 * observation for it, because a screen whose content failed to mount shows the barriers in that
 * content as absent, and two such scans would release debt that was never fixed.
 */
export function buildRecord(input: RecordInput): HistoryRecord {
  const seen = observeFloor(input.screens, identitySchemeFor(input.floor));
  const fullScreens = new Set<string>();
  const partialScreens = new Set<string>();
  for (const screen of input.screens) {
    if (screen.gaps.length === 0) fullScreens.add(screen.screenId);
    else partialScreens.add(screen.screenId);
  }
  // A screen scanned more than once is full only if every scan of it was.
  for (const screenId of partialScreens) fullScreens.delete(screenId);

  const entriesByScreen = new Map<string, FloorEntry[]>();
  for (const entry of input.floor.entries) {
    const list = entriesByScreen.get(entry.screenId) ?? [];
    list.push(entry);
    entriesByScreen.set(entry.screenId, list);
  }

  const screenIds = [...new Set(input.screens.map((screen) => screen.screenId))].sort();
  const screens = screenIds.map((screenId): HistoryScreen => {
    if (!fullScreens.has(screenId)) return { screenId, coverage: 'partial', identities: [] };
    const entries = entriesByScreen.get(screenId) ?? [];
    // Two entries whose hashes collide cannot be told apart in a record, so neither is recorded and
    // both keep their full floor count.
    const idCounts = new Map<string, number>();
    for (const entry of entries) idCounts.set(identityId(entry), (idCounts.get(identityId(entry)) ?? 0) + 1);
    const identities: HistoryIdentity[] = [];
    for (const entry of entries) {
      const id = identityId(entry);
      if (idCounts.get(id) !== 1) continue;
      const count = seen.observedCounts.get(identityKey(entry)) ?? 0;
      if (count < entry.count && !lowerCountConfirmed(entry, count, seen.renderEvidence.get(screenId))) continue;
      identities.push({ id, rule: entry.rule, basis: entry.identityBasis, count });
    }
    return { screenId, coverage: 'full', identities: sortBy(identities, (identity) => identity.id) };
  });

  return {
    schema: HISTORY_SCHEMA,
    time: input.time,
    commit: input.commit,
    sourceTree: input.sourceTree,
    policyHash: input.policyHash,
    runnerVersion: input.runnerVersion,
    scannerVersions: {
      axeCore: input.scannerVersions.axeCore,
      playwright: input.scannerVersions.playwright,
      chromium: input.scannerVersions.chromium,
    },
    floorHash: floorHashOf(input.floor),
    screens,
  };
}

/**
 * Whether a count below the floor's count shows a fix rather than content that did not render.
 *
 * A zero uses the gate's own rule (paydownConfirmed): the readiness signal held, or the identity's
 * element was met. A nonzero count needs the readiness signal. The barriers the scan drew sit at
 * the identity's own element, so the element test would always pass, and one element drawn does
 * not show that the rest of the content rendered.
 */
function lowerCountConfirmed(entry: FloorEntry, count: number, evidence: RenderEvidence | undefined): boolean {
  if (count === 0) return paydownConfirmed(entry, evidence);
  return evidence?.signalHeld === true;
}

/** One record as one line of JSON, with its fields in a fixed order. No trailing newline. */
export function serializeRecord(record: HistoryRecord): string {
  return JSON.stringify(parseRecord(record, 'record'));
}

/** A record or a history file usabl will not read. The message names the field, never its value. */
export class HistoryRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoryRefusedError';
  }
}

function refuse(at: string, problem: string): never {
  throw new HistoryRefusedError(`${at} ${problem}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], at: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) refuse(at, 'has a field a history record does not hold');
  }
  for (const key of keys) {
    if (!(key in value)) refuse(`${at}.${key}`, 'is missing');
  }
}

const HEX_COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const HEX_256 = /^[0-9a-f]{64}$/;
const HEX_ID = /^[0-9a-f]{16}$/;
// Engine words: a version or a tree id. Short, printable, one line.
const ENGINE_WORD = /^[\x21-\x7e]{1,256}$/;
// A rule name, as the floor holds it. One line with no control characters.
const RULE_NAME = /^[^\x00-\x1f\x7f]{1,256}$/u;

function pattern(value: unknown, re: RegExp, at: string, what: string): string {
  if (typeof value !== 'string' || !re.test(value)) refuse(at, `must be ${what}`);
  return value;
}

function count(value: unknown, at: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    refuse(at, 'must be a non-negative safe integer');
  }
  return value;
}

function parseIdentity(value: unknown, at: string): HistoryIdentity {
  if (!isRecord(value)) refuse(at, 'must be an object');
  exactKeys(value, ['id', 'rule', 'basis', 'count'], at);
  const basis = value['basis'];
  if (basis !== 'name' && basis !== 'structural' && basis !== 'count' && basis !== 'row') {
    refuse(`${at}.basis`, 'must be name, structural, count, or row');
  }
  return {
    id: pattern(value['id'], HEX_ID, `${at}.id`, '16 lowercase hex characters'),
    rule: pattern(value['rule'], RULE_NAME, `${at}.rule`, 'a rule name'),
    basis,
    count: count(value['count'], `${at}.count`),
  };
}

function parseScreen(value: unknown, at: string): HistoryScreen {
  if (!isRecord(value)) refuse(at, 'must be an object');
  exactKeys(value, ['screenId', 'coverage', 'identities'], at);
  const screenId = value['screenId'];
  if (typeof screenId !== 'string' || describeIdProblem(screenId) !== null) refuse(`${at}.screenId`, 'must be a screen id');
  const coverage = value['coverage'];
  if (coverage !== 'full' && coverage !== 'partial') refuse(`${at}.coverage`, 'must be full or partial');
  const raw = value['identities'];
  if (!Array.isArray(raw)) refuse(`${at}.identities`, 'must be a list');
  const identities = raw.map((identity, index) => parseIdentity(identity, `${at}.identities[${index}]`));
  if (coverage === 'partial' && identities.length > 0) refuse(`${at}.identities`, 'must be empty on a partial screen');
  const ids = new Set<string>();
  identities.forEach((identity, index) => {
    if (ids.has(identity.id)) refuse(`${at}.identities[${index}].id`, 'repeats an identity on this screen');
    ids.add(identity.id);
  });
  return { screenId, coverage, identities };
}

/** Checks a parsed value against the record shape and returns a copy built from the checked fields. */
export function parseRecord(value: unknown, at = 'record'): HistoryRecord {
  if (!isRecord(value)) refuse(at, 'must be an object');
  exactKeys(value, ['schema', 'time', 'commit', 'sourceTree', 'policyHash', 'runnerVersion', 'scannerVersions', 'floorHash', 'screens'], at);
  if (value['schema'] !== HISTORY_SCHEMA) refuse(`${at}.schema`, `must be ${HISTORY_SCHEMA}`);
  const time = value['time'];
  if (typeof time !== 'string') refuse(`${at}.time`, 'must be an ISO-8601 UTC timestamp');
  try {
    assertIso8601Utc(time, `${at}.time`);
  } catch {
    refuse(`${at}.time`, 'must be an ISO-8601 UTC timestamp');
  }
  const scanners = value['scannerVersions'];
  if (!isRecord(scanners)) refuse(`${at}.scannerVersions`, 'must be an object');
  exactKeys(scanners, ['axeCore', 'playwright', 'chromium'], `${at}.scannerVersions`);
  const rawScreens = value['screens'];
  if (!Array.isArray(rawScreens)) refuse(`${at}.screens`, 'must be a list');
  const screens = rawScreens.map((screen, index) => parseScreen(screen, `${at}.screens[${index}]`));
  const screenIds = new Set<string>();
  screens.forEach((screen, index) => {
    if (screenIds.has(screen.screenId)) refuse(`${at}.screens[${index}].screenId`, 'repeats a screen in this record');
    screenIds.add(screen.screenId);
  });
  return {
    schema: HISTORY_SCHEMA,
    time,
    commit: pattern(value['commit'], HEX_COMMIT, `${at}.commit`, 'a full commit id'),
    sourceTree: pattern(value['sourceTree'], ENGINE_WORD, `${at}.sourceTree`, 'a tree id'),
    policyHash: pattern(value['policyHash'], HEX_256, `${at}.policyHash`, 'a sha256 hex digest'),
    runnerVersion: pattern(value['runnerVersion'], ENGINE_WORD, `${at}.runnerVersion`, 'a version'),
    scannerVersions: {
      axeCore: pattern(scanners['axeCore'], ENGINE_WORD, `${at}.scannerVersions.axeCore`, 'a version'),
      playwright: pattern(scanners['playwright'], ENGINE_WORD, `${at}.scannerVersions.playwright`, 'a version'),
      chromium: pattern(scanners['chromium'], ENGINE_WORD, `${at}.scannerVersions.chromium`, 'a version'),
    },
    floorHash: pattern(value['floorHash'], HEX_256, `${at}.floorHash`, 'a sha256 hex digest'),
    screens,
  };
}

/**
 * Every record in one month file, in the order they were appended. Any line usabl cannot read
 * refuses the whole file. Skipping a bad line would skip the observation on it, and a skipped
 * observation can make two absences look consecutive.
 */
export function parseHistoryFile(text: string, path: string): HistoryRecord[] {
  const records: HistoryRecord[] = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (line.length === 0 && index === lines.length - 1) return;
    const at = `${path} line ${index + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      refuse(at, 'is not JSON');
    }
    records.push(parseRecord(value, at));
  });
  return records;
}

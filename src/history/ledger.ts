/**
 * The ledger of how long accessibility barriers stay open: for each floor identity, when it was
 * first seen, whether it is open, fixed, or reopened, and how many days it was or has been open.
 *
 * It reads two sources, in this order of trust. First, the evidence floor file's own history on
 * the trusted branch: the commit where an identity enters the floor and the commit where it leaves.
 * Second, the debt history records: the record that confirms a floored barrier fixed, and the
 * records that show it seen again. Receipts are not a source, because a receipt holds counts and
 * no identities.
 *
 * "First seen" is the earliest evidence, never the day a barrier was introduced. A barrier in the
 * first floor shows that floor's date and is labelled as maybe older. When the history is
 * incomplete, the rows it touches say why, and the ledger never fills the gap with a guess.
 *
 * This is measurement only. It mints no verdict and no receipt, and no verdict path imports it.
 * Pure: the same snapshots, records, and clock always give the same ledger.
 */
import type { EvidenceFloor, FloorEntry, IdentityBasis } from '../contracts/index.js';
import { identityKey } from '../primitives/identity.js';
import { identityId, type HistoryRecord } from './record.js';

export const LEDGER_SCHEMA = 'usabl.ledger.v1';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A commit on the trusted branch and its committer date, in UTC. */
export interface LedgerPoint {
  commit: string;
  date: string;
}

/** The floor file at one commit on the trusted branch's first-parent line that changed it. */
export interface FloorSnapshot {
  commit: string;
  date: string;
  // The commit's place on the first-parent line, oldest first. Orders snapshots and records.
  position: number;
  // The floor as committed there, or null when the file is absent there or could not be read.
  floor: EvidenceFloor | null;
  // Why the file could not be read there, or null. It names the field, never its value.
  unreadable: string | null;
}

/** One history record, placed on the trusted branch's first-parent line, or not placed (null). */
export interface LedgerRecord {
  record: HistoryRecord;
  at: (LedgerPoint & { position: number }) | null;
}

export type LedgerHistory =
  | {
      kind: 'on';
      ref: string;
      head: string;
      // In append order.
      records: LedgerRecord[];
      // Records of commits the trusted branch does not contain. They do not apply.
      skipped: number;
    }
  | { kind: 'off'; ref: string; cause: 'no-history' | 'unreadable'; detail: string | null };

export interface LedgerInput {
  trustedRef: string;
  head: string;
  shallow: boolean;
  // Oldest first.
  snapshots: FloorSnapshot[];
  history: LedgerHistory;
  // The run's clock, ISO-8601 UTC.
  now: string;
}

export type LedgerState = 'open' | 'fixed' | 'reopened';

export interface LedgerSpanEnd extends LedgerPoint {
  // floor: it left the floor. history: two full scans of main in a row saw none. gap: the history
  // breaks here, so the ledger cannot tell whether it was fixed.
  by: 'floor' | 'history' | 'gap';
}

export interface LedgerSpan {
  start: LedgerPoint;
  end: LedgerSpanEnd | null;
  days: number;
}

export type LedgerGapCause =
  | 'shallow'
  | 'floor-rewritten'
  | 'floor-unreadable'
  | 'floor-deleted'
  | 'no-history'
  | 'history-unreadable'
  | 'record-off-line'
  | 'hash-collision';

export interface LedgerGap {
  cause: LedgerGapCause;
  detail: string;
}

export interface LedgerRow {
  screenId: string;
  rule: string;
  // As the floor stores it. Page-derived text: scrub it before any output.
  elementKey: string | null;
  identityBasis: IdentityBasis;
  firstSeen: LedgerPoint;
  // True when the first evidence is the first floor ever committed. The barrier may be older.
  firstSeenAtFirstBaseline: boolean;
  state: LedgerState;
  lastChange: LedgerPoint;
  spans: LedgerSpan[];
  daysOpen: number;
  // True when the true number of days can only be higher than daysOpen.
  lowerBound: boolean;
  // A fix the history confirmed came back on an unchanged source tree, so it was withdrawn.
  intermittent: boolean;
  incomplete: LedgerGap[];
}

export interface LedgerStateTotals {
  rows: number;
  medianDays: number | null;
  longestDays: number | null;
}

export interface Ledger {
  schema: typeof LEDGER_SCHEMA;
  trustedRef: string;
  head: string;
  now: string;
  shallow: boolean;
  floorCommits: number;
  history:
    | { kind: 'on'; ref: string; head: string; records: number; skipped: number }
    | { kind: 'off'; ref: string; cause: 'no-history' | 'unreadable'; detail: string | null };
  rows: LedgerRow[];
  totals: Record<LedgerState, LedgerStateTotals>;
}

interface OpenSpan {
  start: LedgerPoint;
  end: LedgerSpanEnd | null;
}

interface RowState {
  key: string;
  id: string;
  entry: FloorEntry;
  inFloor: boolean;
  spans: OpenSpan[];
  firstSeenAtFirstBaseline: boolean;
  lowerBound: boolean;
  intermittent: boolean;
  gaps: LedgerGap[];
  // The floor hash of a full scan that saw none here, waiting for a second one in a row.
  pendingZero: string | null;
  countsByTree: Map<string, Set<number>>;
}

interface FloorBreak {
  cause: 'floor-rewritten' | 'floor-unreadable' | 'floor-deleted';
  at: LedgerPoint;
  leave: string;
  enter: string;
}

function short(commit: string): string {
  return commit.slice(0, 12);
}

function daysBetween(start: string, end: string): number {
  return Math.max(0, Math.floor((Date.parse(end) - Date.parse(start)) / DAY_MS));
}

function isOpen(row: RowState): boolean {
  const last = row.spans[row.spans.length - 1];
  return last !== undefined && last.end === null;
}

function lastEnd(row: RowState): LedgerSpanEnd | null {
  return row.spans[row.spans.length - 1]?.end ?? null;
}

function addGap(row: RowState, gap: LedgerGap, lowerBound: boolean): void {
  if (!row.gaps.some((known) => known.cause === gap.cause && known.detail === gap.detail)) row.gaps.push(gap);
  if (lowerBound) row.lowerBound = true;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? null) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function buildLedger(input: LedgerInput): Ledger {
  const rows = new Map<string, RowState>();
  // screen and identity hash to the rows that hash to it. More than one is a collision.
  const byId = new Map<string, RowState[]>();
  let previous: { version: number } | null = null;
  let seenReadable = false;
  let pendingBreak: FloorBreak | null = null;

  function rowFor(entry: FloorEntry): RowState {
    const key = identityKey(entry);
    const known = rows.get(key);
    if (known !== undefined) {
      known.entry = entry;
      return known;
    }
    const row: RowState = {
      key,
      id: identityId(entry),
      entry,
      inFloor: false,
      spans: [],
      firstSeenAtFirstBaseline: false,
      lowerBound: false,
      intermittent: false,
      gaps: [],
      pendingZero: null,
      countsByTree: new Map(),
    };
    rows.set(key, row);
    const slot = `${entry.screenId}\u0000${row.id}`;
    const list = byId.get(slot) ?? [];
    list.push(row);
    byId.set(slot, list);
    return row;
  }

  function closeLeaving(row: RowState, at: LedgerPoint, cause: FloorBreak | null): void {
    row.inFloor = false;
    row.pendingZero = null;
    const last = row.spans[row.spans.length - 1];
    if (last === undefined || last.end !== null) return;
    if (cause === null) {
      last.end = { ...at, by: 'floor' };
      return;
    }
    last.end = { commit: cause.at.commit, date: cause.at.date, by: 'gap' };
    addGap(row, { cause: cause.cause, detail: cause.leave }, true);
  }

  function applySnapshot(snapshot: FloorSnapshot): void {
    const at: LedgerPoint = { commit: snapshot.commit, date: snapshot.date };
    if (snapshot.unreadable !== null) {
      pendingBreak ??= {
        cause: 'floor-unreadable',
        at,
        leave:
          `The floor could not be read at ${short(snapshot.commit)} (${snapshot.unreadable}). This identity was not in the ` +
          'next floor that could be read, so the ledger cannot tell when or why it left. Its days are counted to that commit.',
        enter:
          `The floor could not be read at ${short(snapshot.commit)} (${snapshot.unreadable}). This identity entered the floor ` +
          'while it could not be read, so it may be older.',
      };
      return;
    }
    if (snapshot.floor === null) {
      if (!seenReadable) return;
      const cause: FloorBreak = {
        cause: 'floor-deleted',
        at,
        leave:
          `The floor file was deleted at ${short(snapshot.commit)}. That is not a fix, so the ledger cannot tell whether ` +
          'this barrier was fixed. Its days are counted to that commit.',
        enter: `The floor file was deleted at ${short(snapshot.commit)} and written again later, so this identity may be older.`,
      };
      for (const row of rows.values()) if (row.inFloor) closeLeaving(row, at, cause);
      pendingBreak = cause;
      previous = null;
      return;
    }

    const floor = snapshot.floor;
    let cause: FloorBreak | null = pendingBreak;
    if (cause === null && previous !== null && previous.version !== floor.version) {
      cause = {
        cause: 'floor-rewritten',
        at,
        leave:
          `The floor was rewritten from version ${previous.version} to version ${floor.version} at ${short(snapshot.commit)}. ` +
          'This identity is not in the new floor, so the ledger cannot tell whether it was fixed or keyed again. ' +
          'Its days are counted to that commit.',
        enter:
          `This identity entered the floor when it was rewritten from version ${previous.version} to version ` +
          `${floor.version} at ${short(snapshot.commit)}. It may be older under an earlier key.`,
      };
    }
    const keys = new Set(floor.entries.map((entry) => identityKey(entry)));
    for (const row of rows.values()) {
      if (row.inFloor && !keys.has(row.key)) closeLeaving(row, at, cause);
    }
    const firstFloor = !seenReadable;
    for (const entry of floor.entries) {
      const row = rowFor(entry);
      if (row.inFloor) continue;
      row.inFloor = true;
      row.pendingZero = null;
      row.spans.push({ start: at, end: null });
      if (cause !== null) {
        addGap(row, { cause: cause.cause, detail: cause.enter }, true);
      } else if (firstFloor && row.spans.length === 1) {
        if (input.shallow) {
          addGap(
            row,
            {
              cause: 'shallow',
              detail:
                `This is a shallow clone, and ${short(snapshot.commit)} holds the oldest floor it has. ` +
                'This identity may be older. Fetch the full history (git fetch --unshallow) for its first seen date.',
            },
            true,
          );
        } else {
          row.firstSeenAtFirstBaseline = true;
        }
      }
    }
    seenReadable = true;
    previous = { version: floor.version };
    pendingBreak = null;
  }

  function observe(row: RowState, record: HistoryRecord, count: number, at: LedgerPoint): void {
    const seenOnTree = row.countsByTree.get(record.sourceTree) ?? new Set<number>();
    const differs = [...seenOnTree].some((seen) => seen !== count);
    seenOnTree.add(count);
    row.countsByTree.set(record.sourceTree, seenOnTree);
    if (row.intermittent) return;
    const end = lastEnd(row);
    if (differs) {
      // The same code gave two readings, so the barrier comes and goes with the page content. A fix
      // the history confirmed was not a fix, only a scan that did not show it.
      row.intermittent = true;
      row.pendingZero = null;
      const last = row.spans[row.spans.length - 1];
      if (last !== undefined && end?.by === 'history') last.end = null;
      return;
    }
    if (isOpen(row)) {
      if (count > 0) {
        row.pendingZero = null;
      } else if (row.pendingZero === record.floorHash) {
        const last = row.spans[row.spans.length - 1];
        if (last !== undefined) last.end = { ...at, by: 'history' };
        row.pendingZero = null;
      } else {
        row.pendingZero = record.floorHash;
      }
      return;
    }
    if (end?.by === 'history' && count > 0) {
      row.spans.push({ start: at, end: null });
      row.pendingZero = null;
    }
  }

  function observedRows(record: HistoryRecord, act: (row: RowState, count: number) => void, inFloorOnly = true): void {
    for (const screen of record.screens) {
      if (screen.coverage !== 'full') continue;
      for (const identity of screen.identities) {
        const matches = byId.get(`${screen.screenId}\u0000${identity.id}`) ?? [];
        if (matches.length > 1) {
          for (const row of matches) {
            addGap(
              row,
              {
                cause: 'hash-collision',
                detail: 'Two floor identities on this screen share one history hash, so the history cannot tell them apart and is not used for them.',
              },
              false,
            );
          }
          continue;
        }
        const row = matches[0];
        if (row === undefined || (inFloorOnly && !row.inFloor)) continue;
        if (identity.rule !== row.entry.rule || identity.basis !== row.entry.identityBasis) continue;
        act(row, identity.count);
      }
    }
  }

  const snapshots = input.snapshots;
  let next = 0;
  function applyUpTo(position: number): void {
    while (next < snapshots.length && (snapshots[next]?.position ?? Infinity) <= position) {
      const snapshot = snapshots[next];
      next += 1;
      if (snapshot !== undefined) applySnapshot(snapshot);
    }
  }

  const unplaced: HistoryRecord[] = [];
  if (input.history.kind === 'on') {
    for (const placed of input.history.records) {
      if (placed.at === null) {
        // It cannot be placed in time, so it may sit between two absences. It breaks a pending pair.
        unplaced.push(placed.record);
        observedRows(placed.record, (row) => {
          row.pendingZero = null;
        });
        continue;
      }
      applyUpTo(placed.at.position);
      const at: LedgerPoint = { commit: placed.at.commit, date: placed.at.date };
      observedRows(placed.record, (row, count) => observe(row, placed.record, count, at));
    }
  }
  applyUpTo(Infinity);
  // Named after the whole floor history is known, so a row it touches is named even when the
  // record came before that row's first floor in append order.
  const unplacedByRow = new Map<RowState, string[]>();
  for (const record of unplaced) {
    observedRows(
      record,
      (row) => {
        const commits = unplacedByRow.get(row) ?? [];
        if (!commits.includes(short(record.commit))) commits.push(short(record.commit));
        unplacedByRow.set(row, commits);
      },
      false,
    );
  }
  for (const [row, commits] of unplacedByRow) {
    const where = input.shallow ? 'this shallow clone does not hold' : `are not on the first-parent line of ${input.trustedRef}`;
    const detail =
      `${commits.length} history record${commits.length === 1 ? '' : 's'} name${commits.length === 1 ? 's' : ''} ` +
      `commits that ${where} (${commits.join(', ')}), so the ledger could not place them in time. ` +
      'They are not used, so a fix or a return they show is not counted.';
    addGap(row, { cause: 'record-off-line', detail }, false);
  }
  if (pendingBreak !== null) {
    // The floor at the head of the trusted branch could not be read.
    const cause: FloorBreak = pendingBreak;
    for (const row of rows.values()) if (row.inFloor) closeLeaving(row, cause.at, cause);
  }

  if (input.history.kind === 'off') {
    const gap: LedgerGap =
      input.history.cause === 'no-history'
        ? {
            cause: 'no-history',
            detail:
              `There is no debt history at ${input.history.ref}, so a fix main confirmed would not show here. ` +
              'This row may already be fixed, or fixed sooner.',
          }
        : {
            cause: 'history-unreadable',
            detail:
              `The debt history at ${input.history.ref} could not be read (${input.history.detail ?? 'no reason given'}), ` +
              'so a fix main confirmed would not show here. This row may already be fixed, or fixed sooner.',
          };
    for (const row of rows.values()) addGap(row, gap, false);
  }

  const built = [...rows.values()]
    .filter((row) => row.spans.length > 0)
    .map((row): LedgerRow => {
      const spans: LedgerSpan[] = row.spans.map((span) => ({
        start: span.start,
        end: span.end,
        days: daysBetween(span.start.date, span.end?.date ?? input.now),
      }));
      const first = spans[0] as LedgerSpan;
      const last = spans[spans.length - 1] as LedgerSpan;
      const fixedOnce = spans.slice(0, -1).some((span) => span.end?.by === 'floor' || span.end?.by === 'history');
      const fixedLast = last.end?.by === 'floor' || last.end?.by === 'history';
      const state: LedgerState = fixedOnce ? 'reopened' : fixedLast ? 'fixed' : 'open';
      return {
        screenId: row.entry.screenId,
        rule: row.entry.rule,
        elementKey: row.entry.elementKey,
        identityBasis: row.entry.identityBasis,
        firstSeen: first.start,
        firstSeenAtFirstBaseline: row.firstSeenAtFirstBaseline,
        state,
        lastChange: last.end === null ? last.start : { commit: last.end.commit, date: last.end.date },
        spans,
        daysOpen: spans.reduce((sum, span) => sum + span.days, 0),
        lowerBound: row.lowerBound,
        intermittent: row.intermittent,
        incomplete: [...row.gaps].sort((a, b) => (a.cause === b.cause ? a.detail.localeCompare(b.detail) : a.cause.localeCompare(b.cause))),
      };
    });
  const keyOf = (row: LedgerRow) => identityKey(row);
  built.sort((a, b) => (a.daysOpen === b.daysOpen ? keyOf(a).localeCompare(keyOf(b)) : b.daysOpen - a.daysOpen));

  const totalsFor = (state: LedgerState): LedgerStateTotals => {
    const days = built.filter((row) => row.state === state).map((row) => row.daysOpen);
    return { rows: days.length, medianDays: median(days), longestDays: days.length === 0 ? null : Math.max(...days) };
  };

  const history = input.history;
  return {
    schema: LEDGER_SCHEMA,
    trustedRef: input.trustedRef,
    head: input.head,
    now: input.now,
    shallow: input.shallow,
    floorCommits: snapshots.length,
    history:
      history.kind === 'on'
        ? { kind: 'on', ref: history.ref, head: history.head, records: history.records.length, skipped: history.skipped }
        : { kind: 'off', ref: history.ref, cause: history.cause, detail: history.detail },
    rows: built,
    totals: { open: totalsFor('open'), fixed: totalsFor('fixed'), reopened: totalsFor('reopened') },
  };
}

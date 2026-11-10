/**
 * The ledger of how long accessibility barriers stay open: for each floor identity, when it was
 * first seen, whether it is open, fixed, or reopened, and how many days it was or has been open.
 *
 * It reads two sources, in this order of trust. First, the evidence floor file's own history on
 * the trusted branch: the commit where an identity enters the floor and the commit where it leaves.
 * Second, the debt history records: the record that confirms a floored accessibility barrier
 * fixed, and the records that show it seen again. Receipts are not a source, because a receipt holds counts and
 * no identities.
 *
 * "First seen" is the earliest evidence, never the day an accessibility barrier was introduced. One
 * in the first floor shows that floor's date and is labelled as maybe older. When the history is
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

// fixed: the history showed it, with two full scans of main in a row that saw none. left-the-floor:
// it only left the floor, which a fix, a floor reset, a prune, and a renamed screen all look like.
export type LedgerState = 'open' | 'fixed' | 'left-the-floor' | 'reopened';

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
  | 'hash-collision'
  | 'first-floor-for-screen'
  | 'not-seen'
  | 'left-the-floor';

export interface LedgerGap {
  cause: LedgerGapCause;
  detail: string;
}

/** Why the true number of days could be larger than the one the ledger counts. */
export type LedgerMoreReason =
  // It was already in the floor the first time its screen was floored: the first baseline, a
  // screen floored for the first time, or a partial floor that was widened. It may be older.
  | 'first-floor-for-screen'
  // It was in the oldest floor a shallow clone holds.
  | 'shallow'
  // It entered the floor where the floor history breaks, so it may be older under an earlier key.
  | 'entered-at-gap'
  // A span ended where the floor history breaks, and it may have stayed open after.
  | 'ended-at-gap'
  // A span ended only because it left the floor. It may have stayed on the page after.
  | 'left-the-floor';

/** Why the true number of days could be smaller than the one the ledger counts. */
export type LedgerLessReason =
  // No usable history for it: no history, an unreadable one, or a hash it shares with another
  // identity. A fix the floor did not record would not show.
  | 'no-usable-history'
  // The history is on, but no full scan of main saw it during one of its spans.
  | 'not-seen'
  // A history record that touches it could not be placed in time.
  | 'history-unplaced'
  // A span ended only because it left the floor. It may have been fixed before.
  | 'left-the-floor';

export interface LedgerRow {
  screenId: string;
  rule: string;
  // As the floor stores it. Page-derived text: scrub it before any output.
  elementKey: string | null;
  identityBasis: IdentityBasis;
  firstSeen: LedgerPoint;
  // True when the first evidence is the first floor ever committed. It may be older.
  firstSeenAtFirstBaseline: boolean;
  state: LedgerState;
  lastChange: LedgerPoint;
  spans: LedgerSpan[];
  daysOpen: number;
  // Each number says which way it can be wrong. mayBeMore: the true number could be larger.
  // mayBeLess: it could be smaller. Neither: daysOpen is what happened, to the day. Both: not known.
  mayBeMore: boolean;
  mayBeMoreReasons: LedgerMoreReason[];
  mayBeLess: boolean;
  mayBeLessReasons: LedgerLessReason[];
  // The last full scan of main that saw it, in commit order, or null when no scan did.
  lastSeen: LedgerPoint | null;
  // A fix the history confirmed came back on an unchanged source tree, so it was withdrawn.
  intermittent: boolean;
  incomplete: LedgerGap[];
}

export interface LedgerStateTotals {
  rows: number;
  // The rows where neither mayBeMore nor mayBeLess holds. The median and the longest are over these
  // only, and are null when there are none.
  exactRows: number;
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

// A point with its place on the first-parent line. The place orders events; the date only counts days.
type Placed = LedgerPoint & { position: number };

interface OpenSpan {
  start: Placed;
  end: (LedgerSpanEnd & { position: number }) | null;
  // A full scan of main saw it while this span was open.
  seen?: boolean;
  // Where it left the floor after the history had already fixed this span. Used only when that fix
  // is withdrawn, so the span then ends where the floor alone says.
  leftAfter?: { at: Placed; cause: FloorBreak | null } | undefined;
}

/** The ledger broke one of its own rules. That is a bug in usabl, never a number to print. */
export class LedgerInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerInvariantError';
  }
}

interface RowState {
  key: string;
  id: string;
  entry: FloorEntry;
  inFloor: boolean;
  spans: OpenSpan[];
  firstSeenAtFirstBaseline: boolean;
  more: Set<LedgerMoreReason>;
  less: Set<LedgerLessReason>;
  lastSeen: LedgerPoint | null;
  intermittent: boolean;
  gaps: LedgerGap[];
  // The floor hash of a full scan that saw none here, waiting for a second one in a row.
  pendingZero: string | null;
  countsByTree: Map<string, Set<number>>;
}

interface FloorBreak {
  cause: 'floor-rewritten' | 'floor-unreadable' | 'floor-deleted';
  at: Placed;
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

function addGap(row: RowState, gap: LedgerGap, bound: { more?: LedgerMoreReason; less?: LedgerLessReason }): void {
  if (!row.gaps.some((known) => known.cause === gap.cause && known.detail === gap.detail)) row.gaps.push(gap);
  if (bound.more !== undefined) row.more.add(bound.more);
  if (bound.less !== undefined) row.less.add(bound.less);
}

// Code-unit order, so the output never depends on the runtime's locale.
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function slotOf(screenId: string, id: string, rule: string, basis: string): string {
  return JSON.stringify([screenId, id, rule, basis]);
}

function point(at: Placed): LedgerPoint {
  return { commit: at.commit, date: at.date };
}

/**
 * Spans must follow each other on the first-parent line, and a row's days can never be more than
 * the days from its first sighting to the end of its last span. A row that breaks either rule is a
 * bug in the replay, so the ledger stops instead of printing it.
 */
export function checkSpans(spans: ReadonlyArray<Pick<OpenSpan, 'start' | 'end'>>, endDate: string): void {
  let previousEnd = -Infinity;
  for (const span of spans) {
    const stop = span.end?.position ?? Infinity;
    if (span.start.position < previousEnd || stop < span.start.position) {
      throw new LedgerInvariantError('the ledger built spans that overlap or run backwards on the first-parent line');
    }
    previousEnd = stop;
  }
  const first = spans[0];
  if (first === undefined) return;
  const ordered = spans.every((span, index) => {
    const stopDate = span.end?.date ?? endDate;
    const before = spans[index - 1];
    const startOk = before === undefined || Date.parse(span.start.date) >= Date.parse(before.end?.date ?? endDate);
    return startOk && Date.parse(stopDate) >= Date.parse(span.start.date);
  });
  // Commit dates that go backwards are a fact of the repository, not a bug, so only ordered dates are checked.
  if (!ordered) return;
  const lastStop = spans[spans.length - 1]?.end?.date ?? endDate;
  const total = spans.reduce((sum, span) => sum + daysBetween(span.start.date, span.end?.date ?? endDate), 0);
  if (total > daysBetween(first.start.date, lastStop)) {
    throw new LedgerInvariantError('the ledger counted more days for a row than have passed since it was first seen');
  }
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
  // The scope of the last readable floor, kept across a deletion so a widened floor is still seen.
  let previousScope: 'partial' | 'whole' | null = null;
  // Every screen some readable floor so far has held.
  const flooredScreens = new Set<string>();
  let seenReadable = false;
  let pendingBreak: FloorBreak | null = null;
  // The identities that a record the ledger could not place in time observes.
  const unplacedSlots = new Set<string>();

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
      more: new Set(),
      less: new Set(),
      lastSeen: null,
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

  function closeLeaving(row: RowState, at: Placed, cause: FloorBreak | null): void {
    row.inFloor = false;
    row.pendingZero = null;
    const last = row.spans[row.spans.length - 1];
    if (last === undefined) return;
    if (last.end !== null) {
      // Already fixed by the history. Kept in case that fix is withdrawn later.
      if (last.end.by === 'history') last.leftAfter = { at, cause };
      return;
    }
    endSpan(row, last, at, cause);
  }

  function endSpan(row: RowState, last: OpenSpan, at: Placed, cause: FloorBreak | null): void {
    if (cause === null) {
      last.end = { ...at, by: 'floor' };
      addGap(
        row,
        {
          cause: 'left-the-floor',
          detail:
            `It left the floor at ${short(at.commit)}, and no two scans of main in a row saw it gone before then. ` +
            'usabl cannot tell a fix from a floor reset, a prune, or a renamed screen without the history, ' +
            'so its days may be larger or smaller.',
        },
        { more: 'left-the-floor', less: 'left-the-floor' },
      );
      return;
    }
    last.end = { ...cause.at, by: 'gap' };
    addGap(row, { cause: cause.cause, detail: cause.leave }, { more: 'ended-at-gap' });
  }

  function applySnapshot(snapshot: FloorSnapshot): void {
    const at: Placed = { commit: snapshot.commit, date: snapshot.date, position: snapshot.position };
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
          'this accessibility barrier was fixed. Its days are counted to that commit.',
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
    const scope = floor.scope === 'partial' ? 'partial' : 'whole';
    const widened = previousScope === 'partial' && scope === 'whole';
    for (const entry of floor.entries) {
      const row = rowFor(entry);
      if (row.inFloor) continue;
      row.inFloor = true;
      row.pendingZero = null;
      row.spans.push({ start: at, end: null });
      if (cause !== null) {
        addGap(row, { cause: cause.cause, detail: cause.enter }, { more: 'entered-at-gap' });
      } else if (firstFloor && input.shallow) {
        addGap(
          row,
          {
            cause: 'shallow',
            detail:
              `This is a shallow clone, and ${short(snapshot.commit)} holds the oldest floor it has. ` +
              'This identity may be older. Fetch the full history (git fetch --unshallow) for its first seen date.',
          },
          { more: 'shallow' },
        );
      } else if (firstFloor) {
        // The first baseline has its own label, so it needs no note.
        row.firstSeenAtFirstBaseline = true;
        row.more.add('first-floor-for-screen');
      } else if (!flooredScreens.has(entry.screenId) || widened) {
        addGap(
          row,
          {
            cause: 'first-floor-for-screen',
            detail: widened
              ? `A partial floor was widened at ${short(snapshot.commit)}, and this identity was in the wider floor, so it may be older.`
              : `Its screen was floored for the first time at ${short(snapshot.commit)}, and this identity was already there, so it may be older.`,
          },
          { more: 'first-floor-for-screen' },
        );
      }
    }
    for (const entry of floor.entries) flooredScreens.add(entry.screenId);
    seenReadable = true;
    previous = { version: floor.version };
    previousScope = scope;
    pendingBreak = null;
  }

  // Undo every fix the history confirmed on this row, last first. A withdrawn span ends where the
  // floor alone says it ends: where it left the floor, at the end of the span it reopened into, or
  // not at all while it is still in the floor.
  function withdrawFixes(row: RowState): void {
    for (let index = row.spans.length - 1; index >= 0; index -= 1) {
      const span = row.spans[index];
      if (span === undefined || span.end?.by !== 'history') continue;
      const after = span.leftAfter;
      const following = row.spans[index + 1];
      span.end = null;
      span.leftAfter = undefined;
      if (after !== undefined) {
        endSpan(row, span, after.at, after.cause);
      } else if (following !== undefined) {
        span.end = following.end;
        span.seen = span.seen === true || following.seen === true;
        span.leftAfter = following.leftAfter;
        row.spans.splice(index + 1, 1);
      }
    }
  }

  function observe(row: RowState, record: HistoryRecord, count: number, at: Placed): void {
    const seenOnTree = row.countsByTree.get(record.sourceTree) ?? new Set<number>();
    const differs = [...seenOnTree].some((seen) => seen !== count);
    seenOnTree.add(count);
    row.countsByTree.set(record.sourceTree, seenOnTree);
    if (count > 0) {
      row.lastSeen = point(at);
      const last = row.spans[row.spans.length - 1];
      if (last !== undefined && last.end === null) last.seen = true;
    }
    if (row.intermittent) return;
    const end = lastEnd(row);
    if (differs) {
      // The same code gave two readings, so it comes and goes with the page content. No fix the
      // history confirmed was a fix, only scans that did not show it, whether or not the row
      // reopened since. Debt tracking never releases such an identity again either.
      row.intermittent = true;
      row.pendingZero = null;
      withdrawFixes(row);
      return;
    }
    if (isOpen(row)) {
      if (count > 0) {
        row.pendingZero = null;
      } else if (row.pendingZero === record.floorHash && !unplacedSlots.has(slotOf(row.entry.screenId, row.id, row.entry.rule, row.entry.identityBasis))) {
        const last = row.spans[row.spans.length - 1];
        if (last !== undefined) last.end = { ...at, by: 'history' };
        row.pendingZero = null;
      } else {
        row.pendingZero = record.floorHash;
      }
      return;
    }
    if (end?.by === 'history' && count > 0) {
      row.spans.push({ start: at, end: null, seen: true });
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
              { less: 'no-usable-history' },
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
  const inOrder: Array<{ record: HistoryRecord; at: Placed }> = [];
  if (input.history.kind === 'on') {
    for (const placed of input.history.records) {
      if (placed.at === null) unplaced.push(placed.record);
      else inOrder.push({ record: placed.record, at: placed.at });
    }
  }
  // A record that cannot be placed in time may sit between any two scans, so no pair of scans
  // confirms a fix for an identity it observes. Collected first, so append order decides nothing.
  for (const record of unplaced) {
    for (const screen of record.screens) {
      if (screen.coverage !== 'full') continue;
      for (const identity of screen.identities) unplacedSlots.add(slotOf(screen.screenId, identity.id, identity.rule, identity.basis));
    }
  }
  // Replayed in the order of the commits they scanned on the first-parent line, never in the order
  // they were appended. The sort is stable, so two records of one commit keep their append order.
  inOrder.sort((a, b) => a.at.position - b.at.position);
  for (const placed of inOrder) {
    applyUpTo(placed.at.position);
    const at: Placed = placed.at;
    observedRows(placed.record, (row, count) => observe(row, placed.record, count, at));
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
    addGap(row, { cause: 'record-off-line', detail }, { less: 'history-unplaced' });
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
    for (const row of rows.values()) addGap(row, gap, { less: 'no-usable-history' });
  } else {
    // The history is on, but a span no full scan saw has no evidence that it stayed open: the
    // floor is accepted debt, not proof that the accessibility barrier is still on the page.
    for (const row of rows.values()) {
      if (row.less.has('no-usable-history')) continue;
      if (row.spans.some((span) => span.seen !== true)) {
        addGap(
          row,
          {
            cause: 'not-seen',
            detail:
              'No full scan of main saw this accessibility barrier during a span the floor holds it open, ' +
              'so it may have been fixed sooner than the floor shows.',
          },
          { less: 'not-seen' },
        );
      }
    }
  }

  const built = [...rows.values()]
    .filter((row) => row.spans.length > 0)
    .map((row): LedgerRow => {
      checkSpans(row.spans, input.now);
      const spans: LedgerSpan[] = row.spans.map((span) => ({
        start: point(span.start),
        end: span.end === null ? null : { commit: span.end.commit, date: span.end.date, by: span.end.by },
        days: daysBetween(span.start.date, span.end?.date ?? input.now),
      }));
      const first = spans[0] as LedgerSpan;
      const last = spans[spans.length - 1] as LedgerSpan;
      // Reopened: it closed, by a fix or by leaving the floor, and came back. Only a fix the history
      // showed is called fixed.
      const closedOnce = spans.slice(0, -1).some((span) => span.end?.by === 'floor' || span.end?.by === 'history');
      const state: LedgerState = closedOnce
        ? 'reopened'
        : last.end?.by === 'history'
          ? 'fixed'
          : last.end?.by === 'floor'
            ? 'left-the-floor'
            : 'open';
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
        mayBeMore: row.more.size > 0,
        mayBeMoreReasons: [...row.more].sort(compareText),
        mayBeLess: row.less.size > 0,
        mayBeLessReasons: [...row.less].sort(compareText),
        lastSeen: row.lastSeen,
        intermittent: row.intermittent,
        incomplete: [...row.gaps].sort((a, b) => (a.cause === b.cause ? compareText(a.detail, b.detail) : compareText(a.cause, b.cause))),
      };
    });
  const keyOf = (row: LedgerRow) => identityKey(row);
  built.sort((a, b) => (a.daysOpen === b.daysOpen ? compareText(keyOf(a), keyOf(b)) : b.daysOpen - a.daysOpen));

  const totalsFor = (state: LedgerState): LedgerStateTotals => {
    const inState = built.filter((row) => row.state === state);
    // Only a number that cannot be wrong either way goes into the median or the longest.
    const exact = inState.filter((row) => !row.mayBeMore && !row.mayBeLess).map((row) => row.daysOpen);
    return {
      rows: inState.length,
      exactRows: exact.length,
      medianDays: median(exact),
      longestDays: exact.length === 0 ? null : Math.max(...exact),
    };
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
    totals: {
      open: totalsFor('open'),
      fixed: totalsFor('fixed'),
      'left-the-floor': totalsFor('left-the-floor'),
      reopened: totalsFor('reopened'),
    },
  };
}

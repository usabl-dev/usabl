/**
 * `usabl debt ledger`: how long accessibility barriers stay open, as the floor history of the
 * trusted branch and the debt history show it.
 *
 * It scans nothing, decides nothing, and mints no receipt. It reads committed objects only. Every
 * string it prints, in the table and in the JSON, goes through the published scrub first, because
 * element keys, screen ids, and rules can carry page-derived text.
 *
 * Its words report what was observed: "open for at least N days", "fixed after N days". It makes
 * no claim about how fast a team fixes things and no claim about compliance.
 */
import type { HistoryReader } from '../contracts/index.js';
import { scrubOutboundData, scrubString } from '../surfaces/scrub.js';
import { buildLedger, LedgerInvariantError, type Ledger, type LedgerRow, type LedgerState, type LedgerStateTotals } from './ledger.js';
import { readLedgerSources, type LedgerGit } from './ledger-git.js';

export interface LedgerCommandOutcome {
  exitCode: 0 | 2 | 4;
  text: string;
  json: string;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function openNow(row: LedgerRow): boolean {
  return row.spans[row.spans.length - 1]?.end === null;
}

/** The days, said with the way they can be wrong. */
export function daysCell(row: Pick<LedgerRow, 'daysOpen' | 'mayBeMore' | 'mayBeLess'>): string {
  if (row.mayBeMore && row.mayBeLess) return `not known (${row.daysOpen} by the floor)`;
  if (row.mayBeMore) return `at least ${row.daysOpen}`;
  if (row.mayBeLess) return `at most ${row.daysOpen}`;
  return plural(row.daysOpen, 'day', 'days');
}

function stateCell(row: LedgerRow): string {
  if (row.state === 'reopened') {
    // The words follow how the last span ended. Only a fix the history showed is "fixed again".
    const by = row.spans[row.spans.length - 1]?.end?.by ?? null;
    if (by === null) return 'reopened, open now';
    if (by === 'history') return 'reopened, fixed again';
    if (by === 'floor') return 'reopened, left the floor again';
    return 'reopened, open until a gap';
  }
  if (row.state === 'open' && !openNow(row)) return 'open until a gap';
  if (row.state === 'left-the-floor') return 'left the floor';
  return row.state;
}

const STATE_WORDS: Record<LedgerState, string> = {
  open: 'open',
  fixed: 'fixed',
  'left-the-floor': 'left the floor',
  reopened: 'reopened',
};

function notesCell(row: LedgerRow): string {
  const notes: string[] = [];
  if (row.firstSeenAtFirstBaseline) notes.push('first baseline');
  if (row.intermittent) notes.push('intermittent');
  if (row.incomplete.length > 0) notes.push('incomplete');
  if (openNow(row) && row.lastSeen !== null) notes.push(`last seen ${row.lastSeen.date.slice(0, 10)}`);
  return notes.join(', ');
}

function totalsPart(key: LedgerState, totals: LedgerStateTotals): string {
  const state = STATE_WORDS[key];
  if (totals.rows === 0) return `0 ${state}.`;
  if (totals.exactRows === 0 || totals.medianDays === null || totals.longestDays === null) {
    return `${totals.rows} ${state}, none exact, so no median.`;
  }
  return (
    `${totals.rows} ${state}, ${totals.exactRows} exact, median ${plural(totals.medianDays, 'day', 'days')}, ` +
    `longest ${plural(totals.longestDays, 'day', 'days')}.`
  );
}

function table(rows: readonly string[][]): string[] {
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? '').length))) ?? [];
  return rows.map((row) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd((widths[column] ?? 0) + 2)))
      .join('')
      .trimEnd(),
  );
}

/** The terminal view of a ledger whose strings were already scrubbed. */
export function formatLedger(ledger: Ledger): string {
  const lines: string[] = [];
  const historyRef = ledger.history.ref;
  lines.push(
    `usabl debt ledger: how long accessibility barriers stay open, as the floor history of ${ledger.trustedRef} ` +
      `(${ledger.head.slice(0, 12)}) and the debt history at ${historyRef} show it.`,
    'It reports what was observed. It decides no verdict and makes no claim about compliance.',
    `Rows still open are counted to ${ledger.head.slice(0, 12)}, dated ${ledger.headDate.slice(0, 10)}, the commit ` +
      `${ledger.trustedRef} names. The ledger reads no clock.`,
  );
  if (ledger.history.kind === 'on' && ledger.history.skipped > 0) {
    lines.push(
      `${plural(ledger.history.skipped, 'history record names a commit', 'history records name commits')} that ` +
        `${ledger.trustedRef} does not contain. They do not apply to this branch and are not used.`,
    );
  }
  lines.push('');
  if (ledger.rows.length === 0) {
    lines.push(`No accessibility barrier has ever been in the floor on ${ledger.trustedRef}.`);
  } else {
    const header = ['Days open', 'State', 'First seen', 'Last change', 'Screen', 'Rule', 'Notes', 'Element'];
    const body = ledger.rows.map((row) => [
      daysCell(row),
      stateCell(row),
      row.firstSeen.date.slice(0, 10),
      row.lastChange.date.slice(0, 10),
      row.screenId,
      row.rule,
      notesCell(row),
      row.elementKey ?? '(counted, no element)',
    ]);
    lines.push(...table([header, ...body]));
  }
  lines.push(
    '',
    `Totals: ${totalsPart('open', ledger.totals.open)} ${totalsPart('fixed', ledger.totals.fixed)} ` +
      `${totalsPart('left-the-floor', ledger.totals['left-the-floor'])} ${totalsPart('reopened', ledger.totals.reopened)}`,
    'The median and the longest are over exact rows only: rows whose days cannot be wrong either way.',
    '',
    '"N days": what the floor and the history show, to the day.',
    '"at least N": the true number may be larger. "at most N": it may be smaller.',
    '"not known (N by the floor)": it may be larger or smaller. N is what the floor alone shows.',
    '"first baseline": seen at the first baseline; may be older.',
    'Days are whole days between committer dates, in UTC. A row still open counts to the commit named above.',
  );

  // Each reason once, with the rows it touches.
  const reasons = new Map<string, LedgerRow[]>();
  for (const row of ledger.rows) {
    for (const gap of row.incomplete) {
      const list = reasons.get(gap.detail) ?? [];
      list.push(row);
      reasons.set(gap.detail, list);
    }
  }
  if (reasons.size > 0) {
    lines.push('', 'Incomplete history:');
    for (const detail of [...reasons.keys()].sort()) {
      const rows = reasons.get(detail) ?? [];
      const touched =
        rows.length === ledger.rows.length
          ? 'This touches every row.'
          : `Rows: ${rows.map((row) => `${row.screenId}, ${row.rule}`).join('; ')}.`;
      lines.push(`- ${detail} ${touched}`);
    }
  }
  return lines.join('\n');
}

function refusal(exitCode: 2 | 4, message: string): LedgerCommandOutcome {
  const text = scrubString(`usabl debt ledger: ${message}`);
  return { exitCode, text, json: JSON.stringify({ error: text }, null, 2) };
}

/**
 * Reads the floor history of `trustedRef` and the history at the reader's ref, builds the ledger
 * counted to the commit the ref names, and projects it. It reads no clock. Exit 0 when it ran. Exit 2 when no floor was ever
 * committed, and 4 when git could not run there or could not read the history.
 */
export async function runLedger(git: LedgerGit, history: HistoryReader, trustedRef: string): Promise<LedgerCommandOutcome> {
  let ledger: Ledger;
  try {
    const read = await readLedgerSources(git, history, trustedRef);
    if (read.kind === 'refused') {
      return refusal(read.reason === 'no-floor' ? 2 : 4, read.message);
    }
    ledger = buildLedger(read.input);
  } catch (err) {
    if (err instanceof LedgerInvariantError) {
      return refusal(
        4,
        `the ledger stopped because its own count broke a rule (${err.message}). It printed no numbers, because they would be wrong. This is a bug in usabl.`,
      );
    }
    return refusal(4, `git could not read the history of ${trustedRef}, so the ledger could not run.`);
  }
  const safe = scrubOutboundData(ledger);
  return { exitCode: 0, text: formatLedger(safe), json: JSON.stringify(safe, null, 2) };
}

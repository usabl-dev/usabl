/**
 * `usabl debt`: the accessibility debt that remains, by screen and rule, with when each was first
 * seen on main, how old it is, which way it is going, and which barriers are intermittent.
 *
 * It scans nothing and decides nothing. It reads the committed floor and the history branch, folds
 * them the way a run does, and prints what is left. With tracking off it still lists the floor, and
 * says why the dates are missing and how to turn tracking on.
 *
 * Screen ids and rules come from the floor, which the operator committed, and still go through the
 * scrubber before they are printed. No element key is ever printed, because a key carries page
 * text.
 */
import type { DebtStatus, EvidenceFloor, HistoryReader } from '../contracts/index.js';
import { parseEvidenceFloor } from '../evidence/floor.js';
import { identityKey } from '../primitives/identity.js';
import { trackingOffSentence } from '../output/debt.js';
import { scrubString } from '../surfaces/scrub.js';
import { debtStatusOf, loadDebtTracking, type DebtTracking } from './tracking.js';

export type DebtTrend = 'falling' | 'rising' | 'steady' | 'no data';

export interface DebtRow {
  screenId: string;
  rule: string;
  barriers: number;
  firstSeen: string | null; // YYYY-MM-DD
  ageDays: number | null;
  trend: DebtTrend;
  intermittent: number; // barriers in this group whose fix came back on an unchanged tree
}

export interface DebtReport {
  status: DebtStatus;
  rows: DebtRow[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function debtReport(tracking: DebtTracking, now: string): DebtReport {
  const status = debtStatusOf(tracking, [], now);
  const tracked = new Map(tracking.identities.map((identity) => [identityKey(identity.entry), identity]));
  const groups = new Map<string, { row: DebtRow; first: number; last: number; observed: boolean }>();
  for (const entry of tracking.effectiveFloor.entries) {
    const key = JSON.stringify([entry.screenId, entry.rule]);
    const group = groups.get(key) ?? {
      row: { screenId: entry.screenId, rule: entry.rule, barriers: 0, firstSeen: null, ageDays: null, trend: 'no data', intermittent: 0 },
      first: 0,
      last: 0,
      observed: false,
    };
    group.row.barriers += entry.count;
    const identity = tracked.get(identityKey(entry));
    if (identity !== undefined) {
      if (identity.state === 'intermittent') group.row.intermittent += identity.accepted;
      if (identity.firstSeen !== null && (group.row.firstSeen === null || identity.firstSeen.slice(0, 10) < group.row.firstSeen)) {
        group.row.firstSeen = identity.firstSeen.slice(0, 10);
      }
      if (identity.firstCount !== null && identity.lastCount !== null) {
        group.first += identity.firstCount;
        group.last += identity.lastCount;
        group.observed = true;
      }
    }
    groups.set(key, group);
  }
  const nowMs = Date.parse(now);
  const rows = [...groups.values()].map(({ row, first, last, observed }) => {
    const ageDays =
      row.firstSeen === null || !Number.isFinite(nowMs)
        ? null
        : Math.max(0, Math.floor((nowMs - Date.parse(`${row.firstSeen}T00:00:00.000Z`)) / DAY_MS));
    const trend: DebtTrend = !observed ? 'no data' : last < first ? 'falling' : last > first ? 'rising' : 'steady';
    return { ...row, ageDays, trend };
  });
  rows.sort((a, b) => (a.screenId === b.screenId ? a.rule.localeCompare(b.rule) : a.screenId.localeCompare(b.screenId)));
  return { status, rows };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function formatDebtReport(report: DebtReport): string {
  const { status, rows } = report;
  const lines: string[] = [];
  if (rows.length === 0) {
    lines.push('usabl debt: no accessibility debt is accepted. The evidence floor holds no barriers.');
  } else {
    const screens = new Set(rows.map((row) => row.screenId)).size;
    let head = `usabl debt: ${plural(status.remaining, 'accessibility barrier remains', 'accessibility barriers remain')} on ${plural(screens, 'screen', 'screens')}.`;
    if (status.oldestOpenDays !== null) head += ` The oldest has been open ${plural(status.oldestOpenDays, 'day', 'days')}.`;
    if (status.intermittent > 0) head += ` ${status.intermittent} ${status.intermittent === 1 ? 'is' : 'are'} intermittent.`;
    if (status.confirmedFixed > 0) {
      head += ` Main confirmed ${plural(status.confirmedFixed, 'fix', 'fixes')}, so ${status.confirmedFixed === 1 ? 'its slot is' : 'their slots are'} closed.`;
    }
    lines.push(head, '');
    for (const row of rows) {
      const seen = row.firstSeen === null ? 'first seen unknown' : `first seen ${row.firstSeen} (${plural(row.ageDays ?? 0, 'day', 'days')} ago)`;
      const note = row.intermittent > 0 ? `, ${row.intermittent} intermittent` : '';
      lines.push(`- ${scrubString(row.screenId)}, ${scrubString(row.rule)}: ${plural(row.barriers, 'barrier', 'barriers')}, ${seen}, trend ${row.trend}${note}`);
    }
  }
  const off = trackingOffSentence(status);
  if (off !== null) {
    lines.push('', off);
    if (status.off?.detail) lines.push(`Detail: ${scrubString(status.off.detail)}`);
  }
  if (rows.length > 0) {
    lines.push(
      '',
      'Next: fix the oldest barriers first. A fix closes its slot on its own after two scans of main no longer see it. ' +
        'An intermittent barrier comes and goes with the page content and is not released on its own: fix it, or check ' +
        'the screen against fixed data.',
    );
  }
  return lines.join('\n');
}

export interface DebtCommandOutcome {
  exitCode: 0 | 4;
  text: string;
  json: string;
}

/**
 * Reads the floor through `readFloor` (the trusted ref in CI, the working tree locally) and the
 * history through `reader`, judged as of `baseRef`, and reports.
 */
export async function runDebt(
  reader: HistoryReader | undefined,
  readFloor: () => Promise<string | null>,
  baseRef: string,
  now: string,
): Promise<DebtCommandOutcome> {
  let floor: EvidenceFloor;
  try {
    const text = await readFloor();
    floor = text === null ? { version: 3, entries: [] } : parseEvidenceFloor(JSON.parse(text));
  } catch {
    const message = 'usabl debt: .usabl-evidence.json could not be read, so there is no accepted debt to report. Fix the file, or run usabl baseline to write it again.';
    return { exitCode: 4, text: message, json: JSON.stringify({ error: message }, null, 2) };
  }
  const report = debtReport(await loadDebtTracking(reader, floor, baseRef), now);
  const safe: DebtReport = {
    status: {
      ...report.status,
      off: report.status.off === null ? null : { cause: report.status.off.cause, detail: report.status.off.detail === null ? null : scrubString(report.status.off.detail) },
    },
    rows: report.rows.map((row) => ({ ...row, screenId: scrubString(row.screenId), rule: scrubString(row.rule) })),
  };
  return { exitCode: 0, text: formatDebtReport(report), json: JSON.stringify(safe, null, 2) };
}

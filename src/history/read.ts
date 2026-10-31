/**
 * Reads the debt history for a run.
 *
 * The history is read through an injected HistoryReader, as git objects at the fetched history
 * branch, never from a working tree, so a pull request cannot write its own history. Only records
 * written at the base commit or one of its ancestors apply: a pull request is judged against the
 * base commit's floor, minus the fixes confirmed on main up to the base commit.
 *
 * A missing history, one usabl cannot read, or any failure while reading is an `off` result with
 * its cause, never a throw. The caller then judges against the floor as committed, which is the
 * behavior of a run without history, and says automatic tracking is off and why.
 *
 * This unit reads. It must never decide a verdict.
 */
import type { DebtTrackingOff, HistoryReader } from '../contracts/index.js';
import { HistoryRefusedError, isHistoryFile, parseHistoryFile, type HistoryRecord } from './record.js';

export type HistoryRead =
  | { kind: 'off'; cause: DebtTrackingOff; detail: string | null; head: string | null }
  | { kind: 'on'; head: string; base: string; records: HistoryRecord[] };

export function off(cause: DebtTrackingOff, head: string | null, detail: string | null = null): HistoryRead {
  return { kind: 'off', cause, detail, head };
}

/**
 * The records that apply to a run whose base is `baseRef`, oldest first. Never throws: every
 * failure is an `off` result with its cause.
 */
export async function readHistory(reader: HistoryReader | undefined, baseRef: string): Promise<HistoryRead> {
  if (reader === undefined) return off('no-reader', null);
  let head: string | null;
  try {
    head = await reader.resolveCommit(reader.ref);
  } catch {
    return off('unreadable', null, `git could not resolve ${reader.ref}`);
  }
  if (head === null) return off('no-history', null);

  let base: string | null;
  try {
    base = await reader.resolveCommit(baseRef);
  } catch {
    base = null;
  }
  if (base === null) return off('no-base', head);

  const records: HistoryRecord[] = [];
  try {
    const files = (await reader.listFiles(head)).filter(isHistoryFile).sort();
    for (const file of files) {
      const text = await reader.readFile(head, file);
      if (text === null) return off('unreadable', head, `${file} is listed but could not be read`);
      records.push(...parseHistoryFile(text, file));
    }
    const applies = new Map<string, boolean>();
    const applicable: HistoryRecord[] = [];
    for (const record of records) {
      let ok = applies.get(record.commit);
      if (ok === undefined) {
        ok = await reader.isAncestor(record.commit, base);
        applies.set(record.commit, ok);
      }
      if (ok) applicable.push(record);
    }
    return { kind: 'on', head, base, records: applicable };
  } catch (err) {
    if (err instanceof HistoryRefusedError) return off('unreadable', head, err.message);
    return off('unreadable', head, `git could not read ${reader.ref}`);
  }
}

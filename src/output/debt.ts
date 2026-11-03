/**
 * The words for accessibility debt, written once and printed by the pull request comment and by
 * `usabl debt`.
 *
 * The debt line tells a developer what this change did to the accepted debt and what is left: how
 * many barriers it fixes, how many remain, how long the oldest has been open, and how many come
 * and go on their own. A barrier this run did not see counts as fixed in this change until main
 * confirms it.
 *
 * The tracking line says when automatic tracking is off, why, and how to turn it on. The cause is a
 * closed word set and the sentence is written here; the only carried text is the detail, which the
 * caller prints as a value.
 *
 * Every count is carried by a Result, so it prints only as a whole number (../output/carried).
 *
 * This unit formats text only. It must never decide a verdict.
 */
import type { DebtStatus, DebtTrackingOff } from '../contracts/index.js';
import { ownEntry, wholeNumberText } from './carried.js';

function barriers(count: number): string {
  return `${wholeNumberText(count)} accessibility barrier${count === 1 ? '' : 's'}`;
}

function days(count: number): string {
  return `${wholeNumberText(count)} day${count === 1 ? '' : 's'}`;
}

/**
 * The debt line, or null when the floor holds no debt and the change fixed none, which is the case
 * on most repositories and needs no line. `subject` names the change, for example "This PR".
 */
export function debtSentence(debt: DebtStatus, subject: string): string | null {
  if (debt.floorBarriers === 0 && debt.fixedThisRun === 0) return null;
  const fixed = debt.fixedThisRun === 0 ? `${subject} fixes no accessibility barriers.` : `${subject} fixes ${barriers(debt.fixedThisRun)}.`;
  let remain =
    debt.remaining === 0 ? ' None remain.' : ` ${wholeNumberText(debt.remaining)} remain${debt.remaining === 1 ? 's' : ''}`;
  if (debt.remaining > 0) {
    remain += debt.oldestOpenDays === null ? '.' : `; the oldest has been open ${days(debt.oldestOpenDays)}.`;
  }
  const intermittent =
    debt.intermittent === 0 ? '' : ` ${wholeNumberText(debt.intermittent)} ${debt.intermittent === 1 ? 'is' : 'are'} intermittent.`;
  return `${fixed}${remain}${intermittent}`;
}

const HOW_TO_TURN_ON =
  'To turn it on, run usabl install --ci and merge the usabl-history workflow it writes. That workflow scans main ' +
  'and records what it saw on the usabl/history branch.';

const OFF_SENTENCES: Record<DebtTrackingOff, string> = {
  'no-reader': `Automatic debt tracking is off: this run was not given a history reader, so fixed barriers keep their slot in the accepted debt until someone runs usabl floor prune.`,
  'no-history': `Automatic debt tracking is off: there is no usabl/history branch, so fixed barriers keep their slot in the accepted debt until someone runs usabl floor prune. ${HOW_TO_TURN_ON}`,
  unreadable:
    'Automatic debt tracking is off: the usabl/history branch could not be read, so this run used the evidence floor as ' +
    'committed. Fix or remove the record named in the detail, or delete the branch so the next scan of main starts a new history.',
  'old-floor':
    'Automatic debt tracking is off: the evidence floor predates row keys (version 1 or 2), so the history cannot be ' +
    'matched to it. Run usabl baseline to write a version 3 floor, then review and merge it.',
  'no-base':
    'Automatic debt tracking is off: usabl could not resolve the base commit, so it cannot tell which history records ' +
    'apply. Fetch the base branch with its history (fetch-depth: 0) before the check.',
};

/**
 * The tracking line, or null when tracking is on. Also null when the floor holds no debt, because
 * then there is nothing for tracking to do and the line would only be noise.
 */
export function trackingOffSentence(debt: DebtStatus): string | null {
  if (debt.tracking === 'on' || debt.floorBarriers === 0) return null;
  return ownEntry(OFF_SENTENCES, debt.off?.cause) ?? 'Automatic debt tracking is off.';
}

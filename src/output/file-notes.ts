/**
 * The file lists a Result carries in its coverage: the changed files the planner left out on
 * purpose, and what screen discovery had to assume. Each is disclosure only and never moves a
 * verdict. Every surface that prints one lists it the same way: files that share a reason are
 * grouped, the reason is printed once per group, groups are sorted by reason and files within a
 * group by name, and at most MAX_LISTED_FILES files are named, with a count of the rest.
 *
 * This unit returns the raw strings. Each surface neutralizes, scrubs, bounds, or frames them for
 * its own medium.
 */

// A pull request can change thousands of files. A file list names this many, then counts the rest.
export const MAX_LISTED_FILES = 20;
export const FULL_LIST_NOTE = 'Run usabl check --json to see the full list in coverage.';

export interface FileNoteGroup {
  reason: string;
  refs: string[];
}

export interface ListedFileNotes {
  // Every entry with a string ref and reason.
  count: number;
  // The groups shown, with at most MAX_LISTED_FILES refs among them.
  groups: FileNoteGroup[];
  // How many entries are counted but not named.
  hidden: number;
}

/**
 * A file list grouped for printing. A Result built outside the engine may carry anything here, so
 * a value that is not a list gives no entries, and an entry whose fields are not strings is
 * skipped.
 */
export function listFileNotes(listed: unknown): ListedFileNotes {
  if (!Array.isArray(listed)) {
    return { count: 0, groups: [], hidden: 0 };
  }
  const byReason = new Map<string, string[]>();
  for (const entry of listed as Array<{ ref?: unknown; reason?: unknown }>) {
    if (typeof entry?.ref !== 'string' || typeof entry.reason !== 'string') {
      continue;
    }
    byReason.set(entry.reason, [...(byReason.get(entry.reason) ?? []), entry.ref]);
  }
  const count = [...byReason.values()].reduce((sum, refs) => sum + refs.length, 0);
  const groups: FileNoteGroup[] = [];
  let shown = 0;
  for (const reason of [...byReason.keys()].sort()) {
    const refs = [...(byReason.get(reason) ?? [])].sort().slice(0, Math.max(0, MAX_LISTED_FILES - shown));
    if (refs.length === 0) {
      break;
    }
    groups.push({ reason, refs });
    shown += refs.length;
  }
  return { count, groups, hidden: count - shown };
}

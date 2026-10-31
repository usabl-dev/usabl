/**
 * Appends one record to the debt history branch, as a new commit on top of the fetched branch.
 *
 * Only the default-branch CI job runs this, after a scan of main. It writes the local branch and
 * never pushes; the workflow pushes, without force, so two jobs that race cannot overwrite each
 * other's records. Append-only: the files at the parent commit are kept as they are and the record
 * is added as the last line of its month file.
 *
 * It refuses a record it cannot read and a history it cannot read, and writes nothing then. The
 * git work goes through an injected HistoryWriter so the logic is tested without a repository.
 */
import type { HistoryReader } from '../contracts/index.js';
import { HISTORY_BRANCH, HistoryRefusedError, historyFileFor, parseRecord, serializeRecord } from './record.js';
import { readHistory } from './read.js';

export interface HistoryWriter extends HistoryReader {
  // A new commit whose tree is the parent's tree with one file set to these contents.
  commitFile(parent: string | null, path: string, contents: string, message: string): Promise<string>;
  // Points the local history branch at a commit.
  setBranch(branch: string, commit: string): Promise<void>;
}

export interface AppendOutcome {
  exitCode: 0 | 2 | 4;
  message: string;
  commit: string | null;
}

export async function appendRecord(writer: HistoryWriter, recordText: string): Promise<AppendOutcome> {
  let record;
  try {
    record = parseRecord(JSON.parse(recordText), 'record');
  } catch (err) {
    const why = err instanceof HistoryRefusedError ? err.message : 'record is not JSON';
    return { exitCode: 2, commit: null, message: `refused: the history record could not be read (${why}). Nothing was appended.` };
  }

  const read = await readHistory(writer, record.commit);
  if (read.kind === 'off' && read.cause === 'unreadable') {
    return {
      exitCode: 4,
      commit: null,
      message:
        `refused: the history at ${writer.ref} could not be read (${read.detail ?? 'no reason given'}), so a record ` +
        'appended to it could not be read either. Nothing was appended. Fix or remove the bad record, or delete the ' +
        `${HISTORY_BRANCH} branch to start a new history.`,
    };
  }
  const parent = read.head;
  const file = historyFileFor(record.time);
  const existing = parent === null ? null : await writer.readFile(parent, file);
  const before = existing === null || existing.length === 0 ? '' : existing.endsWith('\n') ? existing : `${existing}\n`;
  const contents = `${before}${serializeRecord(record)}\n`;
  const commit = await writer.commitFile(parent, file, contents, `usabl history: scan of ${record.commit.slice(0, 12)}`);
  await writer.setBranch(HISTORY_BRANCH, commit);
  return {
    exitCode: 0,
    commit,
    message:
      `Appended the scan of main at ${record.commit.slice(0, 12)} to ${file} on the local ${HISTORY_BRANCH} branch. ` +
      `Push it with: git push origin ${HISTORY_BRANCH}`,
  };
}

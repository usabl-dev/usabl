/**
 * Reads the two sources of the ledger from git: the evidence floor file's history on the trusted
 * branch, and the debt history branch.
 *
 * Every read is of committed objects at the trusted ref and the history ref, never of the working
 * tree, so uncommitted changes to the floor never reach the ledger. The floor's history is the
 * first-parent line of the trusted ref: the commits the branch itself moved through, with a merged
 * branch counted at its merge commit.
 *
 * This unit reports repository facts only. It must never decide a verdict.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EvidenceFloor, HistoryReader } from '../contracts/index.js';
import { parseEvidenceFloor } from '../evidence/floor.js';
import { InputRefusedError } from '../intake/input-refusal.js';
import type { FloorSnapshot, LedgerHistory, LedgerInput, LedgerRecord } from './ledger.js';
import { HistoryRefusedError, isHistoryFile, parseHistoryFile, type HistoryRecord } from './record.js';

const execFileAsync = promisify(execFile);
// The first-parent line of a long-lived branch is large, and so is a floor file.
const MAX_BUFFER = 256 * 1024 * 1024;

export const LEDGER_FLOOR_PATH = '.usabl-evidence.json';

/** The git facts the ledger reads. */
export interface LedgerGit {
  isRepository(): Promise<boolean>;
  isShallow(): Promise<boolean>;
  resolveCommit(ref: string): Promise<string | null>;
  // Every commit on the first-parent line of `head`, oldest first, with its committer date in UTC.
  firstParentLine(head: string): Promise<Array<{ commit: string; date: string }>>;
  // The commits on that line that changed `path`, oldest first.
  commitsChanging(head: string, path: string): Promise<string[]>;
  // The file at a commit, or null when the commit does not hold it.
  readFile(commit: string, path: string): Promise<string | null>;
}

function exitCodeOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const code = Reflect.get(err, 'code');
  return typeof code === 'number' ? code : null;
}

// NUL-separated fields, as git prints them with -z. Empty pieces, such as the last one, are dropped.
function splitZ(output: string): string[] {
  return output.split('\u0000').filter((piece) => piece.length > 0);
}

export function makeLedgerGit(options: { cwd?: string } = {}): LedgerGit {
  const cwd = options.cwd ?? process.cwd();

  async function git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER });
    return stdout;
  }

  return {
    async isRepository() {
      try {
        await git(['rev-parse', '--git-dir']);
        return true;
      } catch {
        return false;
      }
    },
    async isShallow() {
      return (await git(['rev-parse', '--is-shallow-repository'])).trim() === 'true';
    },
    async resolveCommit(ref) {
      try {
        const sha = (await git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])).trim();
        return sha.length === 0 ? null : sha;
      } catch (err) {
        if (exitCodeOf(err) === 1) return null;
        throw err;
      }
    },
    async firstParentLine(head) {
      // One commit per NUL-terminated entry: the commit id and its committer time in seconds.
      const out = await git(['log', '-z', '--first-parent', '--reverse', '--format=%H %ct', head]);
      return splitZ(out).map((entry) => {
        const [commit = '', seconds = ''] = entry.split(' ');
        return { commit, date: new Date(Number(seconds) * 1000).toISOString() };
      });
    },
    async commitsChanging(head, path) {
      const out = await git(['log', '-z', '--first-parent', '--reverse', '--format=%H', head, '--', path]);
      return splitZ(out);
    },
    async readFile(commit, path) {
      // Listed first, NUL-terminated, so a file that is not there reads as absent and nothing else does.
      const listed = splitZ(await git(['ls-tree', '-z', '--full-tree', commit, '--', path]));
      if (listed.length === 0) return null;
      return git(['cat-file', 'blob', `${commit}:${path}`]);
    },
  };
}

export type LedgerSourcesRead =
  | { kind: 'read'; input: LedgerInput }
  | { kind: 'refused'; reason: 'not-a-repository' | 'no-ref' | 'no-floor'; message: string };

function parseFloorText(text: string): { floor: EvidenceFloor; unreadable: null } | { floor: null; unreadable: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // The parser's own message can quote the file, and the file holds page-derived keys.
    return { floor: null, unreadable: 'the file is not JSON' };
  }
  try {
    return { floor: parseEvidenceFloor(value), unreadable: null };
  } catch (err) {
    // An InputRefusedError names the field and its position, never the value.
    return { floor: null, unreadable: err instanceof InputRefusedError ? err.message : 'the floor did not parse' };
  }
}

async function readHistoryRecords(reader: HistoryReader): Promise<
  { kind: 'on'; head: string; records: HistoryRecord[] } | { kind: 'off'; cause: 'no-history' | 'unreadable'; detail: string | null }
> {
  let head: string | null;
  try {
    head = await reader.resolveCommit(reader.ref);
  } catch {
    return { kind: 'off', cause: 'unreadable', detail: `git could not resolve ${reader.ref}` };
  }
  if (head === null) return { kind: 'off', cause: 'no-history', detail: null };
  try {
    const records: HistoryRecord[] = [];
    for (const file of (await reader.listFiles(head)).filter(isHistoryFile).sort()) {
      const text = await reader.readFile(head, file);
      if (text === null) return { kind: 'off', cause: 'unreadable', detail: `${file} is listed but could not be read` };
      records.push(...parseHistoryFile(text, file));
    }
    return { kind: 'on', head, records };
  } catch (err) {
    if (err instanceof HistoryRefusedError) return { kind: 'off', cause: 'unreadable', detail: err.message };
    return { kind: 'off', cause: 'unreadable', detail: `git could not read ${reader.ref}` };
  }
}

/**
 * Reads both sources at `trustedRef` and the history reader's ref. Refuses only when the ledger
 * cannot run at all: not a git repository, a ref that does not resolve, or a branch that never
 * committed a floor. Every other problem is carried into the input so the ledger can name it.
 */
export async function readLedgerSources(git: LedgerGit, history: HistoryReader, trustedRef: string): Promise<LedgerSourcesRead> {
  if (!(await git.isRepository())) {
    return {
      kind: 'refused',
      reason: 'not-a-repository',
      message: 'This folder is not in a git repository. The ledger reads the floor history from git. Run it inside the repository.',
    };
  }
  const head = await git.resolveCommit(trustedRef);
  if (head === null) {
    return {
      kind: 'refused',
      reason: 'no-ref',
      message: `git cannot find ${trustedRef}. Check the name, or fetch it first (for example git fetch origin main).`,
    };
  }
  const changing = await git.commitsChanging(head, LEDGER_FLOOR_PATH);
  if (changing.length === 0) {
    return {
      kind: 'refused',
      reason: 'no-floor',
      message:
        `No commit on ${trustedRef} has ever held ${LEDGER_FLOOR_PATH}, so there are no accessibility barriers to follow. ` +
        'Run usabl baseline and commit the floor it writes.',
    };
  }
  const shallow = await git.isShallow();
  const line = await git.firstParentLine(head);
  const placed = new Map(line.map((entry, position) => [entry.commit, { ...entry, position }]));

  const snapshots: FloorSnapshot[] = [];
  for (const commit of changing) {
    const at = placed.get(commit);
    if (at === undefined) continue;
    const text = await git.readFile(commit, LEDGER_FLOOR_PATH);
    const parsed = text === null ? { floor: null, unreadable: null } : parseFloorText(text);
    snapshots.push({ commit, date: at.date, position: at.position, floor: parsed.floor, unreadable: parsed.unreadable });
  }

  const read = await readHistoryRecords(history);
  let ledgerHistory: LedgerHistory;
  if (read.kind === 'off') {
    ledgerHistory = { kind: 'off', ref: history.ref, cause: read.cause, detail: read.detail };
  } else {
    const records: LedgerRecord[] = [];
    let skipped = 0;
    for (const record of read.records) {
      const at = placed.get(record.commit);
      if (at !== undefined) {
        records.push({ record, at });
      } else if (shallow || (await history.isAncestor(record.commit, head))) {
        // On the branch, or maybe on it but cut off by the shallow clone: it cannot be placed in time.
        records.push({ record, at: null });
      } else {
        skipped += 1;
      }
    }
    ledgerHistory = { kind: 'on', ref: history.ref, head: read.head, records, skipped };
  }

  // The first-parent line ends at the head, so its last entry dates the head. Open spans end there.
  const headDate = line[line.length - 1]?.date;
  if (headDate === undefined || line[line.length - 1]?.commit !== head) {
    throw new Error('the first-parent line does not end at the trusted ref');
  }
  return { kind: 'read', input: { trustedRef, head, headDate, shallow, snapshots, history: ledgerHistory } };
}

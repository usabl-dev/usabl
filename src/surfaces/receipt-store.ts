/**
 * Local receipt store for stop-hook fast-path re-checks.
 * This unit persists and loads local state only.
 * It must never mint a verdict, infer trust, or throw on corrupt local files.
 *
 * The receipt lives in the work tree, where a file can be a symbolic link that someone else
 * committed. A write that followed it would land on any file the user can write, and in the CI
 * judge the pull request head would pick the target. So the real store refuses a link at the
 * folder or the file, writes a temp file opened with no-follow and exclusive create, and renames
 * it into place, as the session pin store does.
 */
import { randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { Receipt, Result } from '../contracts/index.js';

export const RECEIPT_DIR = '.usabl';
export const RECEIPT_PATH = '.usabl/receipt.json';
export const BYPASS_ONCE_PATH = '.usabl/bypass-once';

export interface ReceiptFs {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, contents: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

// A count is a whole number, zero or more. JSON can hold a fraction, a negative number, and, from
// an exponent too large for a double, Infinity, and none of them is a count of anything.
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isApplicabilitySummary(value: unknown): value is Receipt['applicability'] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry['screenId'] === 'string' &&
        isCount(entry['applied']) &&
        isCount(entry['abstained']),
    )
  );
}

// Optional, so a receipt minted before engines existed still loads. When present it must be a map
// of engine id to version string, or the receipt is corrupt and is treated as absent.
function isEngineVersions(value: unknown): boolean {
  return value === undefined || (isRecord(value) && Object.values(value).every((version) => typeof version === 'string'));
}

function isReceipt(value: unknown): value is Receipt {
  if (!isRecord(value)) {
    return false;
  }
  const scannerVersions = value['scannerVersions'];
  const coverage = value['coverage'];
  const findingsSummary = value['findingsSummary'];

  return (
    // A version 1 receipt has no history binding. Reading it as not found triggers one full run.
    value['schemaVersion'] === 2 &&
    typeof value['sourceTree'] === 'string' &&
    (value['baseRevision'] === null || typeof value['baseRevision'] === 'string') &&
    (value['historyHead'] === null || typeof value['historyHead'] === 'string') &&
    typeof value['policyHash'] === 'string' &&
    typeof value['runnerVersion'] === 'string' &&
    isRecord(scannerVersions) &&
    typeof scannerVersions['axeCore'] === 'string' &&
    typeof scannerVersions['playwright'] === 'string' &&
    typeof scannerVersions['chromium'] === 'string' &&
    isEngineVersions(scannerVersions['engines']) &&
    isStringArray(value['surfaces']) &&
    isRecord(coverage) &&
    isStringArray(coverage['checked']) &&
    isStringArray(coverage['notCovered']) &&
    isApplicabilitySummary(value['applicability']) &&
    value['verdict'] === 'verified' &&
    isRecord(findingsSummary) &&
    isCount(findingsSummary['new']) &&
    isCount(findingsSummary['carried']) &&
    isCount(findingsSummary['fixed']) &&
    isCount(findingsSummary['unverified']) &&
    isCount(value['activeWaivers']) &&
    typeof value['mintedAt'] === 'string'
  );
}

/** What a save did. A refusal says what happened, what it means, and what to do, in fixed text. */
export type ReceiptSave = { status: 'saved' } | { status: 'refused'; message: string };

/**
 * Thrown by a receipt file system that will not write through a link or onto something that is
 * not a regular file. `path` is the repository path in the way, and the reason is fixed text that
 * names it. Neither ever names a link target.
 */
export class ReceiptWriteRefused extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`${path} ${reason}`);
  }
}

export async function saveReceipt(fs: ReceiptFs, receipt: Receipt): Promise<ReceiptSave> {
  // Receipt files stay local and gitignored so fast-path trust cannot become a committed self-accept.
  try {
    await fs.mkdir(RECEIPT_DIR);
    await fs.writeFile(RECEIPT_PATH, JSON.stringify(receipt, null, 2));
  } catch (err) {
    if (err instanceof ReceiptWriteRefused) {
      return {
        status: 'refused',
        message:
          `NOT saved - usabl did not save the receipt for this run because ${err.message}. ` +
          'The verdict of this run stands, but the next stop runs the full check again instead of using a stored receipt. ' +
          `To fix: remove ${err.path}, then run usabl check or stop again.`,
      };
    }
    throw err;
  }
  return { status: 'saved' };
}

/**
 * The receipt a run leaves on disk, or null. Only a verified run has one. A CI run saves none: the
 * work tree there belongs to the pull request, and a CI runner never takes the stop hook fast path.
 */
export function receiptToSave(result: Pick<Result, 'verdict' | 'receipt'>, options: { ci: boolean }): Receipt | null {
  if (options.ci || result.verdict !== 'verified') {
    return null;
  }
  return result.receipt;
}

// Zero where the platform has no such flag. The lstat check before the open covers that case.
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const RECEIPT_FILE_MODE = 0o600;

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * The real receipt file system, rooted at the repository root. Reads follow the plain path. Writes
 * never follow a link: the folder and the file are checked with lstat, a temp file in the same
 * folder is opened with O_NOFOLLOW and O_EXCL, and a rename puts it in place. A rename replaces
 * the name and never follows a link at the target.
 */
export function makeReceiptFs(root: string): ReceiptFs {
  return {
    readFile: async (path) => {
      try {
        return await readFile(resolve(root, path), 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;
        }
        throw err;
      }
    },
    mkdir: async (path) => {
      const absolute = resolve(root, path);
      const stats = await lstatOrNull(absolute);
      if (stats === null) {
        await mkdir(absolute, { recursive: true });
        return;
      }
      if (stats.isSymbolicLink()) {
        throw new ReceiptWriteRefused(path, 'is a symbolic link');
      }
      if (!stats.isDirectory()) {
        throw new ReceiptWriteRefused(path, 'is not a folder');
      }
    },
    writeFile: async (path, contents) => {
      const absolute = resolve(root, path);
      const folder = dirname(absolute);
      const folderName = dirname(path);
      const folderStats = await lstatOrNull(folder);
      if (folderStats?.isSymbolicLink() === true) {
        throw new ReceiptWriteRefused(folderName, 'is a symbolic link');
      }
      if (folderStats === null || !folderStats.isDirectory()) {
        throw new ReceiptWriteRefused(folderName, 'is not a folder');
      }
      const fileStats = await lstatOrNull(absolute);
      if (fileStats?.isSymbolicLink() === true) {
        throw new ReceiptWriteRefused(path, 'is a symbolic link');
      }
      if (fileStats !== null && !fileStats.isFile()) {
        throw new ReceiptWriteRefused(path, 'is not a regular file');
      }
      const tempPath = resolve(folder, `.${basename(absolute)}.${randomBytes(8).toString('hex')}.tmp`);
      let handle: FileHandle | null = null;
      try {
        handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, RECEIPT_FILE_MODE);
        await handle.writeFile(contents, { encoding: 'utf8' });
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(tempPath, absolute);
      } finally {
        if (handle !== null) {
          await handle.close().catch(() => undefined);
        }
        // After the rename the temp name is gone. After a failure it is a stray file.
        await unlink(tempPath).catch(() => undefined);
      }
    },
  };
}

export async function loadReceipt(fs: Pick<ReceiptFs, 'readFile'>): Promise<Receipt | null> {
  const raw = await fs.readFile(RECEIPT_PATH);
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isReceipt(parsed) ? parsed : null;
  } catch {
    // Corrupt local state returns null so the hook can disclose and continue instead of wedging.
    return null;
  }
}

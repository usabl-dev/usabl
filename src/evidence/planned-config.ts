/**
 * Whether a receipt binds the config bytes its check planned with.
 *
 * A check reads usabl.config.json once to plan. The run reads the file again when it binds the
 * local files into the receipt (see local-files.ts). A second process can swap the file between
 * the two reads: the check then plans from weak bytes and mints a receipt bound to the committed
 * bytes, and the next stop, which finds the committed bytes, answers from that receipt without a
 * scan. So a receipt is saved only when both hold:
 *
 * - the file at the root still holds the exact text the check planned with, and
 * - the receipt's local files hash is the hash of the planned bytes, with every other bound file
 *   read as it is now.
 *
 * The first gives the plain reason. The second closes the case where the file is swapped back to
 * the planned bytes just before the save. It reads files and compares hashes only. It must never
 * decide a verdict: it decides only whether a receipt is kept.
 */
import { createHash } from 'node:crypto';
import type { Deps, LocalFileRead, Receipt, UsablConfig } from '../contracts/index.js';
import { computeLocalFilesHash, UNREADABLE_LOCAL_FILES } from './local-files.js';

/** The config file a receipt binds, at the root. See local-files.ts. */
const CONFIG_FILE = 'usabl.config.json';

/**
 * `bound`: the receipt may be saved. `config-changed`: the file holds other text now.
 * `binding-changed`: the receipt binds files other than the planned config and the files as they
 * are now.
 */
export type ReceiptConfigCheck = 'bound' | 'config-changed' | 'binding-changed';

export interface ReceiptConfigCheckInput {
  // The deps the run bound the local files with, so the files are read from the same folder. Null
  // when that folder is not the repository root: the binding then reads another folder's files,
  // and the receipt is saved in that folder, where no stop reads it, so only the text is compared.
  deps: Deps | null;
  config: UsablConfig;
  receipt: Pick<Receipt, 'localFilesHash'>;
  // The text the check planned with, and the text of the root config read again just now, or null
  // when it could not be read.
  plannedText: string;
  currentText: string | null;
}

// The same deps, with the config file read as the planned bytes. The size cap is the reader's, so
// a planned file over it binds nothing that matches, as the real read would.
function withPlannedConfig(deps: Deps, plannedText: string): Deps | null {
  const read = deps.fs.readLocalFile?.bind(deps.fs);
  if (read === undefined) {
    return null;
  }
  const bytes = Buffer.from(plannedText, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    ...deps,
    fs: {
      ...deps.fs,
      readLocalFile: async (path: string, maxBytes: number): Promise<LocalFileRead> => {
        if (path !== CONFIG_FILE) {
          return read(path, maxBytes);
        }
        return bytes.byteLength > maxBytes ? { kind: 'other' } : { kind: 'file', sha256, size: bytes.byteLength };
      },
    },
  };
}

export async function receiptConfigCheck(input: ReceiptConfigCheckInput): Promise<ReceiptConfigCheck> {
  if (input.currentText !== input.plannedText) {
    return 'config-changed';
  }
  const minted = input.receipt.localFilesHash;
  // A receipt with no binding, or an unreadable one, never matches a stop (see localFilesMatch), so
  // saving it cannot answer one.
  if (input.deps === null || typeof minted !== 'string' || minted === UNREADABLE_LOCAL_FILES) {
    return 'bound';
  }
  const planned = withPlannedConfig(input.deps, input.plannedText);
  if (planned === null) {
    return 'binding-changed';
  }
  return (await computeLocalFilesHash(planned, input.config)) === minted ? 'bound' : 'binding-changed';
}

// What a check or a stop says when it saves no receipt for one of these reasons. Both end the same
// way: the verdict of the run is not changed, and the next stop checks again.
const NO_RECEIPT_TAIL = 'The verdict of this run stands. The next stop runs its own check.';

export function noReceiptMessage(check: Exclude<ReceiptConfigCheck, 'bound'>): string {
  return check === 'config-changed'
    ? 'saved no receipt for this run. usabl.config.json at the repository root changed while usabl was checking, ' +
        `so the receipt would bind other bytes than the ones this run planned with. ${NO_RECEIPT_TAIL}`
    : 'saved no receipt for this run. The files its receipt binds, usabl.config.json at the repository root and ' +
        'the local files, changed while usabl was checking, so the receipt would not stand for the config this run ' +
        `planned with. ${NO_RECEIPT_TAIL}`;
}

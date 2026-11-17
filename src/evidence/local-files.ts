/**
 * The receipt's binding for the files the app reads that git does not see.
 *
 * The tree id a receipt binds comes from git, which skips ignored files. So an edit to `.env.local`,
 * which Vite loads and the Vite templates ignore, changed neither the tree nor the status, and a
 * stored receipt kept answering the stop. This binding hashes, sorted by path:
 *
 * - every `.env*` file in the repository root and in each app folder (the folders that hold one of
 *   the app's package.json files, found the way dependency changes are: see appDirs),
 * - every path the config lists in `localFiles`,
 * - and usabl.config.json at the root, the file the Stop hook reads, byte for byte.
 *
 * Each entry is the path, its kind (missing, file, or other), and the sha256 of its bytes. Never
 * the bytes. A listed path that is missing is still an entry, so a file that appears changes the
 * hash. A path usabl cannot read as a file of the repository (a link, a folder, a path below a
 * link, a file it may not open) makes the whole binding unreadable, and an unreadable binding never
 * matches, on either side. "The root" is the folder usabl runs from: the repository root for the
 * Stop hook, and the current folder for usabl check.
 *
 * It reads files and returns a hash only. It must never decide a verdict.
 */
import type { Deps, LocalFileRead, UsablConfig } from '../contracts/index.js';
import { appDirs } from '../coverage/dependency-changes.js';
import { isBindableLocalFileList } from '../intake/local-files.js';
import { canonicalHash } from '../primitives/canonical.js';
import { sortBy } from '../primitives/sortKey.js';

/** The value a local files hash takes when a bound path could not be read. It never matches. */
export const UNREADABLE_LOCAL_FILES = 'unreadable';

/** The config file the Stop hook reads, at the root. Its bytes are bound. */
const CONFIG_FILE = 'usabl.config.json';

/** The most paths one binding reads. More than this binds nothing that can match. */
const MAX_BOUND_PATHS = 256;

// A folder name with glob meaning would be read by the glob as a pattern, so its `.env*` files could
// not be listed exactly.
const GLOB_CHARACTERS = /[*?[\]{}()!\\]/u;

/**
 * The hash of the local files this config binds, or UNREADABLE_LOCAL_FILES. It never throws: a read
 * that fails binds the unreadable value, so the receipt does not verify and the stop checks again.
 */
export async function computeLocalFilesHash(deps: Deps, config: UsablConfig): Promise<string> {
  const read = deps.fs.readLocalFile?.bind(deps.fs);
  if (read === undefined) {
    return UNREADABLE_LOCAL_FILES;
  }
  const listed: unknown = config.localFiles ?? [];
  if (!isBindableLocalFileList(listed)) {
    return UNREADABLE_LOCAL_FILES;
  }
  try {
    const folders = new Set<string>(['', ...(await appDirs(deps.fs, config, undefined))]);
    const paths = new Set<string>([CONFIG_FILE, ...listed]);
    for (const folder of sortBy([...folders], (name) => name)) {
      if (GLOB_CHARACTERS.test(folder)) {
        return UNREADABLE_LOCAL_FILES;
      }
      for (const path of await deps.fs.glob([folder === '' ? '.env*' : `${folder}/.env*`])) {
        paths.add(path);
      }
    }
    if (paths.size > MAX_BOUND_PATHS) {
      return UNREADABLE_LOCAL_FILES;
    }
    const entries: Array<{ path: string; kind: LocalFileRead['kind']; sha256: string | null }> = [];
    for (const path of sortBy([...paths], (name) => name)) {
      const found = await read(path);
      if (found.kind === 'other') {
        return UNREADABLE_LOCAL_FILES;
      }
      entries.push({ path, kind: found.kind, sha256: found.kind === 'file' ? found.sha256 : null });
    }
    return canonicalHash(entries);
  } catch {
    return UNREADABLE_LOCAL_FILES;
  }
}

/** Whether a receipt's local files hash stands for the files as they are now. */
export function localFilesMatch(minted: unknown, current: string): boolean {
  return typeof minted === 'string' && minted !== UNREADABLE_LOCAL_FILES && current !== UNREADABLE_LOCAL_FILES && minted === current;
}

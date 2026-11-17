/**
 * The receipt's binding for the files the app reads that git does not see.
 *
 * The tree id a receipt binds comes from git, which skips ignored files. So an edit to `.env.local`,
 * which Vite loads and the Vite templates ignore, changed neither the tree nor the status, and a
 * stored receipt kept answering the stop. This binding hashes, sorted by path:
 *
 * - every file in the repository root and in each app folder (the folders that hold one of the
 *   app's package.json files, found the way dependency changes are: see appDirs) whose name, in
 *   lower case, starts with `.env`, whatever its case on disk,
 * - every path the config lists in `localFiles`,
 * - and usabl.config.json at the root, the file the Stop hook reads, byte for byte.
 *
 * Each entry is the path, its kind (missing, file, or other), and the sha256 of its bytes. Never
 * the bytes. A listed path that is missing is still an entry, so a file that appears changes the
 * hash. A path usabl cannot read as a file of the repository (a link, a folder, a path below a
 * link, a file it may not open, a file over its size cap) makes the whole binding unreadable, and
 * an unreadable binding never matches, on either side. "The root" is the folder usabl runs from:
 * the repository root for the Stop hook, and the current folder for usabl check.
 *
 * It reads files and returns a hash only. It must never decide a verdict.
 */
import type { Deps, UsablConfig } from '../contracts/index.js';
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

const MIB = 1024 * 1024;

/**
 * The size caps. Every stop reads each bound file whole, on the fast path too, and a sparse file
 * of any size costs no disk to make, so a file with no cap could make every stop run past the
 * assistant's hook timeout. A file over its cap is never read: it binds nothing that matches, so
 * the stop runs the full check. A `.env` file holds a few settings, so 1 MiB is far more than one
 * needs. A listed file can be a generated bundle, so it gets 16 MiB, about a tenth of a second to
 * hash. The config file gets the same cap as a listed file. The total cap stops 256 files at the
 * per-file cap from being read: past 64 MiB in all, nothing more is read and the value is
 * unreadable.
 */
export const ENV_FILE_MAX_BYTES = MIB;
export const LISTED_FILE_MAX_BYTES = 16 * MIB;
export const TOTAL_MAX_BYTES = 64 * MIB;

// A folder name with glob meaning would be read by the glob as a pattern, so its files could not be
// listed exactly.
const GLOB_CHARACTERS = /[*?[\]{}()!\\]/u;

// The last part of a path.
function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * The `.env` files of one folder: every file whose name, in lower case, starts with `.env`. The
 * glob lists every dot file and the name test is made here, so it does not depend on the case rules
 * of the glob or of the file system. On a file system that ignores case, Vite opening `.env.local`
 * reads `.ENV.local`, and this binds it under its name on disk.
 */
async function envFilesIn(deps: Deps, folder: string): Promise<string[]> {
  const found = await deps.fs.glob([folder === '' ? '.*' : `${folder}/.*`]);
  return found.filter((path) => nameOf(path).toLowerCase().startsWith('.env'));
}

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
    // Each path with its cap. A path that is both a .env file and listed gets the larger cap.
    const caps = new Map<string, number>([[CONFIG_FILE, LISTED_FILE_MAX_BYTES]]);
    for (const path of listed) {
      caps.set(path, LISTED_FILE_MAX_BYTES);
    }
    for (const folder of sortBy([...folders], (name) => name)) {
      if (GLOB_CHARACTERS.test(folder)) {
        return UNREADABLE_LOCAL_FILES;
      }
      for (const path of await envFilesIn(deps, folder)) {
        if (!caps.has(path)) {
          caps.set(path, ENV_FILE_MAX_BYTES);
        }
      }
    }
    if (caps.size > MAX_BOUND_PATHS) {
      return UNREADABLE_LOCAL_FILES;
    }
    const entries: Array<{ path: string; kind: 'missing' | 'file'; sha256: string | null }> = [];
    let remaining = TOTAL_MAX_BYTES;
    for (const path of sortBy([...caps.keys()], (name) => name)) {
      // A file is read only when it fits both its own cap and what is left of the total.
      const found = await read(path, Math.min(caps.get(path)!, remaining));
      if (found.kind === 'other') {
        return UNREADABLE_LOCAL_FILES;
      }
      if (found.kind === 'file') {
        remaining -= found.size;
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

/**
 * The same deps with no local file reader, for a --ci run. CI has no ignored files to bind, and a
 * Result artifact is read by more people than the machine it ran on: a hash with no key of a short
 * secret in `.env` could be guessed offline. So such a run mints a receipt with no local files
 * hash, and a local stop never matches it.
 */
export function withoutLocalFileBinding(deps: Deps): Deps {
  const { readLocalFile: _read, ...fs } = deps.fs;
  return { ...deps, fs };
}

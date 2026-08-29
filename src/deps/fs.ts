/**
 * Real FsGlob adapter for file reads and glob expansion.
 * This unit reports filesystem state only and must never infer coverage outcomes.
 * Missing files return null so callers can disclose not-covered work without guessing.
 */
import { glob, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { FsGlob } from '../contracts/index.js';

function isMissingFile(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const code = Reflect.get(err, 'code');
  // ENOENT is a missing path. EISDIR is a directory read: a guarded-path prefix can
  // resolve to a directory, and reading it has no file bytes to disclose. Both fail
  // closed to null so the guard treats them as absent content, never a hard crash.
  return code === 'ENOENT' || code === 'EISDIR';
}

export function makeFsGlob(options: { cwd?: string } = {}): FsGlob {
  const cwd = options.cwd ?? process.cwd();

  return {
    async readFile(path) {
      try {
        return await readFile(resolve(cwd, path), 'utf8');
      } catch (err) {
        if (isMissingFile(err)) {
          return null;
        }
        throw err;
      }
    },
    async glob(patterns) {
      // Return files only. Node's `**` also matches directory nodes (including the
      // base directory itself), and every caller reads a globbed path as a file, so
      // a directory in the result would later crash a readFile with EISDIR. Filter
      // with Dirent file types and rebuild the cwd-relative path each match carries.
      const seen = new Set<string>();
      for (const pattern of patterns) {
        for await (const entry of glob(pattern, { cwd, withFileTypes: true })) {
          if (entry.isDirectory()) {
            continue;
          }
          seen.add(relative(cwd, resolve(entry.parentPath, entry.name)));
        }
      }
      return [...seen].sort();
    },
  };
}

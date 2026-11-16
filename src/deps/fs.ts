/**
 * Real FsGlob adapter for file reads and glob expansion.
 * This unit reports filesystem state only and must never infer coverage outcomes.
 * Missing files return null so callers can disclose not-covered work without guessing.
 */
import { constants } from 'node:fs';
import { glob, lstat, open, readFile, readlink } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { FsGlob } from '../contracts/index.js';

function asBytes(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function isMissingFile(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const code = Reflect.get(err, 'code');
  // ENOENT is a missing path. EISDIR is a directory read: a guarded-path prefix can
  // resolve to a directory, and reading it has no file bytes to disclose. Both fail
  // closed to null so the guard treats them as absent content, never a hard crash.
  // ENOTDIR is a read below a file, such as src/App.tsx/package.json. A file holds no files, so
  // that path cannot exist: it is a missing file, the same as ENOENT. git show reads such a path
  // at a ref as missing too, so the tree and the trusted side agree.
  return code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR';
}

/**
 * A reader for one workflow file, where a folder at the path is not the same as nothing there. It
 * returns null only when the path does not exist (ENOENT, or ENOTDIR for a path below a file). Any
 * other failure, such as EISDIR for a folder or EACCES for no permission, is thrown, so the caller
 * can say the file could not be read instead of calling it missing.
 */
export function makeWorkflowReader(cwd: string = process.cwd()): (path: string) => Promise<string | null> {
  return async (path) => {
    try {
      return await readFile(resolve(cwd, path), 'utf8');
    } catch (err) {
      const code = typeof err === 'object' && err !== null ? Reflect.get(err, 'code') : undefined;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw err;
    }
  };
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
    async readBytes(path) {
      try {
        // git stores no file below a symbolic link: it reads the link itself as the entry. A
        // folder above the path that is a link, or anything that is not a folder, means no file.
        const segments = path.split('/').filter((segment) => segment.length > 0);
        for (let i = 1; i < segments.length; i += 1) {
          const above = await lstat(resolve(cwd, segments.slice(0, i).join('/')));
          if (!above.isDirectory()) {
            return null;
          }
        }
        const full = resolve(cwd, path);
        const stat = await lstat(full);
        if (stat.isSymbolicLink()) {
          // The link text, as git stores it, never what the link points at.
          const target = await readlink(full, { encoding: 'buffer' });
          return { kind: 'symlink', target: asBytes(target) };
        }
        if (!stat.isFile()) {
          return null;
        }
        // The file is opened without following a link and read through that one handle, so a link
        // put in its place after the check above is refused, never followed. O_NONBLOCK keeps a
        // pipe put there from holding the read open.
        const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const opened = await handle.stat();
          if (!opened.isFile()) {
            return null;
          }
          // git records a regular file as 100755 when its owner may run it, and 100644 otherwise.
          const mode = (opened.mode & 0o100) !== 0 ? '100755' : '100644';
          return { kind: 'file', mode, bytes: asBytes(await handle.readFile()) };
        } finally {
          await handle.close();
        }
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

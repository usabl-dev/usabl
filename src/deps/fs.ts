/**
 * Real FsGlob adapter for file reads and glob expansion.
 * This unit reports filesystem state only and must never infer coverage outcomes.
 * Missing files return null so callers can disclose not-covered work without guessing.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { glob, lstat, open, readFile, readlink } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import type { FsGlob } from '../contracts/index.js';
import { nodeGlobIgnoresCase, nodeGlobReading } from './fs-glob-reading.js';

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
  // that path cannot exist: it is a missing file, the same as ENOENT. The trusted read, git
  // cat-file blob, reads such a path at a ref as missing too, so the tree and the trusted side agree.
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

export function makeFsGlob(options: { cwd?: string; platform?: NodeJS.Platform } = {}): FsGlob {
  const cwd = options.cwd ?? process.cwd();
  // Node's fs.glob matches without regard to letter case on macOS and Windows. The platform is
  // injected in tests, so the rule is tested on any machine.
  const platform = options.platform ?? process.platform;
  const nocase = nodeGlobIgnoresCase(platform);

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
        // A folder above swapped for a link after this check is followed, because O_NOFOLLOW below
        // covers only the last part of the path. The bytes read then are the bytes every consumer
        // of the path reads.
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
        if (stat.isDirectory()) {
          return { kind: 'folder' };
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
    async readLocalFile(path, maxBytes) {
      try {
        // A file above the path holds nothing, so nothing is there. A link above, or anything else
        // that is not a folder, could lead out of the repository, so usabl does not read through it.
        const segments = path.split('/').filter((segment) => segment.length > 0);
        for (let i = 1; i < segments.length; i += 1) {
          const above = await lstat(resolve(cwd, segments.slice(0, i).join('/')));
          if (above.isDirectory()) {
            continue;
          }
          return above.isFile() ? { kind: 'missing' } : { kind: 'other' };
        }
        const full = resolve(cwd, path);
        // A link is never followed, wherever it points: it is not read as a file of the repository.
        if (!(await lstat(full)).isFile()) {
          return { kind: 'other' };
        }
        // Opened without following a link, so a link put in place after the check is refused.
        // O_NONBLOCK keeps a pipe put there from holding the read open. The bytes go only into the
        // hash, in fixed-size pieces, so a large file is never held in memory whole.
        const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const opened = await handle.stat();
          if (!opened.isFile()) {
            return { kind: 'other' };
          }
          // The size is checked before any byte is read. A sparse file uses no disk, so a file of any
          // size costs nothing to make, and hashing it would make every stop slow enough to time out.
          if (opened.size > maxBytes) {
            return { kind: 'other' };
          }
          const hash = createHash('sha256');
          const piece = Buffer.alloc(64 * 1024);
          let total = 0;
          for (;;) {
            const { bytesRead } = await handle.read(piece, 0, piece.length, null);
            if (bytesRead === 0) {
              break;
            }
            total += bytesRead;
            // A file that grows while it is read, or that says a smaller size than it gives, is
            // not read to its end.
            if (total > opened.size) {
              return { kind: 'other' };
            }
            hash.update(piece.subarray(0, bytesRead));
          }
          return { kind: 'file', sha256: hash.digest('hex'), size: total };
        } finally {
          await handle.close();
        }
      } catch (err) {
        const code = typeof err === 'object' && err !== null ? Reflect.get(err, 'code') : undefined;
        // Any other failure, such as no permission or a link swapped in, is something usabl could
        // not read, never nothing there.
        return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'missing' } : { kind: 'other' };
      }
    },
    async readTextUpTo(path, maxBytes) {
      let handle;
      try {
        // O_NONBLOCK keeps a pipe at the path from holding the read open.
        handle = await open(resolve(cwd, path), constants.O_RDONLY | constants.O_NONBLOCK);
      } catch (err) {
        if (isMissingFile(err)) {
          return null;
        }
        throw err;
      }
      try {
        const opened = await handle.stat();
        if (opened.isDirectory()) {
          return null;
        }
        // The size is checked before any byte is read, so a huge file, or a sparse one that costs
        // nothing to make, is never read.
        if (opened.isFile() && opened.size > maxBytes) {
          return { kind: 'too-large' };
        }
        // Read in pieces and stopped one byte past the limit, so a file that grows while it is
        // read, or anything that is not a regular file, is never held whole either.
        const piece = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1));
        const pieces: Buffer[] = [];
        let total = 0;
        for (;;) {
          const { bytesRead } = await handle.read(piece, 0, piece.length, null);
          if (bytesRead === 0) {
            break;
          }
          total += bytesRead;
          if (total > maxBytes) {
            return { kind: 'too-large' };
          }
          pieces.push(Buffer.from(piece.subarray(0, bytesRead)));
        }
        return { kind: 'text', text: Buffer.concat(pieces).toString('utf8') };
      } finally {
        await handle.close();
      }
    },
    async globUnder(folder, patterns) {
      // The folder is the walk's starting folder, so Node never parses its name. A folder that is
      // missing lists nothing.
      const under = folder.replace(/\/+$/u, '');
      const found = await makeFsGlob({ cwd: resolve(cwd, under), platform }).glob(patterns);
      return under === '' ? found : found.map((path) => `${under}/${path.split(sep).join('/')}`).sort();
    },
    async glob(patterns) {
      // Return files only. Node's `**` also matches directory nodes (including the
      // base directory itself), and every caller reads a globbed path as a file, so
      // a directory in the result would later crash a readFile with EISDIR. Filter
      // with Dirent file types and rebuild the cwd-relative path each match carries.
      //
      // Node tests a part that holds wildcards with a regular expression that can backtrack, so
      // a pattern is listed wide and filtered here with a matcher that does not (see
      // fs-glob-reading.ts). Syntax that matcher does not read runs unchanged inside a bound,
      // and not at all past it.
      const seen = new Set<string>();
      for (const pattern of patterns) {
        const reading = nodeGlobReading(pattern, { nocase, windows: platform === 'win32' });
        if (reading.kind === 'past-bound') {
          continue;
        }
        const listings =
          reading.kind === 'unchanged' ? [{ patterns: [pattern], base: '', matches: null }] : reading.listings;
        for (const listing of listings) {
          const base = resolve(cwd, listing.base);
          for await (const entry of glob(listing.patterns, { cwd, withFileTypes: true })) {
            if (entry.isDirectory()) {
              continue;
            }
            const found = resolve(entry.parentPath, entry.name);
            if (listing.matches !== null && !listing.matches(relative(base, found).split(sep).join('/'))) {
              continue;
            }
            seen.add(relative(cwd, found));
          }
        }
      }
      return [...seen].sort();
    },
  };
}

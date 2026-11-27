/**
 * Reads a file only when it is a regular file, and never waits on one that is not.
 *
 * A plain read of a named pipe waits until something writes to it, which may be never. The read
 * holds one thread of Node's shared thread pool while it waits, and a process with such a read
 * pending cannot exit: on exit Node waits for every thread, so the Stop hook would outlast the
 * host's limit after it answered. A device can also give bytes with no end. So each read here
 * checks what the path is first, opens it with O_NONBLOCK, and checks the opened file again,
 * so a pipe put in its place between the two checks is refused too, without waiting. A path that
 * is not a regular file is refused with NotRegularFileError, never read as an empty file.
 *
 * Links are followed, as a plain read follows them. A folder fails with EISDIR, as a plain read
 * of a folder does, so callers that read a folder as no file still do.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync, statSync, type Stats } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';

// O_NONBLOCK keeps a pipe from holding the open. O_NOCTTY keeps a terminal from becoming the
// process's own. Both are zero where the platform has no such flag.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0);

/** The code of the error a read refused for a path that is not a regular file. */
export const NOT_REGULAR_FILE = 'EUSABLNOTREGULAR';

/**
 * Where a reader writes down each path it refused, so the Stop hook can block on it. The names
 * are the ones the reader was asked for, such as a path from the repository root.
 */
export type ReadRefusals = Set<string>;

export class NotRegularFileError extends Error {
  readonly code = NOT_REGULAR_FILE;

  constructor(readonly path: string) {
    super(`usabl did not read ${path}, because it is not a regular file (it may be a pipe, a device, or a socket)`);
    this.name = 'NotRegularFileError';
  }
}

export function isNotRegularFile(err: unknown): err is NotRegularFileError {
  return typeof err === 'object' && err !== null && Reflect.get(err, 'code') === NOT_REGULAR_FILE;
}

export interface RegularReadOptions {
  // The name to report and record in place of the full path.
  name?: string;
  refusals?: ReadRefusals;
}

function folderError(path: string): Error {
  return Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${path}'`), { code: 'EISDIR', path });
}

// Throws for anything but a regular file, after it records the refusal.
function checkKind(stats: Stats, path: string, options: RegularReadOptions): void {
  if (stats.isFile()) return;
  if (stats.isDirectory()) throw folderError(path);
  const name = options.name ?? path;
  options.refusals?.add(name);
  throw new NotRegularFileError(name);
}

function openRefusal(err: unknown, path: string, options: RegularReadOptions): unknown {
  // A socket cannot be opened at all (ENXIO). It is refused like any other path that is not a file.
  if (typeof err === 'object' && err !== null && Reflect.get(err, 'code') === 'ENXIO') {
    const name = options.name ?? path;
    options.refusals?.add(name);
    return new NotRegularFileError(name);
  }
  return err;
}

/**
 * A handle on a regular file, checked before and after the open. The caller closes it. Missing
 * paths fail with ENOENT, as a plain open does.
 */
export async function openRegularFile(path: string | Buffer, options: RegularReadOptions = {}): Promise<FileHandle> {
  const shown = String(path);
  checkKind(await stat(path), shown, options);
  let handle: FileHandle;
  try {
    handle = await open(path, OPEN_FLAGS);
  } catch (err) {
    throw openRefusal(err, shown, options);
  }
  try {
    checkKind(await handle.stat(), shown, options);
  } catch (err) {
    await handle.close();
    throw err;
  }
  return handle;
}

/** The bytes of a regular file. Missing paths fail with ENOENT, as a plain read does. */
export async function readRegularFile(path: string, options: RegularReadOptions = {}): Promise<Buffer> {
  const handle = await openRegularFile(path, options);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** The text of a regular file, decoded as UTF-8. */
export async function readRegularText(path: string, options: RegularReadOptions = {}): Promise<string> {
  return (await readRegularFile(path, options)).toString('utf8');
}

/** readRegularFile for code that reads in one step. */
export function readRegularFileSync(path: string | Buffer, options: RegularReadOptions = {}): Buffer {
  const shown = String(path);
  checkKind(statSync(path), shown, options);
  let fd: number;
  try {
    fd = openSync(path, OPEN_FLAGS);
  } catch (err) {
    throw openRefusal(err, shown, options);
  }
  try {
    checkKind(fstatSync(fd), shown, options);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
